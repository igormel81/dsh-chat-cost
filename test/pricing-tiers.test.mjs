/**
 * Tier-correct incremental pricing, in RMB.
 *
 * The ledger records each interval at the tariff in effect when those tokens
 * arrived. Re-pricing a session's whole history at the tariff of the moment it
 * happens to be viewed would be wrong by up to the peak multiplier — this is the
 * regression suite for that.
 *
 * DeepSeek's window is stated in Beijing time on the Chinese rate card (09:00-12:00
 * and 14:00-18:00, weekdays). The instants below are UTC, so they are the Beijing
 * wall clock minus eight hours.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __priceSession } from '../lib/index.js'

/** Wednesday 01:30 UTC = 09:30 Beijing — inside the first DeepSeek peak window. */
const PEAK = new Date('2026-10-14T01:30:00Z')
/** Wednesday 05:00 UTC = 13:00 Beijing — between the two peak windows. */
const OFF_PEAK = new Date('2026-10-14T05:00:00Z')

/** The Flash rates the card publishes, off-peak, per million tokens. */
const FLASH_INPUT = 1
const PEAK_MULTIPLIER = 2

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
  // One million input tokens were recorded off-peak: ¥1.00.
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 1 }
  // Another million arrived, and the summary happens to run inside a peak window.
  const priced = __priceSession(context, session({ uncachedInputTokens: 2000000 }), 0, null, PEAK, base)

  assert.equal(priced.recordedUsd, 1)
  assert.equal(priced.tier, 'peak', 'the pending interval is priced at the tariff in effect now')
  assert.ok(Math.abs(priced.deltaUsd - 2) < 1e-9, `one million peak tokens cost ¥${FLASH_INPUT * PEAK_MULTIPLIER}`)
  assert.ok(Math.abs(priced.usd - 3) < 1e-9, `expected ¥1 recorded + ¥2 pending, got ${priced.usd}`)
  // Re-pricing everything at peak would have produced ¥4.
  assert.notEqual(priced.usd, 4)
})

test('the same delta off-peak costs half as much', () => {
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 1 }
  const priced = __priceSession(context, session({ uncachedInputTokens: 2000000 }), 0, null, OFF_PEAK, base)
  assert.equal(priced.tier, 'off-peak')
  assert.ok(Math.abs(priced.deltaUsd - 1) < 1e-9)
  assert.ok(Math.abs(priced.usd - 2) < 1e-9)
})

test('a fully recorded session reports its ledger figure whatever the tariff', () => {
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 2 }
  const priced = __priceSession(context, session({ uncachedInputTokens: 1000000 }), 0, null, PEAK, base)
  assert.equal(priced.deltaUsd, 0, 'nothing new to price')
  assert.equal(priced.usd, 2)
  assert.equal(priced.delta.uncachedInput, 0)
})

test('a session the ledger has never seen is priced from zero', () => {
  const priced = __priceSession(context, session({ uncachedInputTokens: 1000000 }), 0, null, OFF_PEAK, undefined)
  assert.equal(priced.recordedUsd, 0)
  assert.ok(Math.abs(priced.usd - FLASH_INPUT) < 1e-9)
})

test('a route with no price yields no figure at all, not a zero', () => {
  const priced = __priceSession(context, session({ outputTokens: 1000 }, { provider: 'unknown', model: 'mystery' }), 0, null, OFF_PEAK, undefined)
  assert.equal(priced.usd, null)
  assert.equal(priced.deltaUsd, null)
  assert.equal(priced.pricingSource, 'none')
})

test('a provider outside the rate table is reported as unknown, not as another vendor\'s price', () => {
  // Moonshot used to be priced from the bundled multi-provider catalog. The table
  // now covers DeepSeek only, so the honest answer is that there is no price —
  // borrowing the DeepSeek rate here would be the exact error this guards.
  const priced = __priceSession(context, session({ outputTokens: 1000000 }, { provider: 'moonshot', model: 'kimi-k3' }), 0, null, PEAK, undefined)
  assert.equal(priced.pricingSource, 'none')
  assert.equal(priced.usd, null)
  assert.equal(priced.tier, null)
})

test('a stated window overrides the clock, so a later poll cannot re-tier an interval', () => {
  // The clock says peak; the caller says the interval was consumed off-peak. The
  // caller wins, because the window is a property of consumption, not of polling.
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 1 }
  const priced = __priceSession(context, session({ uncachedInputTokens: 2000000 }), 0, null, PEAK, base, null, 'off-peak')
  assert.equal(priced.tier, 'off-peak')
  assert.ok(Math.abs(priced.deltaUsd - 1) < 1e-9, 'the pending million is charged at the off-peak rate')
  assert.ok(Math.abs(priced.usd - 2) < 1e-9)
})

test('a base from another tariff epoch is discarded, not added to', () => {
  // A ledger written under a different rate table carries money that is not
  // comparable with today's. Chaining it would add one table's total to another's,
  // which is how a USD-era cumulative once showed up as a CNY figure.
  const base = { tokens: { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }, cumulativeUsd: 0.15, restart: true }
  const priced = __priceSession(context, session({ uncachedInputTokens: 1000000 }), 0, null, OFF_PEAK, base)
  assert.equal(priced.recordedUsd, 0, 'the old epoch contributes nothing')
  assert.ok(Math.abs(priced.usd - FLASH_INPUT) < 1e-9, 'the whole interval is priced under the current table')
  assert.equal(priced.delta.uncachedInput, 1000000, 'and the interval is the whole cumulative')
})
