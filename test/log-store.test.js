import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createLogStore } from '../src/log-store.js'

const EMPTY = { fromLineNum: 0, toLineNum: 0, logContent: '', isEnd: true }

describe('log store', () => {
  test('appends and reads lines with pagination', () => {
    const store = createLogStore({ now: () => Date.UTC(2026, 0, 1, 0, 0, 0) })
    store.create(1)
    store.append(1, 'INFO', 'first')
    store.append(1, 'WARN', 'second')

    const all = store.read(1, 0)
    assert.equal(all.fromLineNum, 0)
    assert.equal(all.toLineNum, 2)
    assert.match(all.logContent, /first/)
    assert.match(all.logContent, /second/)
    assert.equal(all.isEnd, false)

    const tail = store.read(1, 1)
    assert.match(tail.logContent, /second/)
    assert.doesNotMatch(tail.logContent, /first/)
    assert.equal(tail.isEnd, false)
  })

  test('marks a finished entry as end once all lines are read', () => {
    const store = createLogStore()
    store.create(2)
    store.append(2, 'INFO', 'done')
    store.finish(2)

    const result = store.read(2, 0)
    assert.equal(result.toLineNum, 1)
    assert.equal(result.isEnd, true)
    assert.equal(store.read(2, 1).isEnd, true)
    assert.equal(store.read(2, 1).logContent, '')
  })

  test('returns an empty finished result for unknown log ids', () => {
    const store = createLogStore()
    assert.deepEqual(store.read(99, 0), EMPTY)
  })

  test('caps the number of lines', () => {
    const store = createLogStore({ maxLines: 3 })
    store.create(3)
    store.append(3, 'INFO', 'one')
    store.append(3, 'INFO', 'two')
    store.append(3, 'INFO', 'three')
    store.append(3, 'INFO', 'four')

    const result = store.read(3, 0)
    assert.equal(result.toLineNum, 3)
    assert.match(result.logContent, /日志超过 3 行/)
    assert.doesNotMatch(result.logContent, /four/)
  })

  test('removes a finished entry after the retention period', async () => {
    const store = createLogStore({ retentionMs: 20 })
    store.create(4)
    store.append(4, 'INFO', 'x')
    store.finish(4)
    assert.equal(store.read(4, 0).isEnd, true)

    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(store.read(4, 0), EMPTY)
  })

  test('dispose clears entries and timers', () => {
    const store = createLogStore({ retentionMs: 1000 })
    store.create(5)
    store.append(5, 'INFO', 'x')
    store.finish(5)
    store.dispose()
    assert.deepEqual(store.read(5, 0), EMPTY)
  })

  test('validates constructor options', () => {
    assert.throws(() => createLogStore({ maxLines: 0 }), TypeError)
    assert.throws(() => createLogStore({ retentionMs: -1 }), TypeError)
  })
})
