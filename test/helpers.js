import { request } from 'node:http'

export function send(port, { path = '/beat', method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

export function makeLogger() {
  const entries = []
  return {
    entries,
    logger: {
      info: (fields, message) => entries.push({ level: 'info', fields, message }),
      warn: (fields, message) => entries.push({ level: 'warn', fields, message })
    }
  }
}

export async function waitFor(check, timeout = 2000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw lastError ?? new Error('waitFor timed out')
}
