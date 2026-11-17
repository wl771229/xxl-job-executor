import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { loadConfig, parseConfig, XxlJobConfigError } from '../src/config.js'

const BASE = {
  XXL_ADMIN_BASE_URL: 'http://192.168.1.10:8080/xxl-job-admin',
  XXL_ACCESS_TOKEN: 'test-access-token'
}

const DEFAULT_CONFIG = {
  adminBaseUrl: 'http://192.168.1.10:8080/xxl-job-admin',
  accessToken: 'test-access-token',
  host: '127.0.0.1',
  port: 9999,
  autoRegister: false,
  appName: '',
  executorAddress: '',
  registerIntervalMs: 30_000
}

describe('loadConfig', () => {
  test('returns null when nothing is configured', () => {
    assert.equal(loadConfig({}), null)
  })

  test('rejects half-configured credentials instead of half-enabling', () => {
    assert.throws(() => loadConfig({ XXL_ADMIN_BASE_URL: BASE.XXL_ADMIN_BASE_URL }), XxlJobConfigError)
    assert.throws(() => loadConfig({ XXL_ACCESS_TOKEN: BASE.XXL_ACCESS_TOKEN }), XxlJobConfigError)
  })

  test('returns a frozen configuration with defaults', () => {
    const config = loadConfig(BASE)
    assert.deepEqual(config, DEFAULT_CONFIG)
    assert.ok(Object.isFrozen(config))
  })

  test('supports a custom environment prefix', () => {
    const config = loadConfig({
      MY_ADMIN_BASE_URL: BASE.XXL_ADMIN_BASE_URL,
      MY_ACCESS_TOKEN: BASE.XXL_ACCESS_TOKEN
    }, { prefix: 'MY_' })
    assert.equal(config.accessToken, 'test-access-token')
  })

  test('keeps the admin context path and drops trailing slashes', () => {
    assert.equal(
      loadConfig({ ...BASE, XXL_ADMIN_BASE_URL: 'https://10.0.0.5/xxl-job-admin/' }).adminBaseUrl,
      'https://10.0.0.5/xxl-job-admin'
    )
    assert.equal(
      loadConfig({ ...BASE, XXL_ADMIN_BASE_URL: 'http://127.0.0.1:8080' }).adminBaseUrl,
      'http://127.0.0.1:8080'
    )
  })

  test('rejects invalid admin base urls', () => {
    const urls = [
      'http://localhost:8080/xxl-job-admin',
      'http://8.8.8.8/xxl-job-admin',
      'http://192.168.01.10/xxl-job-admin',
      'http://192.168.1.10:8080/xxl-job-admin?x=1',
      'ftp://192.168.1.10/xxl-job-admin'
    ]
    for (const url of urls) {
      assert.throws(() => loadConfig({ ...BASE, XXL_ADMIN_BASE_URL: url }), XxlJobConfigError)
    }
  })

  test('rejects invalid executor hosts', () => {
    const hosts = ['localhost', '8.8.8.8', '192.168.01.2', '10.0.0.256', '2001:db8::1']
    for (const host of hosts) {
      assert.throws(() => loadConfig({ ...BASE, XXL_EXECUTOR_HOST: host }), XxlJobConfigError)
    }
  })

  test('accepts loopback and private executor hosts', () => {
    for (const host of ['192.168.1.23', '10.1.2.3', '172.16.0.9', '127.0.0.1']) {
      assert.equal(loadConfig({ ...BASE, XXL_EXECUTOR_HOST: host }).host, host)
    }
  })

  test('validates the executor port as a strict decimal number', () => {
    assert.equal(loadConfig({ ...BASE, XXL_EXECUTOR_PORT: '0' }).port, 0)
    for (const port of ['-1', '1e3', '65536', 'abc']) {
      assert.throws(() => loadConfig({ ...BASE, XXL_EXECUTOR_PORT: port }), XxlJobConfigError)
    }
  })

  test('rejects a short access token', () => {
    assert.throws(() => loadConfig({ ...BASE, XXL_ACCESS_TOKEN: 'short' }), XxlJobConfigError)
  })

  test('reads auto registration settings from the environment', () => {
    const config = loadConfig({
      ...BASE,
      XXL_AUTO_REGISTER: 'true',
      XXL_APP_NAME: 'demo-executor',
      XXL_EXECUTOR_ADDRESS: 'http://192.168.1.23:9999',
      XXL_REGISTER_INTERVAL_MS: '5000'
    })
    assert.equal(config.autoRegister, true)
    assert.equal(config.appName, 'demo-executor')
    assert.equal(config.executorAddress, 'http://192.168.1.23:9999/')
    assert.equal(config.registerIntervalMs, 5000)
  })

  test('rejects an invalid auto register flag', () => {
    assert.throws(() => loadConfig({ ...BASE, XXL_AUTO_REGISTER: 'yes' }), XxlJobConfigError)
  })

  test('requires app name and address when auto registration is enabled', () => {
    assert.throws(() => loadConfig({ ...BASE, XXL_AUTO_REGISTER: 'true' }), XxlJobConfigError)
    assert.throws(
      () => loadConfig({ ...BASE, XXL_AUTO_REGISTER: 'true', XXL_APP_NAME: 'demo-executor' }),
      XxlJobConfigError
    )
  })
})

describe('parseConfig', () => {
  test('applies defaults for host, port and registration', () => {
    assert.deepEqual(parseConfig({
      adminBaseUrl: 'http://127.0.0.1:8080',
      accessToken: 'abcdefgh'
    }), {
      adminBaseUrl: 'http://127.0.0.1:8080',
      accessToken: 'abcdefgh',
      host: '127.0.0.1',
      port: 9999,
      autoRegister: false,
      appName: '',
      executorAddress: '',
      registerIntervalMs: 30_000
    })
  })

  test('normalizes an auto registration address with a trailing slash', () => {
    const config = parseConfig({
      adminBaseUrl: 'http://127.0.0.1:8080/xxl-job-admin',
      accessToken: 'abcdefgh',
      autoRegister: true,
      appName: 'demo-executor',
      executorAddress: 'http://192.168.1.23:9999',
      registerIntervalMs: 5000
    })
    assert.equal(config.executorAddress, 'http://192.168.1.23:9999/')
    assert.equal(config.registerIntervalMs, 5000)
  })

  test('keeps a context path on the executor address', () => {
    const config = parseConfig({
      adminBaseUrl: 'http://127.0.0.1:8080',
      accessToken: 'abcdefgh',
      executorAddress: 'http://192.168.1.23:9999/executor/'
    })
    assert.equal(config.executorAddress, 'http://192.168.1.23:9999/executor/')
  })

  test('is idempotent for a normalized configuration', () => {
    const once = parseConfig({
      adminBaseUrl: 'http://127.0.0.1:8080',
      accessToken: 'abcdefgh'
    })
    assert.deepEqual(parseConfig(once), once)

    const onceWithRegistration = parseConfig({
      adminBaseUrl: 'http://127.0.0.1:8080',
      accessToken: 'abcdefgh',
      autoRegister: true,
      appName: 'demo-executor',
      executorAddress: 'http://192.168.1.23:9999/'
    })
    assert.deepEqual(parseConfig(onceWithRegistration), onceWithRegistration)
  })

  test('rejects invalid app names', () => {
    for (const appName of ['has space', '中文', 'a'.repeat(129)]) {
      assert.throws(() => parseConfig({
        adminBaseUrl: 'http://127.0.0.1:8080',
        accessToken: 'abcdefgh',
        appName
      }), XxlJobConfigError)
    }
  })

  test('rejects invalid executor addresses', () => {
    for (const executorAddress of [
      'http://localhost:9999/',
      'http://8.8.8.8:9999/',
      'ftp://192.168.1.23:9999/',
      'http://192.168.1.23:9999/?x=1'
    ]) {
      assert.throws(() => parseConfig({
        adminBaseUrl: 'http://127.0.0.1:8080',
        accessToken: 'abcdefgh',
        executorAddress
      }), XxlJobConfigError)
    }
  })

  test('rejects invalid registration intervals', () => {
    for (const registerIntervalMs of [999, 600_001, '30000', 1.5]) {
      assert.throws(() => parseConfig({
        adminBaseUrl: 'http://127.0.0.1:8080',
        accessToken: 'abcdefgh',
        registerIntervalMs
      }), XxlJobConfigError)
    }
  })

  test('rejects an ephemeral port when auto registration is enabled', () => {
    assert.throws(() => parseConfig({
      adminBaseUrl: 'http://127.0.0.1:8080',
      accessToken: 'abcdefgh',
      port: 0,
      autoRegister: true,
      appName: 'demo-executor',
      executorAddress: 'http://192.168.1.23:9999/'
    }), XxlJobConfigError)
  })

  test('rejects invalid input types', () => {
    assert.throws(() => parseConfig(null), XxlJobConfigError)
    assert.throws(
      () => parseConfig({ adminBaseUrl: 'http://127.0.0.1:8080', accessToken: 'abcdefgh', host: 'localhost' }),
      XxlJobConfigError
    )
    assert.throws(
      () => parseConfig({ adminBaseUrl: 'http://127.0.0.1:8080', accessToken: 'abcdefgh', port: '9999' }),
      XxlJobConfigError
    )
    assert.throws(
      () => parseConfig({ adminBaseUrl: 'http://127.0.0.1:8080', accessToken: 'abcdefgh', autoRegister: 'true' }),
      XxlJobConfigError
    )
  })

  test('exposes the offending field', () => {
    try {
      parseConfig({ adminBaseUrl: 'http://127.0.0.1:8080', accessToken: 'short' })
      assert.fail('expected a config error')
    } catch (error) {
      assert.ok(error instanceof XxlJobConfigError)
      assert.equal(error.field, 'accessToken')
    }
  })
})
