/**
 * Tier-correct incremental pricing.
 *
 * The ledger records each interval at the tariff in effect when those tokens
 * arrived. Re-pricing a session's whole history at the tariff of the moment it
 * happens to be viewed would be wrong by up to the peak multiplier — this is the
 * regression suite for that.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __priceSession } from '../lib/index.js'

/** Monday 02:00 UTC — inside a DeepSeek peak window. */
const PEAK = new Date('2026-09-14T02:00:00Z')
/** Monday 05:00 UTC — between the two peak windows. */
const OFF_PEAK = new Date('2026-09-14T05:00:00Z')

function session(usage, { provider = 'deepseek-official', model = 'deepseek-flash' } = {}) {
  return {
    id: 'root',
    header: { version: 1, id: 'root', createdAt: '2026-09-12T00:00:00.000Z' },
    events: [{ type: 'request/header', data: { header: { config: { provider, model } } } }],
    usage
  }
}

const context = { get: (name) => (name === 'sessionProjections' ? { stateOf: (entry) => entry.usage } : undefined) }

test('tokens already recorded are never re-priced at the current tariff', () => {
  // One million input tokens were recorded off-peak: $0.15.
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 0.15 }
  // Another million arrived, and the summary happens to run inside a peak window.
  const priced = __priceSession(context, session({ uncachedInputTokens: 2000000 }), 0, null, PEAK, base)

  assert.equal(priced.recordedUsd, 0.15)
  assert.equal(priced.tier, 'peak', 'the pending interval is priced at the tariff in effect now')
  assert.ok(Math.abs(priced.deltaUsd - 0.3) < 1e-9, 'one million peak tokens cost $0.30')
  assert.ok(Math.abs(priced.usd - 0.45) < 1e-9, `expected 0.15 recorded + 0.30 pending, got ${priced.usd}`)
  // Re-pricing everything at peak would have produced 0.60.
  assert.notEqual(Math.round(priced.usd * 100) / 100, 0.6)
})

test('the same delta off-peak costs half as much', () => {
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 0.15 }
  const priced = __priceSession(context, session({ uncachedInputTokens: 2000000 }), 0, null, OFF_PEAK, base)
  assert.equal(priced.tier, 'off-peak')
  assert.ok(Math.abs(priced.deltaUsd - 0.15) < 1e-9)
  assert.ok(Math.abs(priced.usd - 0.3) < 1e-9)
})

test('a fully recorded session reports its ledger figure whatever the tariff', () => {
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 0.3 }
  const priced = __priceSession(context, session({ uncachedInputTokens: 1000000 }), 0, null, PEAK, base)
  assert.equal(priced.deltaUsd, 0, 'nothing new to price')
  assert.equal(priced.usd, 0.3)
  assert.equal(priced.delta.uncachedInput, 0)
})

test('a session the ledger has never seen is priced from zero', () => {
  const priced = __priceSession(context, session({ uncachedInputTokens: 1000000 }), 0, null, OFF_PEAK, undefined)
  assert.equal(priced.recordedUsd, 0)
  assert.ok(Math.abs(priced.usd - 0.15) < 1e-9)
})

test('a route with no price yields no figure at all, not a zero', () => {
  const priced = __priceSession(context, session({ outputTokens: 1000 }, { provider: 'unknown', model: 'mystery' }), 0, null, OFF_PEAK, undefined)
  assert.equal(priced.usd, null)
  assert.equal(priced.deltaUsd, null)
  assert.equal(priced.pricingSource, 'none')
})

test('a flat-priced route ignores the peak window entirely', () => {
  const priced = __priceSession(context, session({ outputTokens: 1000000 }, { provider: 'moonshot', model: 'kimi-k3' }), 0, null, PEAK, undefined)
  assert.equal(priced.tier, 'flat')
  assert.ok(Math.abs(priced.usd - 15) < 1e-9, 'Kimi K3 output is $15 per million at any hour')
})
