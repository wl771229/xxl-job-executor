import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { parseConfig } from '../src/config.js'
import { createRegistry } from '../src/registry.js'
import { makeLogger, waitFor } from './helpers.js'

const BASE = {
  adminBaseUrl: 'http://127.0.0.1:8080/xxl-job-admin',
  accessToken: 'test-access-token-123',
  host: '127.0.0.1',
  port: 9999
}

function enabledConfig() {
  return parseConfig({
    ...BASE,
    autoRegister: true,
    appName: 'test-executor',
    executorAddress: 'http://192.168.1.23:9999/',
    registerIntervalMs: 60_000
  })
}

function fakeFetch() {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers })
    return { text: async () => JSON.stringify({ code: 200, msg: null }) }
  }
  return { calls, fetchImpl }
}

describe('registry', () => {
  test('registers immediately and removes on stop', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const registry = createRegistry({ config: enabledConfig(), fetchImpl })

    registry.start()
    await waitFor(() => assert.equal(calls.length, 1))
    assert.equal(calls[0].url, 'http://127.0.0.1:8080/xxl-job-admin/api/registry')
    assert.deepEqual(calls[0].body, {
      registryGroup: 'EXECUTOR',
      registryKey: 'test-executor',
      registryValue: 'http://192.168.1.23:9999/'
    })
    assert.equal(calls[0].headers['xxl-job-access-token'], 'test-access-token-123')

    await registry.stop()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'http://127.0.0.1:8080/xxl-job-admin/api/registryRemove')
  })

  test('does nothing when auto registration is disabled', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const registry = createRegistry({
      config: parseConfig({ ...BASE, autoRegister: false }),
      fetchImpl
    })

    registry.start()
    await delay(20)
    await registry.stop()
    assert.equal(calls.length, 0)
  })

  test('logs a warning when registration fails', async () => {
    const { logger, entries } = makeLogger()
    const registry = createRegistry({
      config: enabledConfig(),
      fetchImpl: async () => { throw new Error('admin down') },
      logger
    })

    registry.start()
    await waitFor(() => assert.ok(entries.some(entry =>
      entry.level === 'warn' && entry.fields.event === 'xxl-registry-failed'
    )))
    await registry.stop()
  })

  test('does not remove an executor that never started', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const registry = createRegistry({ config: enabledConfig(), fetchImpl })

    await registry.stop()
    registry.start()
    await delay(20)
    assert.equal(calls.length, 0)
  })
})
