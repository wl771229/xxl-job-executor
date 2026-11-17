/**
 * XXL-JOB 2.4.x 执行器协议服务。
 *
 * 在独立端口实现执行器侧 HTTP 协议，不依赖 Express、不访问业务数据库。
 * 支持多任务处理器、在线日志、取消信号、执行超时和可选的自动注册。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { parseConfig } from './config.js'
import { createLogStore } from './log-store.js'
import { createRegistry } from './registry.js'

const MAX_BODY_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const CALLBACK_TIMEOUT_MS = 10_000

function tokenMatches(present, expected) {
  if (typeof present !== 'string' || present === '') return false
  // 先哈希再恒时比较，保证 timingSafeEqual 两侧长度一致。
  const given = createHash('sha256').update(present).digest()
  const configured = createHash('sha256').update(expected).digest()
  return timingSafeEqual(given, configured)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('JSON 无效')) }
    })
    req.on('error', reject)
  })
}

/**
 * 创建 XXL-JOB 执行器。
 *
 * 任务处理器收到完整触发上下文，返回 `{ handleCode, handleMsg }`，也可以抛出
 * 异常表示失败。处理器应监听 `signal` 以响应 kill、超时和执行器停止。
 *
 * @param {object} options
 * @param {object} options.config 执行器配置（见 parseConfig）
 * @param {Record<string, Function>} options.handlers 任务名到处理函数的映射
 * @param {{info: Function, warn: Function}} [options.logger]
 * @param {Function} [options.fetchImpl=fetch] 回调与注册请求实现，测试时可注入
 * @returns {{start: () => Promise<{host: string, port: number}>, stop: () => Promise<void>}}
 */
export function createXxlJobExecutor({ config, handlers, logger = { warn() {}, info() {} }, fetchImpl = fetch }) {
  const resolved = parseConfig(config)
  const handlerMap = new Map(Object.entries(handlers ?? {}))
  if (handlerMap.size === 0) throw new TypeError('handlers 至少需要一个任务处理器')
  for (const [name, handler] of handlerMap) {
    if (typeof name !== 'string' || name === '' || typeof handler !== 'function') {
      throw new TypeError('handlers 必须将任务名映射到函数')
    }
  }

  const logStore = createLogStore()
  const registry = createRegistry({ config: resolved, fetchImpl, logger })
  const executions = new Map()
  const byJob = new Map()
  const tracked = new Set()
  let stopping = false
  let started = false
  let startPromise = null
  let stopPromise = null
  const server = createServer((request, response) => { void handle(request, response) })
  // 执行器只接收调度中心的小请求，给请求接收和 header 读取设置上限，避免慢连接长期占用。
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = REQUEST_TIMEOUT_MS
  server.keepAliveTimeout = 5_000

  function log(level, fields, message) {
    try {
      logger[level](fields, message)
    } catch {
      // 日志实现异常不影响协议响应和任务回调。
    }
  }

  function respond(response, payload) {
    if (response.writableEnded || response.destroyed) return
    try {
      response.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' })
      response.end(JSON.stringify(payload))
    } catch {
      // 客户端在应答前断开时忽略写入失败。
    }
  }

  async function handle(request, response) {
    try {
      if (request.method !== 'POST') return respond(response, { code: 500, msg: '请求无效' })
      if (!tokenMatches(request.headers['xxl-job-access-token'], resolved.accessToken)) {
        return respond(response, { code: 500, msg: '访问令牌无效' })
      }
      const { pathname } = new URL(request.url, 'http://localhost')
      const body = await readJsonBody(request)
      respond(response, route(pathname, body))
    } catch {
      // 丢弃剩余字节，并统一按协议失败形状应答。
      request.resume()
      respond(response, { code: 500, msg: '请求无效' })
    }
  }

  function route(pathname, body) {
    switch (pathname) {
      case '/beat': return { code: 200, msg: null }
      case '/idleBeat': {
        if (!Number.isSafeInteger(body?.jobId)) return { code: 500, msg: '任务 ID 无效' }
        return byJob.has(body.jobId) ? { code: 500, msg: '任务执行中' } : { code: 200, msg: null }
      }
      case '/kill': return kill(body)
      case '/log': return readLog(body)
      case '/run': return acceptRun(body)
      default: return { code: 500, msg: '请求无效' }
    }
  }

  function kill(body) {
    const jobId = body?.jobId
    if (!Number.isSafeInteger(jobId)) return { code: 500, msg: '任务 ID 无效' }
    const logIds = byJob.get(jobId)
    if (logIds) {
      for (const logId of logIds) {
        const execution = executions.get(logId)
        if (!execution) continue
        logStore.append(logId, 'WARN', '收到 kill 请求，已发出取消信号')
        execution.controller.abort()
      }
    }
    log('warn', { event: 'xxl-kill-best-effort', jobId }, 'XXL 的 kill 为尽力而为，任务处理器需自行响应取消信号')
    return { code: 200, msg: null }
  }

  function readLog(body) {
    const logId = body?.logId
    const fromLineNum = body?.fromLineNum === undefined ? 0 : body.fromLineNum
    if (!Number.isSafeInteger(logId) || !Number.isSafeInteger(fromLineNum) || fromLineNum < 0) {
      return { code: 500, msg: '日志参数无效' }
    }
    return { code: 200, msg: null, content: logStore.read(logId, fromLineNum) }
  }

  function acceptRun(body) {
    const jobId = body?.jobId
    const handlerName = body?.executorHandler
    const logId = body?.logId
    if (!Number.isSafeInteger(jobId) || jobId < 0 || typeof handlerName !== 'string' || handlerName === '' ||
      handlerName.length > 128 || !Number.isSafeInteger(logId) || logId < 0) {
      return { code: 500, msg: '触发参数无效' }
    }
    if (body.glueType !== undefined && body.glueType !== 'BEAN') {
      return { code: 500, msg: '仅支持 BEAN 任务' }
    }
    if (body.logDateTime !== undefined && !Number.isSafeInteger(body.logDateTime)) {
      return { code: 500, msg: '触发参数无效' }
    }
    if (body.executorParams !== undefined && typeof body.executorParams !== 'string') {
      return { code: 500, msg: '触发参数无效' }
    }
    if (body.executorBlockStrategy !== undefined && typeof body.executorBlockStrategy !== 'string') {
      return { code: 500, msg: '触发参数无效' }
    }
    if (body.executorTimeout !== undefined &&
      (!Number.isSafeInteger(body.executorTimeout) || body.executorTimeout < 0 || body.executorTimeout > 86_400)) {
      return { code: 500, msg: '触发参数无效' }
    }
    if (body.broadcastIndex !== undefined &&
      (!Number.isSafeInteger(body.broadcastIndex) || body.broadcastIndex < 0)) {
      return { code: 500, msg: '触发参数无效' }
    }
    if (body.broadcastTotal !== undefined &&
      (!Number.isSafeInteger(body.broadcastTotal) || body.broadcastTotal < 1)) {
      return { code: 500, msg: '触发参数无效' }
    }
    if (stopping) return { code: 500, msg: '执行器正在停止' }
    const handler = handlerMap.get(handlerName)
    if (!handler) return { code: 500, msg: '任务处理器不存在' }

    const logDateTime = body.logDateTime ?? 0
    const timeoutSeconds = body.executorTimeout ?? 0
    const broadcastIndex = body.broadcastIndex ?? 0
    const broadcastTotal = body.broadcastTotal ?? 1
    const params = body.executorParams ?? ''
    const blockStrategy = body.executorBlockStrategy ?? ''

    const controller = new AbortController()
    const execution = {
      jobId,
      logId,
      logDateTime,
      controller,
      timedOut: false,
      timeoutMs: timeoutSeconds * 1000
    }

    logStore.create(logId)
    logStore.append(logId, 'INFO', `任务开始：jobId=${jobId}，处理器=${handlerName}`)
    addExecution(execution)

    const context = {
      jobId,
      logId,
      logDateTime,
      params,
      blockStrategy,
      timeoutSeconds,
      broadcastIndex,
      broadcastTotal,
      glueType: 'BEAN',
      signal: controller.signal,
      log: createJobLogger(logId)
    }

    let pending
    try {
      pending = Promise.resolve(handler(context))
    } catch (error) {
      // 处理器同步抛错属于本次执行失败，而不是拒绝触发。
      pending = Promise.reject(error)
    }
    track(execution, pending)
    return { code: 200, msg: null }
  }

  function addExecution(execution) {
    executions.set(execution.logId, execution)
    let logIds = byJob.get(execution.jobId)
    if (!logIds) {
      logIds = new Set()
      byJob.set(execution.jobId, logIds)
    }
    logIds.add(execution.logId)
  }

  function removeExecution(execution) {
    executions.delete(execution.logId)
    const logIds = byJob.get(execution.jobId)
    if (!logIds) return
    logIds.delete(execution.logId)
    if (logIds.size === 0) byJob.delete(execution.jobId)
  }

  function createJobLogger(logId) {
    const write = level => message => {
      logStore.append(logId, level, message === undefined ? '' : String(message))
    }
    return Object.freeze({
      debug: write('DEBUG'),
      info: write('INFO'),
      warn: write('WARN'),
      error: write('ERROR')
    })
  }

  async function raceWithTimeout(pending, execution) {
    const guarded = Promise.resolve(pending).then(
      value => ({ type: 'result', value }),
      error => ({ type: 'error', error })
    )
    if (execution.timeoutMs <= 0) return guarded

    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        execution.timedOut = true
        execution.controller.abort()
        resolve({ type: 'timeout' })
      }, execution.timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([guarded, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  function track(execution, pending) {
    const { logId, jobId, logDateTime, controller } = execution
    const run = (async () => {
      let handleCode = 200
      let handleMsg = ''
      const outcome = await raceWithTimeout(pending, execution)

      if (outcome.type === 'timeout') {
        handleCode = 500
        handleMsg = '任务执行超时'
      } else if (outcome.type === 'error') {
        handleCode = 500
        handleMsg = controller.signal.aborted && !execution.timedOut ? '任务已取消' : '任务执行失败'
        // 只记录错误码，不把处理器错误原文写入日志或回调，避免泄露敏感信息。
        if (!controller.signal.aborted) {
          log('warn', { event: 'xxl-handler-failed', jobId, logId, errorCode: outcome.error?.code }, '任务处理器抛出异常')
        }
      } else {
        const result = outcome.value
        handleCode = result?.handleCode === 500 ? 500 : 200
        handleMsg = typeof result?.handleMsg === 'string' ? result.handleMsg : ''
      }

      logStore.append(
        logId,
        handleCode === 200 ? 'INFO' : 'ERROR',
        `任务结束：code=${handleCode}${handleMsg ? `，${handleMsg}` : ''}`
      )
      log('info', { event: 'xxl-run-finished', jobId, logId, handleCode }, 'XXL 触发执行完成')
      try {
        await sendCallback({ logId, logDateTime, handleCode, handleMsg })
      } finally {
        logStore.finish(logId)
        removeExecution(execution)
      }
    })()

    tracked.add(run)
    void run.finally(() => { tracked.delete(run) }).catch(() => {})
  }

  async function sendCallback({ logId, logDateTime, handleCode, handleMsg }) {
    try {
      // logDateTim 是上游 2.4.x 的原生字段拼写，保持原样以便反序列化。
      const response = await fetchImpl(`${resolved.adminBaseUrl}/api/callback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'xxl-job-access-token': resolved.accessToken
        },
        body: JSON.stringify([{ logId, logDateTim: logDateTime, handleCode, handleMsg }]),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
      })
      let envelope = null
      try { envelope = JSON.parse(await response.text()) } catch { envelope = null }
      if (!envelope || envelope.code !== 200) throw new Error('回调被拒绝')
    } catch {
      // 单次发送不重试：调度中心会把本次执行标记为失败，业务结果不受影响。
      log('warn', { event: 'xxl-callback-failed', logId, handleCode }, '回调 XXL 调度中心失败')
    }
  }

  async function start() {
    if (started) throw new Error('执行器已启动')
    if (stopping) throw new Error('执行器已停止')
    started = true
    let actualPort = 0
    startPromise = new Promise((resolve, reject) => {
      const onError = error => {
        server.off('error', onError)
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        // 在 listening 回调里取实际端口，避免与并发 stop 关闭端口产生竞态。
        actualPort = server.address().port
        server.off('error', onError)
        server.off('listening', onListening)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(resolved.port, resolved.host)
    })
    try {
      await startPromise
    } catch (error) {
      started = false
      throw error
    }
    if (!stopping) {
      try {
        registry.start()
      } catch {
        log('warn', { event: 'xxl-registry-failed' }, 'XXL 自动注册启动失败')
      }
    }
    return { host: resolved.host, port: actualPort }
  }

  function stop() {
    stopping = true
    if (!stopPromise) {
      stopPromise = (async () => {
        // 如果 stop 与 start 并发，先等 listen 落定再关闭端口。
        if (startPromise) {
          try { await startPromise } catch { /* 启动已经失败 */ }
        }
        await registry.stop()
        for (const execution of executions.values()) {
          logStore.append(execution.logId, 'WARN', '执行器停止，已发出取消信号')
          execution.controller.abort()
        }
        if (server.listening) {
          await new Promise(resolve => {
            server.close(() => resolve())
            server.closeIdleConnections?.()
          })
        }
        await Promise.all([...tracked])
        logStore.dispose()
      })()
    }
    return stopPromise
  }

  return Object.freeze({ start, stop })
}
