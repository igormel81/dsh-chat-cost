/**
 * The rate table's identity, and the parse that produces it.
 *
 * The regression this file exists for: the tariff epoch used to include the date
 * the table was fetched. Since the fetch runs once per host launch, a fresh fetch
 * of *unchanged* rates then looked like a new table, and every running session
 * discarded its cumulative and re-priced its whole interval — on a schedule, while
 * the prices never moved. The epoch is a property of the prices, not of when we
 * last looked at them.
 *
 * Everything here is a pure function: no network, no cache writes. The suite runs
 * one test file per process, so a test that replaced the real cache would be read
 * by the others while it was swapped out.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateFingerprint, isPeak, parsePricingPage, SEED } from '../lib/rates.js'

/** The vendor page, reduced to the rows this parser reads. */
const PAGE = (rates) => `
<table>
  <tr><td>模型</td><td>deepseek-flash (1)</td><td>deepseek-v4-pro</td></tr>
  <tr><td>价格 (2)</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>${rates.hit[0]}元</td><td>${rates.hit[1]}元</td></tr>
  <tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>${rates.miss[0]}元</td><td>${rates.miss[1]}元</td></tr>
  <tr><td>百万tokens输出</td><td>空闲时段</td><td>${rates.out[0]}元</td><td>${rates.out[1]}元</td></tr>
</table>`

const RATES = { hit: [0.02, 0.15], miss: [1, 4.5], out: [4, 13.5] }

/** A table in the shape `table()` produces, from parsed models. */
const tableOf = (models, extra = {}) => ({ source: 'https://example.test/pricing', fetchedAt: 0, ...extra, models })

const day = (iso) => ({ asOf: iso })

test('parsing the rate card yields the off-peak CNY columns', () => {
  const parsed = parsePricingPage(PAGE(RATES))
  assert.equal(parsed.ok, true, parsed.reason)
  assert.deepEqual(parsed.modelNames, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(parsed.models['deepseek-flash'].cost.input, 1)
  assert.equal(parsed.models['deepseek-flash'].cost.cacheRead, 0.02)
  assert.equal(parsed.models['deepseek-flash'].cost.output, 4)
  assert.equal(parsed.models['deepseek-v4-pro'].cost.input, 4.5)
  assert.equal(parsed.models['deepseek-v4-pro'].cost.cacheRead, 0.15)
  assert.equal(parsed.models['deepseek-v4-pro'].cost.output, 13.5)
  assert.equal(parsed.models['deepseek-flash'].cost.currency, 'CNY')
  assert.equal(parsed.models['deepseek-flash'].cost.cacheWrite, null, 'the card publishes no separate cache-write fee')
})

test('a page whose cache hit is not cheaper than a miss is refused', () => {
  // Equal is already anomalous: being cheaper is the entire point of a cache.
  const parsed = parsePricingPage(PAGE({ ...RATES, hit: [1, 0.15] }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'cache-hit-above-miss')
})

test('a page whose output is cheaper than a miss is refused', () => {
  const parsed = parsePricingPage(PAGE({ ...RATES, out: [0.5, 13.5] }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'output-below-input')
})

test('a page missing the model row is refused rather than guessed', () => {
  const parsed = parsePricingPage('<table><tr><td>price</td><td>1元</td><td>2元</td></tr></table>')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'model-row-not-found')
})

test('an empty page is refused', () => {
  assert.equal(parsePricingPage('').reason, 'empty-page')
  assert.equal(parsePricingPage('<div>nothing tabular</div>').reason, 'no-table-rows')
})

test('re-reading the same rates on a later day keeps the same epoch', () => {
  const parsed = parsePricingPage(PAGE(RATES))
  const monday = tableOf(parsed.models, day('2026-10-12'))
  const friday = tableOf(parsed.models, day('2026-10-16'))

  assert.notEqual(monday.asOf, friday.asOf, 'the two fetches carry different dates')
  assert.equal(rateFingerprint(friday), rateFingerprint(monday), 'unchanged rates are the same table: the epoch must not move')
  assert.match(rateFingerprint(monday), /^CNY:[0-9a-f]{8}$/, 'the epoch is a currency and a hash, with no date in it')
  assert.ok(rateFingerprint(monday).includes(monday.asOf) === false, 'the epoch deliberately carries no date')
})

test('a real rate change does start a new epoch', () => {
  const before = rateFingerprint(tableOf(parsePricingPage(PAGE(RATES)).models))
  const after = rateFingerprint(tableOf(parsePricingPage(PAGE({ ...RATES, hit: [0.03, 0.15] })).models))
  assert.notEqual(after, before, 'a moved price is a different table and must invalidate the cumulative')
})

test('the same rates in a different order are still the same epoch', () => {
  const parsed = parsePricingPage(PAGE(RATES))
  const forward = tableOf(parsed.models)
  const reversed = tableOf(Object.fromEntries(Object.entries(parsed.models).reverse()))
  assert.equal(rateFingerprint(reversed), rateFingerprint(forward), 'key order is not a price change')
})

test('an empty or absent table has no epoch at all', () => {
  assert.equal(rateFingerprint(null), null)
  assert.equal(rateFingerprint({}), null)
  assert.equal(rateFingerprint({ models: {} }), null)
})

test('the bundled fallback table has an identity of its own', () => {
  const seeded = rateFingerprint({ models: SEED.models })
  assert.match(seeded, /^CNY:[0-9a-f]{8}$/)
  assert.equal(seeded, rateFingerprint({ models: JSON.parse(JSON.stringify(SEED.models)) }))
})

test('the peak window is Beijing time on weekdays', () => {
  // 01:00 UTC is 09:00 in Beijing; 05:00 UTC is 13:00, between the two windows.
  assert.equal(isPeak(new Date(Date.UTC(2026, 9, 13, 1, 0, 0))), true, 'Tuesday 09:00 Beijing is peak')
  assert.equal(isPeak(new Date(Date.UTC(2026, 9, 13, 5, 0, 0))), false, 'Tuesday 13:00 Beijing is off-peak')
  assert.equal(isPeak(new Date(Date.UTC(2026, 9, 13, 2, 30, 0))), true, 'Tuesday 10:30 Beijing is peak')
  assert.equal(isPeak(new Date(Date.UTC(2026, 9, 13, 7, 0, 0))), true, 'Tuesday 15:00 Beijing is peak')
  assert.equal(isPeak(new Date(Date.UTC(2026, 9, 17, 1, 0, 0))), false, 'Saturday is never peak, whatever the hour')
})
