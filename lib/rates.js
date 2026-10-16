/**
 * The DeepSeek price table, in RMB, refreshed from the vendor's own page.
 *
 * Why this module exists: the plugin used to price from a bundled models.dev
 * snapshot, which quotes USD. DeepSeek publishes two separate rate cards for the
 * same models — a CNY one on the Chinese page and a USD one on the English page —
 * and the account is billed in CNY (the balance API reports `"currency":"CNY"`).
 * Those two cards are not a conversion of one another: flash divides by ~6.67 and
 * pro by ~6.82, each rounded. So the only honest CNY figure is DeepSeek's own CNY
 * card, which is what this module reads. Only DeepSeek is priced; every other
 * route has no price, and the readout says so rather than guessing.
 *
 * The refreshed table is cached on disk next to the plugin, so a restart keeps the
 * last good numbers instead of falling back to the seed.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** DeepSeek's Chinese rate card: the source of every figure this module reports. */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/**
 * How old a cached table may be before the startup refresh replaces it.
 *
 * The host fetches once per launch (see index.js), and this is the gate that makes
 * that cheap: a table fetched moments ago — for example because a second window
 * started the host twice in a row, or because `--fetch` was just run — is reused
 * instead of being re-requested. It is not a schedule; nothing refreshes on a
 * timer.
 */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** How long to wait for the page before giving up on this attempt. */
const FETCH_TIMEOUT_MS = 20_000

/**
 * Peak windows in Beijing time (UTC+8), weekdays only, excluding Chinese public
 * holidays. The Chinese page states "周一至周五（不含中国法定节假日）9:00 - 12:00、
 * 14:00 - 18:00"; the English page states the same windows as 01:00-04:00 and
 * 06:00-10:00 UTC.
 *
 * Public holidays are deliberately NOT modelled. The page excludes them, so a
 * holiday is priced at the peak rate here and the figure reads high; that is the
 * documented limitation rather than a silent one, and it is the reason the rate
 * table alone cannot make the total agree with an invoice to the cent.
 */
export const PEAK_WINDOWS_BEIJING = [[9, 12], [14, 18]]

/** Off-peak is exactly half of peak on DeepSeek's own card. */
export const PEAK_MULTIPLIER = 2

/**
 * The seed table, in RMB per 1M tokens, off-peak.
 *
 * Used only when no refresh has ever succeeded: the first run before the first
 * fetch, and a fetch that fails while the cache is missing. Its `asOf` and
 * `source` travel with it, so a figure priced from the seed can be told apart
 * from one priced from a fetched table.
 */
export const SEED = {
  asOf: '2026-10-11',
  source: 'seed',
  // The same shape the parser produces: a model carries its rates under `cost`.
  // Flat rates here would make the fallback table readable by `table()` but not by
  // `catalog()`, so a first run with no cache reported "price table unknown" while
  // holding a perfectly good price.
  models: {
    'deepseek-flash': {
      name: 'deepseek-flash',
      cost: { input: 1, cacheRead: 0.02, cacheWrite: null, output: 4, currency: 'CNY', unit: 'per 1M tokens', basis: 'off-peak' }
    },
    'deepseek-v4-pro': {
      name: 'deepseek-v4-pro',
      cost: { input: 4.5, cacheRead: 0.15, cacheWrite: null, output: 13.5, currency: 'CNY', unit: 'per 1M tokens', basis: 'off-peak' }
    }
  }
}

/**
 * Legacy model names DeepSeek still accepts and bills at the Flash rate, per the
 * page: "旧模型名 deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用，但对应
 * 模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费。"
 */
export const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-1-flash': 'deepseek-flash'
}

/** Harness provider routes that reach DeepSeek's own API. */
const DEEPSEEK_ROUTES = ['deepseek', 'deepseek-official']

/**
 * Where the fetched table is cached: the plugin's own `data/` directory.
 *
 * Resolved from this module's own URL, never from the process working directory,
 * so the cache lands in the installed plugin regardless of what directory the host
 * was started in, which project a session belongs to, or where the app is run from.
 */
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'rates-cny.json')

// ---------------------------------------------------------------------- parsing

const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Parse the Chinese pricing page into a rate table.
 *
 * A refusal is the point of this function. A parser that returned a half-read
 * table would price real money from whatever it happened to find, so every
 * structural expectation is checked and a page whose markup no longer matches
 * yields no table at all — the caller then keeps the previous table and says it is
 * stale, which is a smaller and more truthful failure than a wrong number.
 *
 * @param {string} html the pricing page
 * @returns {{ ok: true, models: Record<string, object>, modelNames: string[] } | { ok: false, reason: string }}
 */
export function parsePricingPage(html) {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, reason: 'empty-page' }

  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
  if (rows.length === 0) return { ok: false, reason: 'no-table-rows' }
  const cellsOf = (row) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => textOf(m[1]))

  /**
   * The two model columns, read from the row that leads with the canonical model
   * name. Only the first pricing cell counts: the second is the USD card, which is
   * a separate rate card and not this table's business.
   *
   * The cells read "deepseek-flash (1)" and "deepseek-v4-pro" — the footnote marker
   * is part of the markup of every labelled row, so it is stripped rather than
   * treated as part of the name.
   */
  let modelNames = null
  for (const row of rows) {
    const cells = cellsOf(row)
    if (cells.length < 3) continue
    const columns = cells.slice(1, 3).map((cell) => cell.replace(/[（(]\d+[)）]/g, ' ').trim().toLowerCase())
    if (columns.length < 2) continue
    if (columns.every((name) => /^deepseek-[a-z0-9.-]+$/.test(name) === false)) continue
    if (columns.some((name) => /^deepseek-[a-z0-9.-]+$/.test(name) === false)) continue
    modelNames = columns
    break
  }
  if (modelNames === null || modelNames.length < 2) return { ok: false, reason: 'model-row-not-found' }

  /**
   * The off-peak CNY values of a row whose whole text contains every needle.
   *
   * Matching the whole row rather than one cell matters: the cache-hit row is
   * prefixed with a "价格 (2)" cell that the other pricing rows do not carry, so a
   * reader anchored to a fixed cell index breaks on exactly the row it is looking
   * for. The period cell is located by its label instead, and the two model columns
   * are the cells immediately after it.
   */
  const rowValues = (...needles) => {
    for (const row of rows) {
      const cells = cellsOf(row)
      if (cells.length < 3) continue
      if (needles.every((n) => row.includes(n)) === false) continue
      const periodIndex = cells.findIndex((cell) => cell.includes('空闲时段'))
      if (periodIndex === -1) return { ok: false, reason: `no-off-peak-cell:${needles.join('+')}` }
      const read = (cell) => {
        const match = /([0-9]+(?:\.[0-9]+)?)\s*元/.exec(cell ?? '')
        return match === null ? null : Number(match[1])
      }
      const values = [read(cells[periodIndex + 1]), read(cells[periodIndex + 2])]
      if (values.some((v) => v === null || Number.isFinite(v) === false || v <= 0)) {
        return { ok: false, reason: `unreadable-value:${needles.join('+')}` }
      }
      return { ok: true, values }
    }
    return { ok: false, reason: `row-not-found:${needles.join('+')}` }
  }

  const hit = rowValues('缓存命中')
  if (hit.ok === false) return { ok: false, reason: hit.reason }
  const miss = rowValues('缓存未命中')
  if (miss.ok === false) return { ok: false, reason: miss.reason }
  const output = rowValues('百万tokens输出')
  if (output.ok === false) return { ok: false, reason: output.reason }

  // Sanity: a cache hit is cheaper than a cache miss — equal is already anomalous,
  // because being cheaper is the entire point of a cache — and output cannot be
  // cheaper than a cache miss. A page that violates either is not the page this
  // parser was written for, whatever its shape looks like.
  for (let i = 0; i < modelNames.length; i += 1) {
    if (hit.values[i] >= miss.values[i]) return { ok: false, reason: 'cache-hit-above-miss' }
    if (output.values[i] < miss.values[i]) return { ok: false, reason: 'output-below-input' }
  }

  const models = {}
  for (let i = 0; i < modelNames.length; i += 1) {
    models[modelNames[i]] = {
      name: modelNames[i],
      cost: {
        input: miss.values[i],
        cacheRead: hit.values[i],
        cacheWrite: null,
        output: output.values[i],
        currency: 'CNY',
        unit: 'per 1M tokens',
        basis: 'off-peak'
      }
    }
  }
  return { ok: true, models, modelNames }
}

// --------------------------------------------------------------------- the table

let state = null

function seedState(source = 'seed', asOf = SEED.asOf) {
  return {
    asOf,
    source,
    fetchedAt: null,
    models: JSON.parse(JSON.stringify(SEED.models))
  }
}

function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    const accepted = validateTable(parsed)
    return accepted.ok ? { ok: true, table: accepted.table } : { ok: false, reason: accepted.reason }
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'no-cache' : 'cache-unreadable' }
  }
}

/**
 * A cached or fetched table is only accepted when it carries a usable DeepSeek
 * model with all three rates. A truncated file must not price anything.
 */
export function validateTable(value) {
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'not-an-object' }
  const models = value.models
  if (models === null || typeof models !== 'object') return { ok: false, reason: 'no-models' }
  const ids = Object.keys(models)
  if (ids.length === 0) return { ok: false, reason: 'no-models' }
  for (const id of ids) {
    const cost = models[id]?.cost
    if (cost === null || typeof cost !== 'object') return { ok: false, reason: `no-cost:${id}` }
    for (const field of ['input', 'cacheRead', 'output']) {
      const rate = cost[field]
      if (rate !== undefined && rate !== null && (typeof rate !== 'number' || Number.isFinite(rate) === false || rate <= 0)) {
        return { ok: false, reason: `bad-rate:${id}.${field}` }
      }
    }
    if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return { ok: false, reason: `incomplete:${id}` }
  }
  return {
    ok: true,
    table: {
      asOf: typeof value.asOf === 'string' ? value.asOf : null,
      source: typeof value.source === 'string' ? value.source : 'fetched',
      fetchedAt: typeof value.fetchedAt === 'number' ? value.fetchedAt : null,
      models
    }
  }
}

function writeCache(table) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    const temporary = `${CACHE_FILE}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
    renameSync(temporary, CACHE_FILE)
    return true
  } catch {
    return false
  }
}

/** The current table, loading the cache on first use. Synchronous by design. */
export function table() {
  if (state !== null) return state
  const cached = readCache()
  if (cached.ok) {
    state = cached.table
    return state
  }
  state = seedState(cached.reason === 'no-cache' ? 'seed' : 'seed')
  state.reason = cached.reason
  return state
}

/** True when the current table is older than the refresh interval. */
export function isStale(now = Date.now()) {
  const current = table()
  if (typeof current.fetchedAt !== 'number') return true
  return now - current.fetchedAt >= REFRESH_INTERVAL_MS
}

let inFlight = null

/**
 * Fetch and parse the page once, then swap the table in.
 *
 * Concurrent callers share one request. A parse failure or a network failure keeps
 * whatever table was already in place — a stale correct number beats a fresh
 * absent one — and reports why, so the readout can say the table is stale.
 *
 * @returns {Promise<{ ok: boolean, changed?: boolean, reason?: string, table: object }>}
 */
export async function refresh({ now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    try {
      if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch', table: table() }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      let html
      try {
        const response = await fetchImpl(PRICING_URL, {
          signal: controller.signal,
          headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' }
        })
        if (response.ok === false) return { ok: false, reason: `http-${response.status}`, table: table() }
        html = await response.text()
      } finally {
        clearTimeout(timer)
      }

      const parsed = parsePricingPage(html)
      if (parsed.ok === false) return { ok: false, reason: parsed.reason, table: table() }

      const next = {
        asOf: new Date(now).toISOString().slice(0, 10),
        source: PRICING_URL,
        fetchedAt: now,
        models: parsed.models
      }
      const accepted = validateTable(next)
      if (accepted.ok === false) return { ok: false, reason: accepted.reason, table: table() }

      state = accepted.table
      writeCache(state)
      return { ok: true, changed: true, table: state }
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : (error?.message ?? 'fetch-failed')
      return { ok: false, reason, table: table() }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * Refresh in the background when the table is stale, without ever blocking a
 * caller. Called from the summary path, which is polled while a chat is open, so
 * the table follows the vendor's page without a scheduler of its own.
 */
export function refreshIfStale(options = {}) {
  if (isStale(options.now) === false) return null
  const promise = refresh(options)
  // The caller does not await this; the next poll sees the new table.
  promise.catch(() => {})
  return promise
}

/** Test seam: drop the in-memory table so the next call re-reads the cache. */
export function __reset() {
  state = null
  inFlight = null
}

// ------------------------------------------------------------------ the catalog

/** Canonical model id: lowercased, provider prefix and date/batch suffixes stripped. */
export function canonicalModelId(model) {
  if (typeof model !== 'string') return ''
  let id = model.trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  const colon = id.indexOf(':')
  if (colon !== -1) id = id.slice(0, colon)
  return ALIASES[id] ?? id
}

/** Catalog provider key for a harness provider route, or null when not DeepSeek. */
export function providerKey(route) {
  if (typeof route !== 'string') return null
  return DEEPSEEK_ROUTES.includes(route.trim().toLowerCase()) ? 'deepseek' : null
}

/** The harness route that reaches a catalog provider. Only one provider is priced. */
export function routeForProvider(provider) {
  if (typeof provider !== 'string') return null
  return provider.trim().toLowerCase() === 'deepseek' ? 'deepseek-official' : provider
}

/** True when a route is the one provider this module has prices for. */
export function hasPriceTable(route) {
  return providerKey(route) !== null
}

/**
 * Resolve one rate from the table.
 *
 * Only DeepSeek resolves. There is deliberately no fallback to another vendor's
 * numbers and no conversion from a foreign-currency card: a route outside this
 * table has no price, and `null` is how that is said. The caller renders it as
 * "price table unknown", which is a smaller claim than a guessed tariff.
 *
 * @param {object} tableSource the catalog from {@link catalog}
 * @param {string} providerRoute harness route, e.g. `deepseek-official`
 * @param {string} model model id, e.g. `deepseek-flash`
 * @returns {{ source: 'table', provider: string, model: string, currency: string, cost: object } | null}
 */
export function resolvePrice(tableSource, providerRoute, model) {
  const key = providerKey(providerRoute)
  if (key === null) return null
  const id = canonicalModelId(model)
  if (id === '') return null
  const cost = tableSource?.providers?.[key]?.models?.[id]?.cost
  if (cost === undefined || cost === null) return null
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return null
  return {
    source: 'table',
    provider: key,
    model: id,
    currency: 'CNY',
    cost: {
      input: cost.input,
      cacheRead: typeof cost.cacheRead === 'number' ? cost.cacheRead : null,
      cacheWrite: typeof cost.cacheWrite === 'number' ? cost.cacheWrite : null,
      output: cost.output,
      peakMultiplier: PEAK_MULTIPLIER
    }
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Price four usage buckets, in RMB.
 *
 * DeepSeek publishes no separate cache-write fee, so a cache write bills at the
 * input rate; a missing cache-read rate falls back to the input rate, which is an
 * upper bound rather than an understatement. The peak multiplier applies only when
 * the caller says the interval fell inside a peak window.
 *
 * @param {object} price a value from {@link resolvePrice}
 * @param {object} usage the four token buckets, in either naming
 * @param {{ peak?: boolean }} [options]
 */
export function priceUsage(price, usage, options = {}) {
  const cost = price?.cost
  if (cost === undefined || cost === null) return null
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return null

  const peak = options.peak === true && typeof cost.peakMultiplier === 'number' ? cost.peakMultiplier : 1
  const buckets = {
    uncachedInput: numberOrZero(usage?.uncachedInput ?? usage?.uncachedInputTokens),
    cacheRead: numberOrZero(usage?.cacheRead ?? usage?.cacheReadTokens),
    cacheWrite: numberOrZero(usage?.cacheWrite ?? usage?.cacheWriteTokens),
    output: numberOrZero(usage?.output ?? usage?.outputTokens)
  }
  const cacheReadRate = typeof cost.cacheRead === 'number' ? cost.cacheRead : cost.input
  const cacheWriteRate = typeof cost.cacheWrite === 'number' ? cost.cacheWrite : cost.input

  const inputCost = ((buckets.uncachedInput * cost.input) + (buckets.cacheRead * cacheReadRate) + (buckets.cacheWrite * cacheWriteRate)) * peak
  const outputCost = buckets.output * cost.output * peak

  return {
    usd: (inputCost + outputCost) / 1e6,
    currency: 'CNY',
    peakMultiplier: peak,
    tokens: buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output,
    breakdown: buckets
  }
}

/**
 * The catalog in the shape the rest of the plugin already consumes.
 *
 * Keeping this shape is deliberate: `tools.js`, `budget.js` and `scenarios.js`
 * walk `providers[key].models[id].cost`, and rebuilding it costs nothing while
 * removing the risk of a half-migrated reader. What changed is that the only
 * provider in it is DeepSeek, and its rates are CNY.
 */
export function catalog(now = Date.now()) {
  const current = table()
  const models = {}
  for (const [id, entry] of Object.entries(current.models)) {
    models[id] = { name: entry.name ?? id, cost: { ...entry.cost } }
  }
  return {
    currency: 'CNY',
    source: current.source,
    asOf: current.asOf,
    fetchedAt: current.fetchedAt,
    stale: isStale(now),
    providers: { deepseek: { name: 'DeepSeek', currency: 'CNY', models } }
  }
}

/** True inside a DeepSeek peak window (Beijing time, weekdays). */
export function isPeak(date) {
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours() + 8
  const beijingHour = hour % 24
  return PEAK_WINDOWS_BEIJING.some(([from, to]) => beijingHour >= from && beijingHour < to)
}

/** The table's own provenance, for the readout's tooltip. */
export function provenance() {
  const current = table()
  return {
    source: current.source,
    asOf: current.asOf,
    fetchedAt: current.fetchedAt,
    stale: isStale(),
    models: Object.keys(current.models),
    reason: current.reason ?? null
  }
}

/**
 * A stable fingerprint of the rates themselves: the currency plus a hash of every
 * model's three prices. Two tables with the same fingerprint bill identically, so
 * this is what decides whether figures from them may be added together.
 *
 * @param {object} value a rate table in the shape `table()` returns
 * @returns {string|null} e.g. `CNY:5968f96a`, or null when nothing is priced
 */
export function rateFingerprint(value) {
  const models = value?.models ?? {}
  const ids = Object.keys(models).sort()
  if (ids.length === 0) return null
  const shape = ids.map((id) => {
    const cost = models[id]?.cost ?? {}
    return `${id}=${cost.input ?? ''},${cost.cacheRead ?? ''},${cost.output ?? ''}`
  }).join(';')
  let hash = 0
  for (let index = 0; index < shape.length; index += 1) {
    hash = (hash * 31 + shape.charCodeAt(index)) >>> 0
  }
  const currency = models[ids[0]]?.cost?.currency ?? 'CNY'
  return `${currency}:${hash.toString(16).padStart(8, '0')}`
}

/**
 * The tariff epoch: an identity for the rate table a figure was priced in.
 *
 * Two figures are only additive when they were priced in the same epoch, so this
 * stamp travels with every ledger record. It changes when the currency changes and
 * when any rate changes, because a cumulative built from rates that have since
 * moved is not a total in the new table either.
 *
 * It deliberately does NOT include the date the table was taken. The fetch runs
 * once per host launch, so a date in the epoch would make a fresh fetch of
 * unchanged rates look like a new table: every running session would discard its
 * cumulative and re-price its whole interval, on a schedule, while the prices
 * never moved. The fingerprint already identifies the rates, so the epoch is a
 * property of the prices rather than of when we last looked at them. The fetch
 * date is still reported — `provenance().asOf` — because it answers a different
 * question.
 *
 * @returns {string|null} e.g. `CNY:5968f96a`, or null with no table
 */
export function tariff() {
  return rateFingerprint(table())
}

export { CACHE_FILE }
