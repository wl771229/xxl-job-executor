/**
 * 执行日志内存存储。
 *
 * 每次触发对应一个 logId，日志按行保存在内存中，/log 端点按 fromLineNum
 * 增量返回。执行结束后保留一段时间供 Admin 拉取，然后自动清理。
 */

const DEFAULT_MAX_LINES = 1000
const DEFAULT_RETENTION_MS = 10 * 60 * 1000

function pad(number) {
  return String(number).padStart(2, '0')
}

function formatTime(milliseconds) {
  const date = new Date(milliseconds)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 创建内存日志存储。
 *
 * @param {{maxLines?: number, retentionMs?: number, now?: () => number}} [options]
 * @returns {{create: Function, append: Function, finish: Function, read: Function, dispose: Function}}
 */
export function createLogStore({ maxLines = DEFAULT_MAX_LINES, retentionMs = DEFAULT_RETENTION_MS, now = Date.now } = {}) {
  if (!Number.isInteger(maxLines) || maxLines < 1) throw new TypeError('maxLines 必须是正整数')
  if (!Number.isInteger(retentionMs) || retentionMs < 0) throw new TypeError('retentionMs 必须是非负整数')

  const entries = new Map()

  function create(logId) {
    const existing = entries.get(logId)
    if (existing?.timer) clearTimeout(existing.timer)
    entries.set(logId, { lines: [], finished: false, truncated: false, timer: null })
  }

  function append(logId, level, message) {
    const entry = entries.get(logId)
    if (!entry || entry.finished) return
    if (entry.lines.length >= maxLines) {
      if (!entry.truncated) {
        entry.lines[maxLines - 1] = `[${formatTime(now())}] [WARN] 日志超过 ${maxLines} 行，后续内容已省略`
        entry.truncated = true
      }
      return
    }
    entry.lines.push(`[${formatTime(now())}] [${level}] ${message}`)
  }

  function finish(logId) {
    const entry = entries.get(logId)
    if (!entry) return
    entry.finished = true
    if (retentionMs === 0) {
      entries.delete(logId)
      return
    }
    entry.timer = setTimeout(() => { entries.delete(logId) }, retentionMs)
    entry.timer.unref?.()
  }

  function read(logId, fromLineNum) {
    const entry = entries.get(logId)
    if (!entry) return { fromLineNum: 0, toLineNum: 0, logContent: '', isEnd: true }
    const start = Math.max(0, fromLineNum)
    return {
      fromLineNum,
      toLineNum: entry.lines.length,
      logContent: entry.lines.slice(start).join('\n'),
      // 每次都返回从 fromLineNum 起的全部剩余行，因此执行结束后即可标记结束。
      isEnd: entry.finished
    }
  }

  function dispose() {
    for (const entry of entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    entries.clear()
  }

  return { create, append, finish, read, dispose }
}
