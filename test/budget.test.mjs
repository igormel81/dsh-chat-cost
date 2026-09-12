/**
 * Budget arithmetic: estimation bases, ranges, packing under a limit, and the
 * burn-rate projection. All pure — no harness, no files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_BUFFER_RATIO, burnRate, estimateUnit, packPlan, percentile, unitTokens } from '../lib/budget.js'

const catalog = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'prices.json'), 'utf8'))

test('percentiles use the nearest rank and survive empty input', () => {
  assert.equal(percentile([3, 1, 2], 0.5), 2)
  assert.equal(percentile([1, 2, 3, 4], 0.9), 4)
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile(['x'], 0.5), null)
})

test('declared tokens win, history comes next, bootstrap is the honest fallback', () => {
  const declared = unitTokens({ label: 'a', tokens: { input: 1000, output: 100, cacheRead: 400 } }, [])
  assert.equal(declared.basis, 'declared')
  assert.equal(declared.uncachedInput, 1000)
  assert.equal(declared.cacheRead, 400)
  assert.equal(declared.output, 100)

  const history = [{ label: 'a', tokens: { uncachedInput: 100, cacheRead: 900, output: 50 } }]
  const fromHistory = unitTokens({ label: 'a' }, history)
  assert.equal(fromHistory.basis, 'history')
  assert.equal(fromHistory.uncachedInput, 100, 'the measured split survives, not a re-derived share')
  assert.equal(fromHistory.cacheRead, 900)
  assert.equal(fromHistory.samples, 1)

  const bootstrap = unitTokens({ label: 'other', scenario: 'lean' }, history)
  assert.equal(bootstrap.basis, 'bootstrap')
  assert.equal(bootstrap.scenario, 'lean')
  assert.equal(bootstrap.cacheRead, 0, 'a guess assumes no cache discount: budgets must not under-reserve')
  assert.ok(bootstrap.uncachedInput > 0)
})

test('an explicit cache share re-splits the input, and only when asked', () => {
  const catalogLocal = catalog
  const withoutShare = estimateUnit({
    label: 'x', tokens: { input: 1000000, output: 0 },
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }]
  }, [], catalogLocal)
  assert.equal(withoutShare.p50Usd, 0.15, 'all input billed at the input price')

  const withShare = estimateUnit({
    label: 'x', tokens: { input: 1000000, output: 0 }, cacheReadShare: 0.5,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }]
  }, [], catalogLocal)
  assert.ok(withShare.p50Usd < withoutShare.p50Usd, 'a declared cache share lowers the estimate')
  assert.equal(withShare.priced[0].tokens.cacheReadTokens, 500000)
})

test('a unit is priced on its preferred route with a P90 above the P50', () => {
  const estimate = estimateUnit({
    label: 'research',
    tokenFactor: 1,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }]
  }, [], catalog)
  assert.equal(estimate.preferred.model, 'deepseek-flash')
  assert.equal(estimate.p50Usd, estimate.preferred.usd)
  assert.ok(estimate.p90Usd > estimate.p50Usd, 'worst case exceeds expected')
  assert.equal(estimate.onDayOne, true, 'a bootstrap estimate says so')
})

test('an unpriceable route is reported instead of priced as zero', () => {
  const estimate = estimateUnit({ label: 'x', routes: [{ provider: 'nope', model: 'mystery' }] }, [], catalog)
  assert.equal(estimate.preferred, null)
  assert.equal(estimate.p50Usd, null)
  assert.equal(estimate.priced[0].reason, 'no-price')
})

test('packing holds back the reserve, packs by priority and defers what does not fit', () => {
  const units = [
    { label: 'cheap', priority: 1, scenario: 'lean', routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] },
    { label: 'expensive', priority: 5, scenario: 'deep', routes: [{ provider: 'moonshot', model: 'kimi-k3' }] }
  ]
  const roomy = packPlan({ units, budgetUsd: 100, catalog })
  assert.equal(roomy.reserveUsd, 100 * DEFAULT_BUFFER_RATIO)
  assert.equal(roomy.spendableUsd, 80)
  assert.deepEqual(roomy.planned.map((unit) => unit.label), ['expensive', 'cheap'], 'higher priority first')
  assert.equal(roomy.totals.fits, true)

  // A tight budget keeps the cheap unit and defers the expensive one.
  const tight = packPlan({ units, budgetUsd: 1, catalog })
  assert.deepEqual(tight.planned.map((unit) => unit.label), ['cheap'])
  assert.deepEqual(tight.deferred.map((unit) => unit.label), ['expensive'])
  assert.equal(tight.totals.fits, true, 'what fit does fit')
  assert.equal(tight.totals.coversEverything, false, 'but the plan does not cover everything')
  assert.equal(tight.deferred[0].reason, 'does-not-fit')

  // Nothing fits a budget below the cheapest unit's worst case.
  const impossible = packPlan({ units, budgetUsd: 0.001, catalog })
  assert.equal(impossible.planned.length, 0)
  assert.equal(impossible.deferred.length, 2)
  assert.equal(impossible.totals.fits, false)
})

test('packing a cheaper route when the preferred one does not fit', () => {
  const units = [{
    label: 'work',
    priority: 1,
    scenario: 'normal',
    routes: [
      { provider: 'moonshot', model: 'kimi-k3' },
      { provider: 'deepseek-official', model: 'deepseek-flash' }
    ]
  }]
  const plan = packPlan({ units, budgetUsd: 3, catalog })
  assert.equal(plan.planned.length, 1)
  assert.equal(plan.planned[0].route.model, 'deepseek-flash', 'the affordable route is chosen')
})

test('an unbounded plan is priced without faking a fit', () => {
  const plan = packPlan({ units: [{ label: 'a', scenario: 'lean' }], budgetUsd: null, catalog })
  assert.equal(plan.budgetUsd, null)
  assert.equal(plan.totals.fits, null)
  assert.equal(plan.planned.length, 1)
})

test('burn rate stays silent without data and warns when the limit is near', () => {
  assert.equal(burnRate([]).projection, 'not-enough-data')
  assert.equal(burnRate([{ ts: '2026-09-12T10:00:00Z', usd: 1 }]).projection, 'not-enough-data')

  const hot = burnRate([
    { ts: '2026-09-12T10:00:00Z', usd: 4 },
    { ts: '2026-09-12T11:00:00Z', usd: 4 }
  ], { budgetUsd: 10, spentUsd: 8, now: new Date('2026-09-12T11:00:00Z') })
  assert.equal(hot.usdPerHour, 8)
  assert.equal(hot.projection, 'warning')
  assert.equal(hot.remainingUsd, 2)

  const over = burnRate([
    { ts: '2026-09-12T10:00:00Z', usd: 6 },
    { ts: '2026-09-12T11:00:00Z', usd: 6 }
  ], { budgetUsd: 10, spentUsd: 12, now: new Date('2026-09-12T11:00:00Z') })
  assert.equal(over.projection, 'over')
})
