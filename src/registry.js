/**
 * 调度中心执行器注册器。
 *
 * 启用自动注册后，启动时立即向 Admin 注册，并按固定间隔续约；停止时发送
 * 一次注销请求。注册失败只记录警告，下个周期重试。所有请求串行执行，避免
 * 注销请求被在途的注册请求挡住。
 */

const REGISTRY_PATH = '/api/registry'
const REGISTRY_REMOVE_PATH = '/api/registryRemove'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * 创建注册器。
 *
 * @param {object} options
 * @param {object} options.config 已校验配置（adminBaseUrl/accessToken/appName/executorAddress/registerIntervalMs/autoRegister）
 * @param {Function} [options.fetchImpl=fetch] 请求实现，测试时可注入
 * @param {{warn: Function}} [options.logger] 结构化日志门面
 * @returns {{start: Function, stop: Function}}
 */
export function createRegistry({ config, fetchImpl = fetch, logger = { warn() {} } }) {
  let timer = null
  let started = false
  let stopPromise = null
  let chain = Promise.resolve()

  async function send(path) {
    try {
      const response = await fetchImpl(`${config.adminBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'xxl-job-access-token': config.accessToken
        },
        body: JSON.stringify({
          registryGroup: 'EXECUTOR',
          registryKey: config.appName,
          registryValue: config.executorAddress
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      let envelope = null
      try { envelope = JSON.parse(await response.text()) } catch { envelope = null }
      if (!envelope || envelope.code !== 200) throw new Error('注册被拒绝')
    } catch {
      try {
        logger.warn({ event: 'xxl-registry-failed', path }, '向 XXL 调度中心注册失败')
      } catch {
        // 日志实现异常不影响注册流程。
      }
    }
  }

  function request(path) {
    chain = chain.then(() => send(path))
    return chain
  }

  function start() {
    if (!config.autoRegister || started || stopPromise) return
    started = true
    void request(REGISTRY_PATH)
    timer = setInterval(() => { void request(REGISTRY_PATH) }, config.registerIntervalMs)
    timer.unref?.()
  }

  function stop() {
    if (!stopPromise) {
      stopPromise = (async () => {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        if (config.autoRegister && started) await request(REGISTRY_REMOVE_PATH)
      })()
    }
    return stopPromise
  }

  return { start, stop }
}
