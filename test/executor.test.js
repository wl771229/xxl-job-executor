import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { afterEach, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { parseConfig } from '../src/config.js'
import { createXxlJobExecutor } from '../src/executor.js'
import { makeLogger, send, waitFor } from './helpers.js'

const TOKEN = 'test-access-token-123'
const CONFIG = {
  adminBaseUrl: 'http://127.0.0.1:8080/xxl-job-admin',
  accessToken: TOKEN,
  host: '127.0.0.1',
  port: 0
}
const AUTH = { 'xxl-job-access-token': TOKEN, 'content-type': 'application/json' }

const running = []

function callbackFetch() {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { text: async () => JSON.stringify({ code: 200, msg: null }) }
  }
  return { calls, fetchImpl }
}

async function startExecutor({ config, handlers, fetchImpl, logger } = {}) {
  const made = logger ? { logger, entries: [] } : makeLogger()
  const transport = fetchImpl ? { fetchImpl, calls: [] } : callbackFetch()
  const executor = createXxlJobExecutor({
    config: config ?? CONFIG,
    handlers: handlers ?? { tokenRefreshHandler: async () => ({ handleCode: 200, handleMsg: 'ok' }) },
    logger: made.logger,
    fetchImpl: transport.fetchImpl
  })
  const address = await executor.start()
  running.push(executor)
  return { executor, address, calls: transport.calls, entries: made.entries }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function runBody(overrides = {}) {
  return JSON.stringify({
    jobId: 7,
    executorHandler: 'tokenRefreshHandler',
    executorParams: '',
    logId: 77,
    logDateTime: 1750000000000,
    executorBlockStrategy: 'DISCARD_LATER',
    executorTimeout: 0,
    broadcastIndex: 0,
    broadcastTotal: 1,
    glueType: 'BEAN',
    ...overrides
  })
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(executor => executor.stop()))
})

describe('xxl-job executor', () => {
  test('rejects requests without the configured access token', async () => {
    const { address } = await startExecutor()
    const wrong = await send(address.port, { path: '/beat', headers: { 'xxl-job-access-token': 'wrong-token-xxx' } })
    const missing = await send(address.port, { path: '/beat', headers: {} })
    assert.equal(wrong.body.code, 500)
    assert.equal(missing.body.code, 500)
  })

  test('answers beat, kill and log with ReturnT envelopes', async () => {
    const { address } = await startExecutor()
    assert.equal((await send(address.port, { path: '/beat', headers: AUTH })).body.code, 200)

    const log = await send(address.port, {
      path: '/log',
      headers: AUTH,
      body: JSON.stringify({ logId: 1, logDateTime: 2, fromLineNum: 0 })
    })
    assert.equal(log.body.code, 200)
    assert.equal(log.body.content.isEnd, true)

    const kill = await send(address.port, { path: '/kill', headers: AUTH, body: JSON.stringify({ jobId: 1 }) })
    assert.equal(kill.body.code, 200)
  })

  test('rejects non-POST requests and unknown paths', async () => {
    const { address } = await startExecutor()
    const get = await send(address.port, { path: '/beat', method: 'GET', headers: AUTH })
    const unknown = await send(address.port, { path: '/nope', headers: AUTH })
    assert.equal(get.body.code, 500)
    assert.equal(unknown.body.code, 500)
  })

  test('dispatches a run with the full trigger context and callbacks the admin', async () => {
    let received
    const handlers = {
      tokenRefreshHandler: async context => {
        received = context
        return { handleCode: 200, handleMsg: 'ok' }
      }
    }
    const { address, calls } = await startExecutor({ handlers })

    const response = await send(address.port, { path: '/run', headers: AUTH, body: runBody() })
    assert.equal(response.body.code, 200)

    assert.equal(received.jobId, 7)
    assert.equal(received.logId, 77)
    assert.equal(received.logDateTime, 1750000000000)
    assert.equal(received.params, '')
    assert.equal(received.blockStrategy, 'DISCARD_LATER')
    assert.equal(received.timeoutSeconds, 0)
    assert.equal(received.broadcastIndex, 0)
    assert.equal(received.broadcastTotal, 1)
    assert.equal(received.glueType, 'BEAN')
    assert.ok(received.signal instanceof AbortSignal)
    assert.equal(typeof received.log.info, 'function')

    await waitFor(() => assert.equal(calls.length, 1))
    assert.equal(calls[0].url, 'http://127.0.0.1:8080/xxl-job-admin/api/callback')
    assert.equal(calls[0].options.headers['xxl-job-access-token'], TOKEN)
    assert.deepEqual(JSON.parse(calls[0].options.body), [
      { logId: 77, logDateTim: 1750000000000, handleCode: 200, handleMsg: 'ok' }
    ])
  })

  test('passes executor params and broadcast fields to the handler', async () => {
    let received
    const handlers = {
      tokenRefreshHandler: async context => {
        received = context
        return { handleCode: 200, handleMsg: 'ok' }
      }
    }
    const { address } = await startExecutor({ handlers })

    await send(address.port, {
      path: '/run',
      headers: AUTH,
      body: runBody({
        executorParams: 'a=1&b=2',
        executorTimeout: 5,
        broadcastIndex: 1,
        broadcastTotal: 2,
        executorBlockStrategy: 'SERIAL_EXECUTION'
      })
    })

    assert.equal(received.params, 'a=1&b=2')
    assert.equal(received.timeoutSeconds, 5)
    assert.equal(received.broadcastIndex, 1)
    assert.equal(received.broadcastTotal, 2)
    assert.equal(received.blockStrategy, 'SERIAL_EXECUTION')
  })

  test('dispatches multiple handlers with their own results', async () => {
    const received = []
    const handlers = {
      firstHandler: async context => {
        received.push(context)
        return { handleCode: 200, handleMsg: `first:${context.jobId}` }
      },
      secondHandler: async context => {
        received.push(context)
        return { handleCode: 500, handleMsg: `second:${context.params}` }
      }
    }
    const { address, calls } = await startExecutor({ handlers })

    await send(address.port, {
      path: '/run',
      headers: AUTH,
      body: runBody({ jobId: 1, logId: 10, executorHandler: 'firstHandler', executorParams: 'a=1' })
    })
    await send(address.port, {
      path: '/run',
      headers: AUTH,
      body: runBody({ jobId: 2, logId: 20, executorHandler: 'secondHandler', executorParams: 'b=2' })
    })

    await waitFor(() => assert.equal(calls.length, 2))
    assert.deepEqual(received.sort((left, right) => left.jobId - right.jobId).map(context => ({
      jobId: context.jobId,
      logId: context.logId,
      params: context.params
    })), [
      { jobId: 1, logId: 10, params: 'a=1' },
      { jobId: 2, logId: 20, params: 'b=2' }
    ])
    const messages = calls.map(call => JSON.parse(call.options.body)[0].handleMsg).sort()
    assert.deepEqual(messages, ['first:1', 'second:b=2'])
  })

  test('rejects an unknown handler at accept time without calling back', async () => {
    const { address, calls } = await startExecutor()
    const response = await send(address.port, {
      path: '/run',
      headers: AUTH,
      body: runBody({ executorHandler: 'nopeHandler' })
    })
    assert.equal(response.body.code, 500)
    await delay(20)
    assert.equal(calls.length, 0)
  })

  test('rejects non-BEAN glue types', async () => {
    const { address, calls } = await startExecutor()
    const response = await send(address.port, {
      path: '/run',
      headers: AUTH,
      body: runBody({ glueType: 'GLUE_GROOVY' })
    })
    assert.equal(response.body.code, 500)
    assert.equal(response.body.msg, '仅支持 BEAN 任务')
    await delay(20)
    assert.equal(calls.length, 0)
  })

  test('maps a synchronous handler throw to a failed callback', async () => {
    const handlers = { tokenRefreshHandler: () => { throw new Error('boom') } }
    const { address, calls } = await startExecutor({ handlers })
    const response = await send(address.port, { path: '/run', headers: AUTH, body: runBody() })

    assert.equal(response.body.code, 200)
    await waitFor(() => assert.equal(calls.length, 1))
    assert.deepEqual(JSON.parse(calls[0].options.body)[0], {
      logId: 77,
      logDateTim: 1750000000000,
      handleCode: 500,
      handleMsg: '任务执行失败'
    })
  })

  test('maps an asynchronous handler rejection to a failed callback', async () => {
    const handlers = { tokenRefreshHandler: async () => { throw new Error('boom') } }
    const { address, calls, entries } = await startExecutor({ handlers })
    await send(address.port, { path: '/run', headers: AUTH, body: runBody() })

    await waitFor(() => assert.equal(calls.length, 1))
    assert.equal(JSON.parse(calls[0].options.body)[0].handleCode, 500)
    assert.equal(JSON.parse(calls[0].options.body)[0].handleMsg, '任务执行失败')
    assert.ok(entries.some(entry => entry.fields.event === 'xxl-handler-failed'))
  })

  test('reports idleBeat busy only while the trigger is in flight', async () => {
    let release
    const handlers = {
      tokenRefreshHandler: () => new Promise(resolve => { release = resolve })
    }
    const { address } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ jobId: 3, logId: 3 }) })
    await waitFor(() => assert.equal(typeof release, 'function'))

    assert.equal((await send(address.port, {
      path: '/idleBeat', headers: AUTH, body: JSON.stringify({ jobId: 3 })
    })).body.code, 500)
    assert.equal((await send(address.port, {
      path: '/idleBeat', headers: AUTH, body: JSON.stringify({ jobId: 4 })
    })).body.code, 200)

    release({ handleCode: 200, handleMsg: 'done' })
    await waitFor(async () => {
      const idle = await send(address.port, {
        path: '/idleBeat', headers: AUTH, body: JSON.stringify({ jobId: 3 })
      })
      assert.equal(idle.body.code, 200)
    })
  })

  test('rejects malformed or oversized trigger bodies', async () => {
    const { address } = await startExecutor()
    const bodies = [
      'not-json',
      JSON.stringify({ executorHandler: 'tokenRefreshHandler' }),
      JSON.stringify({ jobId: 'x', executorHandler: 'tokenRefreshHandler', logId: 1 }),
      JSON.stringify({ jobId: 1, executorHandler: '', logId: 1 }),
      JSON.stringify({ jobId: 1, executorHandler: 'tokenRefreshHandler', logId: 1, executorTimeout: -1 }),
      JSON.stringify({ jobId: 1, executorHandler: 'tokenRefreshHandler', logId: 1, broadcastTotal: 0 }),
      'x'.repeat(70 * 1024)
    ]
    for (const body of bodies) {
      const response = await send(address.port, { path: '/run', headers: AUTH, body })
      assert.equal(response.body.code, 500)
    }
  })

  test('rejects invalid log parameters', async () => {
    const { address } = await startExecutor()
    const missing = await send(address.port, { path: '/log', headers: AUTH, body: JSON.stringify({ fromLineNum: 0 }) })
    const negative = await send(address.port, {
      path: '/log',
      headers: AUTH,
      body: JSON.stringify({ logId: 1, fromLineNum: -1 })
    })
    assert.equal(missing.body.code, 500)
    assert.equal(negative.body.code, 500)
  })

  test('streams online logs and marks them finished after the callback', async () => {
    const handlers = {
      tokenRefreshHandler: async ({ log }) => {
        log.info('第一行')
        log.warn('第二行')
        return { handleCode: 200, handleMsg: 'ok' }
      }
    }
    const { address, calls } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ logId: 42, jobId: 12 }) })
    await waitFor(() => assert.equal(calls.length, 1))

    const log = await send(address.port, {
      path: '/log',
      headers: AUTH,
      body: JSON.stringify({ logId: 42, logDateTime: 1, fromLineNum: 0 })
    })
    assert.equal(log.body.code, 200)
    assert.match(log.body.content.logContent, /第一行/)
    assert.match(log.body.content.logContent, /第二行/)
    assert.equal(log.body.content.isEnd, true)
  })

  test('returns unfinished logs while the handler is still running', async () => {
    let release
    const handlers = {
      tokenRefreshHandler: ({ log }) => {
        log.info('执行中')
        return new Promise(resolve => { release = resolve })
      }
    }
    const { address } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ logId: 43, jobId: 13 }) })
    await waitFor(() => assert.equal(typeof release, 'function'))

    const log = await send(address.port, {
      path: '/log',
      headers: AUTH,
      body: JSON.stringify({ logId: 43, logDateTime: 1, fromLineNum: 0 })
    })
    assert.equal(log.body.content.isEnd, false)
    assert.match(log.body.content.logContent, /执行中/)

    release({ handleCode: 200, handleMsg: 'done' })
  })

  test('kill aborts a cooperating handler and reports cancellation', async () => {
    let signal
    const handlers = {
      tokenRefreshHandler: context => new Promise((resolve, reject) => {
        signal = context.signal
        context.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const { address, calls } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ jobId: 9, logId: 90 }) })
    await waitFor(() => assert.ok(signal))

    const kill = await send(address.port, { path: '/kill', headers: AUTH, body: JSON.stringify({ jobId: 9 }) })
    assert.equal(kill.body.code, 200)
    await waitFor(() => assert.equal(calls.length, 1))
    assert.equal(signal.aborted, true)
    assert.equal(JSON.parse(calls[0].options.body)[0].handleCode, 500)
    assert.equal(JSON.parse(calls[0].options.body)[0].handleMsg, '任务已取消')
  })

  test('reports a timeout and aborts the handler signal', async () => {
    let signal
    const handlers = {
      tokenRefreshHandler: context => new Promise(() => { signal = context.signal })
    }
    const { address, calls } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ jobId: 10, logId: 100, executorTimeout: 1 }) })
    await waitFor(() => assert.equal(calls.length, 1), 3000)
    assert.equal(signal.aborted, true)
    assert.equal(JSON.parse(calls[0].options.body)[0].handleCode, 500)
    assert.equal(JSON.parse(calls[0].options.body)[0].handleMsg, '任务执行超时')
  })

  test('logs a callback failure instead of crashing', async () => {
    const fetchImpl = async () => { throw new Error('admin down') }
    const { address, entries } = await startExecutor({ fetchImpl })
    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ jobId: 8, logId: 8 }) })

    await waitFor(() => assert.ok(entries.some(entry =>
      entry.level === 'warn' && entry.fields.event === 'xxl-callback-failed'
    )))
  })

  test('drains the in-flight trigger on stop and refuses new runs afterwards', async () => {
    let release
    const handlers = {
      tokenRefreshHandler: () => new Promise(resolve => { release = resolve })
    }
    const { executor, address, calls } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ jobId: 5, logId: 5 }) })
    let stopped = false
    const stopping = executor.stop().then(() => { stopped = true })
    await delay(20)
    assert.equal(stopped, false)

    release({ handleCode: 200, handleMsg: 'done' })
    await stopping
    await waitFor(() => assert.equal(calls.length, 1))
    await assert.rejects(send(address.port, {
      path: '/run', headers: AUTH, body: runBody({ jobId: 6, logId: 6 })
    }))
  })

  test('aborts in-flight handlers when stopped', async () => {
    let signal
    const handlers = {
      tokenRefreshHandler: context => new Promise((resolve, reject) => {
        signal = context.signal
        context.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const { executor, address, calls } = await startExecutor({ handlers })

    await send(address.port, { path: '/run', headers: AUTH, body: runBody({ jobId: 11, logId: 110 }) })
    await waitFor(() => assert.ok(signal))
    await executor.stop()

    assert.equal(signal.aborted, true)
    await waitFor(() => assert.equal(calls.length, 1))
    assert.equal(JSON.parse(calls[0].options.body)[0].handleMsg, '任务已取消')
  })

  test('starts and stops the registry with the executor', async () => {
    const port = await freePort()
    const config = parseConfig({
      ...CONFIG,
      port,
      autoRegister: true,
      appName: 'test-executor',
      executorAddress: `http://127.0.0.1:${port}/`,
      registerIntervalMs: 60_000
    })
    const transport = callbackFetch()
    const { executor } = await startExecutor({ config, fetchImpl: transport.fetchImpl })

    await waitFor(() => assert.ok(transport.calls.some(call => call.url.endsWith('/api/registry'))))
    await executor.stop()
    assert.ok(transport.calls.some(call => call.url.endsWith('/api/registryRemove')))
  })

  test('start returns the actual port and rejects a second start', async () => {
    const { executor, address } = await startExecutor()
    assert.ok(Number.isInteger(address.port))
    assert.ok(address.port > 0)
    await assert.rejects(() => executor.start(), /已启动/)
  })

  test('rejects an empty or invalid handler map', () => {
    assert.throws(() => createXxlJobExecutor({ config: CONFIG, handlers: {} }), /至少需要一个/)
    assert.throws(() => createXxlJobExecutor({ config: CONFIG, handlers: { bad: 1 } }), /映射到函数/)
  })
})
