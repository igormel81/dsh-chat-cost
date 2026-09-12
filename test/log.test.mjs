import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costRecord, summarizeTree, tokens, totalTokens } from '../lib/log.js'

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
