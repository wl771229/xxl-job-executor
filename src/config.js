/**
 * XXL-JOB 执行器的配置解析与校验。
 *
 * 调度中心地址、执行器绑定地址和注册地址都只允许回环或 RFC1918 私网 IPv4。
 * 这是面向私有部署的安全默认值，不是通用的公网客户端。
 */

export class XxlJobConfigError extends Error {
  /**
   * @param {string} field 出错的配置字段
   * @param {string} [message] 错误信息
   */
  constructor(field, message = `${field} 配置无效`) {
    super(message)
    this.name = 'XxlJobConfigError'
    this.field = field
  }
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9999
const DEFAULT_REGISTER_INTERVAL_MS = 30_000
const MIN_REGISTER_INTERVAL_MS = 1_000
const MAX_REGISTER_INTERVAL_MS = 600_000

function decimal(value, field, min, max) {
  // 只接受纯十进制字符串，拒绝科学计数法、小数和隐式类型转换。
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) throw new XxlJobConfigError(field)
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new XxlJobConfigError(field)
  return number
}

// 规范点分 IPv4：拒绝前导零、缩写和超界 octet。
function canonicalIpv4(host) {
  if (typeof host !== 'string' || !/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(host)) return null
  const octets = host.split('.').map(Number)
  if (octets.some(octet => octet > 255)) return null
  if (octets.join('.') !== host) return null
  return octets
}

// 仅允许回环与 RFC1918 私网。
function isLocalOrPrivate(octets) {
  const [first, second] = octets
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function localIpv4Setting(value, field) {
  const octets = canonicalIpv4(value)
  if (!octets || !isLocalOrPrivate(octets)) throw new XxlJobConfigError(field)
  return value
}

function privateHttpUrlSetting(value, field, { trailingSlash = false } = {}) {
  let url
  try { url = new URL(value) } catch { throw new XxlJobConfigError(field) }
  // URL 解析器会把 192.168.01.10 这类写法规范化，因此必须校验原始 authority，
  // 不能信任解析后的 hostname。
  const authority = /^https?:\/\/([^/?#\s]+)/u.exec(value)?.[1] ?? ''
  if (authority.includes('@')) throw new XxlJobConfigError(field)
  const [hostText, portText, extra] = authority.split(':')
  if (extra !== undefined || (portText !== undefined && !/^[0-9]{1,5}$/u.test(portText))) {
    throw new XxlJobConfigError(field)
  }
  const octets = canonicalIpv4(hostText)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !octets || !isLocalOrPrivate(octets) ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new XxlJobConfigError(field)
  }
  const path = url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${path}${trailingSlash ? '/' : ''}`
}

function appNameSetting(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new XxlJobConfigError('appName')
  }
  return value
}

/**
 * 校验并规范化执行器配置对象。
 *
 * @param {object} input
 * @param {string} input.adminBaseUrl 调度中心地址，例如 http://192.168.1.10:8080/xxl-job-admin
 * @param {string} input.accessToken 与调度中心一致的访问令牌（至少 8 个字符）
 * @param {string} [input.host=127.0.0.1] 执行器绑定地址（回环或 RFC1918 IPv4）
 * @param {number} [input.port=9999] 执行器端口；0 表示随机端口
 * @param {boolean} [input.autoRegister=false] 是否向调度中心自动注册
 * @param {string} [input.appName] 自动注册时的执行器 AppName
 * @param {string} [input.executorAddress] 自动注册时调度中心可访问的执行器地址
 * @param {number} [input.registerIntervalMs=30000] 注册心跳间隔
 * @returns {Readonly<object>}
 * @throws {XxlJobConfigError}
 */
export function parseConfig(input) {
  if (input === null || typeof input !== 'object') throw new XxlJobConfigError('config', '配置必须是对象')
  const {
    adminBaseUrl,
    accessToken,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    autoRegister = false,
    appName,
    executorAddress,
    registerIntervalMs = DEFAULT_REGISTER_INTERVAL_MS
  } = input

  if (typeof adminBaseUrl !== 'string' || adminBaseUrl === '') throw new XxlJobConfigError('adminBaseUrl')
  if (typeof accessToken !== 'string' || accessToken.length < 8) throw new XxlJobConfigError('accessToken')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new XxlJobConfigError('port')
  if (typeof autoRegister !== 'boolean') throw new XxlJobConfigError('autoRegister')
  if (!Number.isInteger(registerIntervalMs) ||
    registerIntervalMs < MIN_REGISTER_INTERVAL_MS || registerIntervalMs > MAX_REGISTER_INTERVAL_MS) {
    throw new XxlJobConfigError('registerIntervalMs')
  }
  // 随机端口无法提前写进注册地址，自动注册时必须使用固定端口。
  if (autoRegister && port === 0) {
    throw new XxlJobConfigError('port', '自动注册时 port 不能为 0')
  }

  // 空字符串表示未配置，保证 loadConfig/parseConfig 的返回值可以再次传入 parseConfig。
  const normalizedAppName = appName === undefined || appName === '' ? '' : appNameSetting(appName)
  const normalizedExecutorAddress = executorAddress === undefined || executorAddress === ''
    ? ''
    : privateHttpUrlSetting(executorAddress, 'executorAddress', { trailingSlash: true })
  if (autoRegister && (!normalizedAppName || !normalizedExecutorAddress)) {
    throw new XxlJobConfigError('autoRegister', '启用自动注册时必须同时配置 appName 和 executorAddress')
  }

  return Object.freeze({
    adminBaseUrl: privateHttpUrlSetting(adminBaseUrl, 'adminBaseUrl'),
    accessToken,
    host: localIpv4Setting(host, 'host'),
    port,
    autoRegister,
    appName: normalizedAppName,
    executorAddress: normalizedExecutorAddress,
    registerIntervalMs
  })
}

/**
 * 从环境变量读取执行器配置。
 *
 * 两项必填配置都不存在时返回 null，宿主应用可据此把执行器视为未启用；只配置
 * 其中一项视为配置不完整并直接抛错，不做静默半启用。
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {{prefix?: string}} [options]
 * @returns {Readonly<object> | null}
 * @throws {XxlJobConfigError}
 */
export function loadConfig(env = process.env, { prefix = 'XXL_' } = {}) {
  const read = name => {
    const value = env[`${prefix}${name}`]
    return typeof value === 'string' ? value.trim() : ''
  }
  const adminBaseUrl = read('ADMIN_BASE_URL')
  const accessToken = read('ACCESS_TOKEN')
  if (!adminBaseUrl && !accessToken) return null
  if (!adminBaseUrl || !accessToken) {
    throw new XxlJobConfigError('ADMIN_BASE_URL', `${prefix}ADMIN_BASE_URL 和 ${prefix}ACCESS_TOKEN 必须同时配置`)
  }

  const host = read('EXECUTOR_HOST') || DEFAULT_HOST
  const portText = read('EXECUTOR_PORT')
  const port = portText === '' ? DEFAULT_PORT : decimal(portText, 'EXECUTOR_PORT', 0, 65535)

  const autoRegisterText = read('AUTO_REGISTER')
  if (autoRegisterText !== '' && autoRegisterText !== 'true' && autoRegisterText !== 'false') {
    throw new XxlJobConfigError('AUTO_REGISTER', `${prefix}AUTO_REGISTER 只能是 true 或 false`)
  }

  const registerIntervalText = read('REGISTER_INTERVAL_MS')
  const registerIntervalMs = registerIntervalText === ''
    ? DEFAULT_REGISTER_INTERVAL_MS
    : decimal(registerIntervalText, 'REGISTER_INTERVAL_MS', MIN_REGISTER_INTERVAL_MS, MAX_REGISTER_INTERVAL_MS)

  return parseConfig({
    adminBaseUrl,
    accessToken,
    host,
    port,
    autoRegister: autoRegisterText === 'true',
    appName: read('APP_NAME') || undefined,
    executorAddress: read('EXECUTOR_ADDRESS') || undefined,
    registerIntervalMs
  })
}
