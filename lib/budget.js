/**
 * Budget arithmetic for the plan: estimate work units, pack them under a money
 * limit, and read the burn rate off the cost log.
 *
 * Two honesty rules shape this module:
 *  1. Estimates are ranges, never a single number. A unit priced from declared
 *     tokens is exact; anything estimated from history or defaults carries a
 *     P50 and a P90.
 *  2. Every estimate names its basis (`declared` | `history` | `bootstrap`), so
 *     a guess is never mistaken for a measurement.
 */
import { priceUsage, resolvePrice } from './prices.js'

/** A budget keeps this share aside for rework; a plan without a buffer is a lie. */
export const DEFAULT_BUFFER_RATIO = 0.2

/** How far the P90 sits above the P50 when nothing better is known. */
export const DEFAULT_UNCERTAINTY = 2

/**
 * Cache-hit share used ONLY when a unit asks for one. The default is no assumed
 * cache discount: an estimate that quietly assumes cache hits under-reserves the
 * budget, which is the wrong direction for a limit.
 */
export const DEFAULT_CACHE_READ_SHARE = 0

/**
 * Bootstrap token profiles per unit scenario, used only until history exists.
 * Deliberately coarse and documented as such in the tool output.
 */
export const SCENARIOS = {
  lean: { input: 60000, output: 8000 },
  normal: { input: 300000, output: 40000 },
  deep: { input: 1200000, output: 150000 }
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function rate(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}

/** Percentile over a sorted numeric array (nearest-rank, no interpolation). */
export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/**
 * Token profile for one unit: declared numbers win, then the median of matching
 * history, then the scenario default.
 * @returns {{ input: number, output: number, basis: 'declared'|'history'|'bootstrap', scenario: string, samples: number }}
 */
export function unitTokens(unit, history = []) {
  const scenario = typeof unit?.scenario === 'string' && SCENARIOS[unit.scenario] !== undefined ? unit.scenario : 'normal'
  const tokens = unit?.tokens
  if (tokens !== null && typeof tokens === 'object') {
    const input = positive(tokens.input, 0)
    const output = positive(tokens.output, 0)
    const cacheRead = positive(tokens.cacheRead, 0)
    if (input > 0 || output > 0 || cacheRead > 0) {
      return { uncachedInput: input, cacheRead, output, basis: 'declared', scenario, samples: 0 }
    }
  }
  const matching = history.filter((sample) => sample.label === unit?.label)
  if (matching.length > 0) {
    // Measure the real split rather than re-deriving it from a share.
    const uncachedInput = percentile(matching.map((sample) => sample.tokens?.uncachedInput), 0.5)
    const cacheRead = percentile(matching.map((sample) => sample.tokens?.cacheRead), 0.5)
    const output = percentile(matching.map((sample) => sample.tokens?.output), 0.5)
    return {
      uncachedInput: Math.max(0, uncachedInput ?? 0),
      cacheRead: Math.max(0, cacheRead ?? 0),
      output: Math.max(0, output ?? 0),
      basis: 'history',
      scenario,
      samples: matching.length
    }
  }
  const profile = SCENARIOS[scenario]
  return { uncachedInput: profile.input, cacheRead: 0, output: profile.output, basis: 'bootstrap', scenario, samples: 0 }
}

/** Price one unit on one route; `tokenFactor` models a stronger route needing fewer passes. */
export function estimateUnit(unit, history, catalog) {
  const profile = unitTokens(unit, history)
  const uncertainty = positive(unit?.uncertainty, DEFAULT_UNCERTAINTY)
  const factor = positive(unit?.tokenFactor, 1)

  // An explicit cacheReadShare overrides the measured or declared split; without
  // one, declared tokens count as uncached input.
  const share = typeof unit?.cacheReadShare === 'number' && Number.isFinite(unit.cacheReadShare) && unit.cacheReadShare >= 0 && unit.cacheReadShare <= 1
    ? unit.cacheReadShare
    : null
  const totalInput = profile.uncachedInput + profile.cacheRead
  const split = share === null
    ? { uncachedInput: profile.uncachedInput, cacheRead: profile.cacheRead }
    : { uncachedInput: totalInput * (1 - share), cacheRead: totalInput * share }

  const routes = Array.isArray(unit?.routes) && unit.routes.length > 0 ? unit.routes : [{}]
  const priced = []
  for (const route of routes) {
    const price = resolvePrice(catalog, route?.provider, route?.model)
    if (price === null) {
      priced.push({ provider: route?.provider ?? null, model: route?.model ?? null, source: 'none', usd: null, reason: 'no-price' })
      continue
    }
    const usage = {
      uncachedInputTokens: Math.round(split.uncachedInput * factor),
      cacheReadTokens: Math.round(split.cacheRead * factor),
      cacheWriteTokens: 0,
      outputTokens: Math.round(profile.output * factor)
    }
    const off = priceUsage(price, usage, { peak: false })
    const peak = priceUsage(price, usage, { peak: true })
    priced.push({
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      source: price.source,
      usd: off?.usd ?? null,
      usdPeak: peak?.usd ?? null,
      tokens: usage
    })
  }

  const usable = priced.filter((entry) => entry.usd !== null)
  const cheapest = usable.length > 0 ? usable.reduce((best, entry) => (entry.usd < best.usd ? entry : best)) : null
  const preferred = usable.length > 0 ? usable[0] : null
  const spread = typeof unit?.spread === 'number' && unit.spread > 0 ? unit.spread : 1

  return {
    label: unit?.label ?? null,
    title: unit?.title ?? null,
    priority: typeof unit?.priority === 'number' ? unit.priority : 0,
    critical: unit?.critical === true,
    needs: unit?.needs ?? null,
    scenario: unit?.scenario ?? null,
    profile,
    priced,
    preferred,
    cheapest,
    onDayOne: profile.basis === 'bootstrap',
    p50Usd: preferred === null ? null : preferred.usd * spread,
    p90Usd: preferred === null ? null : preferred.usd * spread * uncertainty,
    cheapestP90Usd: cheapest === null ? null : cheapest.usd * spread * uncertainty
  }
}

/**
 * Pack units under a money limit, highest priority first, choosing for each the
 * cheapest route whose P90 still fits the remaining budget after the reserve.
 */
export function packPlan({ units, budgetUsd, bufferRatio = DEFAULT_BUFFER_RATIO, history = [], catalog }) {
  const reserve = typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) ? budgetUsd * rate(bufferRatio, DEFAULT_BUFFER_RATIO) : 0
  const spendable = typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) ? budgetUsd - reserve : null

  const estimates = units.map((unit) => estimateUnit(unit, history, catalog))
  const ordered = [...estimates].sort((a, b) => b.priority - a.priority)

  const planned = []
  const deferred = []
  let committedP50 = 0
  let committedP90 = 0

  for (const estimate of ordered) {
    const affordable = spendable === null ? estimate.preferred : (estimate.cheapest !== null && committedP90 + estimate.cheapestP90Usd <= spendable ? estimate.cheapest : null)
    const decision = spendable === null ? 'unbounded' : (affordable === null ? 'deferred' : 'fit')
    if (decision === 'deferred') {
      deferred.push({ label: estimate.label, title: estimate.title, reason: 'does-not-fit', p90Usd: estimate.p90Usd, cheapestP90Usd: estimate.cheapestP90Usd })
      continue
    }
    const chosen = affordable === null ? estimate.preferred : affordable
    committedP50 += (chosen === estimate.cheapest ? estimate.cheapest?.usd ?? 0 : estimate.p50Usd ?? 0)
    committedP90 += chosen === estimate.cheapest ? estimate.cheapestP90Usd ?? 0 : estimate.p90Usd ?? 0
    planned.push({
      label: estimate.label,
      title: estimate.title,
      priority: estimate.priority,
      critical: estimate.critical,
      needs: estimate.needs,
      scenario: estimate.scenario,
      route: chosen === null ? null : { provider: chosen.provider, model: chosen.model },
      pricingSource: chosen === null ? 'none' : chosen.source,
      basis: estimate.profile.basis,
      onDayOne: estimate.onDayOne,
      p50Usd: chosen === null ? null : chosen.usd,
      p90Usd: chosen === null ? null : chosen.usd * (estimate.p90Usd !== null && estimate.p50Usd ? estimate.p90Usd / estimate.p50Usd : DEFAULT_UNCERTAINTY),
      tokens: chosen === null ? null : chosen.tokens
    })
  }

  return {
    budgetUsd: typeof budgetUsd === 'number' ? budgetUsd : null,
    reserveUsd: typeof budgetUsd === 'number' ? reserve : null,
    spendableUsd: spendable,
    planned,
    deferred,
    totals: {
      p50Usd: planned.reduce((sum, unit) => sum + (unit.p50Usd ?? 0), 0),
      p90Usd: planned.reduce((sum, unit) => sum + (unit.p90Usd ?? 0), 0),
      deferredCount: deferred.length,
      /**
       * P90 of everything that fit stays inside the spendable part of the budget.
       * An empty plan does not "fit": nothing was affordable at all.
       */
      fits: spendable === null ? null : (planned.length > 0 && planned.reduce((sum, unit) => sum + (unit.p90Usd ?? 0), 0) <= spendable),
      /** True only when nothing had to be deferred: the plan covers every unit. */
      coversEverything: deferred.length === 0
    }
  }
}

/**
 * Burn rate and projection from dated spend samples.
 * @param {Array<{ts: string, usd: number}>} samples
 * @param {{ budgetUsd?: number|null, spentUsd?: number, now?: Date }} options
 */
export function burnRate(samples, options = {}) {
  const now = options.now ?? new Date()
  const dated = samples
    .map((sample) => ({ at: Date.parse(sample.ts), usd: typeof sample.usd === 'number' ? sample.usd : 0 }))
    .filter((sample) => Number.isFinite(sample.at))
    .sort((a, b) => a.at - b.at)

  if (dated.length < 2) {
    return { usdPerHour: null, samples: dated.length, spentUsd: options.spentUsd ?? 0, remainingUsd: null, projection: 'not-enough-data' }
  }

  const first = dated[0]
  const last = dated[dated.length - 1]
  const hours = Math.max((last.at - first.at) / 3600000, 1 / 60)
  const usdPerHour = dated.reduce((sum, sample) => sum + sample.usd, 0) / hours

  const spent = options.spentUsd ?? dated.reduce((sum, sample) => sum + sample.usd, 0)
  const budget = typeof options.budgetUsd === 'number' ? options.budgetUsd : null
  if (budget === null || usdPerHour <= 0) {
    return { usdPerHour, samples: dated.length, spentUsd: spent, remainingUsd: null, projection: 'no-budget' }
  }
  const remaining = budget - spent
  const hoursLeft = remaining / usdPerHour
  return {
    usdPerHour,
    samples: dated.length,
    spentUsd: spent,
    remainingUsd: remaining,
    hoursToLimit: hoursLeft,
    exhaustsAt: new Date(now.getTime() + hoursLeft * 3600000).toISOString(),
    projection: remaining <= 0 ? 'over' : (hoursLeft < 1 ? 'warning' : 'ok')
  }
}
