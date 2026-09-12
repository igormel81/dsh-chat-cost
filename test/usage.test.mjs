/**
 * The usage reader, against every shape that actually reaches it.
 *
 * The `tokenUsage` session projection is
 * `{ totals, last: { turn, step, buckets } | null }`, and a reader that looked
 * only at the top level priced every live session at zero — the readout showed
 * `$0` for a chat with millions of cached tokens. These cases pin the shapes,
 * including the one that failed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUsage, totalTokens } from '../lib/usage.js'

const BUCKETS = { uncachedInput: 1000, cacheRead: 5000, cacheWrite: 0, output: 200 }

test('the projection state is read through its totals wrapper', () => {
  const state = {
    totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 },
    last: { turn: 3, step: 2, buckets: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } }
  }
  assert.deepEqual(readUsage(state), BUCKETS, 'totals is cumulative; last.buckets is only the last step')
})

test('a step value and a cache envelope are unwrapped too', () => {
  const step = { turn: 1, step: 1, buckets: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 } }
  assert.deepEqual(readUsage({ buckets: step.buckets }), BUCKETS)
  assert.deepEqual(readUsage({ ver: 1, seq: 42, val: { totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 } } }), BUCKETS)
})

test('flat shapes keep working, in both spellings', () => {
  assert.deepEqual(readUsage({ uncachedInputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 200 }), BUCKETS)
  assert.deepEqual(readUsage(BUCKETS), BUCKETS)
})

test('a projection that has only seen a step reports that step, not zero', () => {
  const state = { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, last: null }
  assert.deepEqual(readUsage(state), { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.equal(totalTokens(readUsage(state)), 0)
})

test('nothing usable resolves to zeroes instead of throwing', () => {
  for (const value of [null, undefined, 0, 'usage', [], { last: null }]) {
    const buckets = readUsage(value)
    assert.deepEqual(buckets, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, `${JSON.stringify(value)} reads as empty`)
  }
})
