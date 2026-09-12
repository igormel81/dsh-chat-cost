import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actualsByLabel, costRecord, markRecord, parseLog, summarizeTree, tokens, totalTokens } from '../lib/log.js'

test('usage buckets normalize missing fields to zero', () => {
  assert.deepEqual(tokens({ uncachedInputTokens: 10, cacheReadTokens: 5 }), {
    uncachedInput: 10, cacheRead: 5, cacheWrite: 0, output: 0
  })
  assert.equal(totalTokens(tokens({ outputTokens: 3 })), 3)
})

test('a record carries tree position and both cumulative and delta cost', () => {
  const record = costRecord({
    ts: '2026-09-12T20:00:00.000Z',
    sessionId: 'child-1',
    parentSessionId: 'root-1',
    rootSessionId: 'root-1',
    depth: 1,
    provider: 'moonshot',
    model: 'kimi-k3',
    pricingSource: 'catalog',
    tier: 'flat',
    usage: { uncachedInputTokens: 1000, outputTokens: 200 },
    cumulativeUsd: 0.006,
    deltaUsd: 0.002
  })
  assert.equal(record.kind, 'subagent')
  assert.equal(record.totalTokens, 1200)
  assert.equal(record.cumulativeUsd, 0.006)
  assert.equal(record.deltaUsd, 0.002)
  assert.equal(record.rootSessionId, 'root-1')
})

test('a top-level session is logged as a chat', () => {
  const record = costRecord({ sessionId: 'root-1', usage: {}, cumulativeUsd: 0 })
  assert.equal(record.kind, 'chat')
  assert.equal(record.parentSessionId, null)
  assert.equal(record.rootSessionId, 'root-1')
})

test('tree summary separates the chat from its subagents', () => {
  const summary = summarizeTree([
    { sessionId: 'root-1', parentSessionId: null, depth: 0, usage: { uncachedInputTokens: 1000 }, usd: 0.01 },
    { sessionId: 'c1', parentSessionId: 'root-1', depth: 1, usage: { outputTokens: 500 }, usd: 0.004 },
    { sessionId: 'c2', parentSessionId: 'root-1', depth: 1, usage: { outputTokens: 500 }, usd: null, model: 'mystery' }
  ])
  assert.equal(summary.totals.usd, 0.014)
  assert.equal(summary.totals.chatUsd, 0.01)
  assert.equal(summary.totals.subagentUsd, 0.004)
  assert.equal(summary.totals.subagentCount, 2)
  assert.deepEqual(summary.totals.unpricedSessions, ['c2'])
  assert.equal(summary.self.sessionId, 'root-1')
})

test('an all-unpriced tree reports null rather than zero', () => {
  const summary = summarizeTree([{ sessionId: 'root-1', parentSessionId: null, usage: {}, usd: null }])
  assert.equal(summary.totals.usd, null)
  assert.equal(summary.totals.chatUsd, null)
})

test('a burst written inside one millisecond still attributes by write order', () => {
  // Regression: ordering by timestamp (or by hoisting every mark above every
  // record of the same millisecond) attributed a whole burst to the last label.
  const stamp = '2026-09-12T20:00:00.000Z'
  const lines = [
    markRecord({ ts: stamp, sessionId: 'root', label: 'research' }),
    costRecord({ ts: stamp, sessionId: 'root', deltaUsd: 0.04, cumulativeUsd: 0.04, usage: { outputTokens: 10 } }),
    markRecord({ ts: stamp, sessionId: 'root', label: 'synthesis' }),
    costRecord({ ts: stamp, sessionId: 'root', deltaUsd: 0.5, cumulativeUsd: 0.54, usage: { outputTokens: 2000 } }),
    costRecord({ ts: stamp, sessionId: 'root', deltaUsd: 0.1, cumulativeUsd: 0.64, usage: { outputTokens: 400 } })
  ]
  const { entries, costs, marks } = parseLog(lines.map((line) => JSON.stringify(line)).join('\n'))
  assert.equal(costs.length, 3)
  assert.equal(marks.length, 2)

  const buckets = actualsByLabel(entries)
  assert.deepEqual(buckets.map((bucket) => bucket.label).sort(), ['research', 'synthesis'])
  const research = buckets.find((bucket) => bucket.label === 'research')
  const synthesis = buckets.find((bucket) => bucket.label === 'synthesis')
  assert.equal(research.usd, 0.04)
  assert.ok(Math.abs(synthesis.usd - 0.6) < 1e-9)
  assert.equal(synthesis.tokens.output, 2400)

  // The legacy (costs, marks) pair loses the interleaving: everything lands
  // under "_unlabeled". That is exactly why callers pass ordered entries.
  const legacy = actualsByLabel(costs, marks)
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].label, '_unlabeled')
  assert.equal(legacy[0].usd, 0.64)
})

test('spend before the first mark is reported as unlabelled rather than dropped', () => {
  const { entries } = parseLog([
    JSON.stringify(costRecord({ sessionId: 'root', deltaUsd: 0.02, cumulativeUsd: 0.02 })),
    JSON.stringify(markRecord({ sessionId: 'root', label: 'later' })),
    JSON.stringify(costRecord({ sessionId: 'root', deltaUsd: 0.03, cumulativeUsd: 0.05 }))
  ].join('\n'))
  const buckets = actualsByLabel(entries)
  const unlabelled = buckets.find((bucket) => bucket.label === '_unlabeled')
  assert.equal(unlabelled.usd, 0.02)
  assert.equal(buckets.find((bucket) => bucket.label === 'later').usd, 0.03)
})
