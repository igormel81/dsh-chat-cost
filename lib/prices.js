/**
 * Price resolution for dsh-chat-cost.
 *
 * Two sources, in this order:
 *  1. OFFICIAL — hand-checked provider prices that beat the catalog (DeepSeek
 *     publishes peak/off-peak tiers the catalog does not model, and its
 *     v4-pro entry in the catalog disagrees with the provider page).
 *  2. CATALOG  — the bundled models.dev snapshot (data/prices.json), which
 *     covers every model of the curated providers, cache read and cache write
 *     included.
 *
 * A model found in neither source resolves to null; callers must show "—"
 * rather than a fabricated number.
 */

import { readUsage } from './usage.js'

/** DeepSeek doubles prices in these UTC windows on weekdays (Mon-Fri). */
const DEEPSEEK_PEAK_WINDOWS = [[1, 4], [6, 10]]
const DEEPSEEK_PEAK_MULTIPLIER = 2

/** USD per 1M tokens, off-peak. Source: api-docs.deepseek.com/quick_start/pricing */
const DEEPSEEK_OFFICIAL = {
  'deepseek-flash': { input: 0.15, cacheRead: 0.003, output: 0.6 },
  'deepseek-v4-flash': { input: 0.15, cacheRead: 0.003, output: 0.6 },
  'deepseek-v4-flash-vision-exp': { input: 0.15, cacheRead: 0.003, output: 0.6 },
  'deepseek-v4-pro': { input: 0.66, cacheRead: 0.022, output: 1.98 },
  'deepseek-chat': { input: 0.28, cacheRead: 0.07, output: 0.42 },
  'deepseek-reasoner': { input: 0.55, cacheRead: 0.14, output: 2.19 }
}

/** Harness provider route -> catalog provider key. */
const ROUTES = {
  'deepseek-official': 'deepseek',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  moonshotai: 'moonshotai',
  kimi: 'moonshotai',
  openai: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  google: 'google',
  gemini: 'google',
  xai: 'xai',
  grok: 'xai',
  mistral: 'mistral'
}

/** Legacy or provider-prefixed ids -> canonical catalog / official id. */
const ALIASES = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-1-flash': 'deepseek-flash',
  'kimi-k3-thinking': 'kimi-k3',
  'kimi-k2.7-code-high-speed': 'kimi-k2.7-code-highspeed'
}

/** Catalog provider key -> the harness route a plan should name. */
const PROVIDER_ROUTES = {
  deepseek: 'deepseek-official',
  moonshotai: 'moonshot',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  mistral: 'mistral'
}

/** The harness route that reaches a catalog provider. */
export function routeForProvider(provider) {
  if (typeof provider !== 'string') return null
  return PROVIDER_ROUTES[provider] ?? provider
}

/** True inside a DeepSeek peak window (weekdays, UTC). */
export function isPeakUtc(date) {
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return DEEPSEEK_PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/** Catalog provider key for a harness provider route, or null when unknown. */
export function providerKey(route) {
  if (typeof route !== 'string') return null
  return ROUTES[route.toLowerCase()] ?? null
}

/**
 * Canonical model id: lowercased, provider prefix and batch/date suffixes
 * stripped, known aliases folded. Harvest-style ids such as
 * `deepseek/deepseek-v4.1-flash` or `openai/gpt-5-nano:batch` become the ids the
 * catalog and the official tables use.
 */
export function canonicalModelId(model) {
  if (typeof model !== 'string') return ''
  let id = model.trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  const colon = id.indexOf(':')
  if (colon !== -1) id = id.slice(0, colon)
  return ALIASES[id] ?? id
}

/**
 * Resolve one price.
 * @returns {{ source: 'official'|'catalog', provider: string, model: string, cost: object } | null}
 */
export function resolvePrice(catalog, providerRoute, model) {
  const key = providerKey(providerRoute)
  const id = canonicalModelId(model)
  if (id === '') return null

  if (key === 'deepseek') {
    const official = DEEPSEEK_OFFICIAL[id]
    if (official !== undefined) {
      return { source: 'official', provider: key, model: id, cost: { ...official, peakMultiplier: DEEPSEEK_PEAK_MULTIPLIER } }
    }
  }

  const entry = catalog?.providers?.[key]?.models?.[id]
  if (entry?.cost === undefined || entry.cost === null) return null
  const cost = entry.cost
  return {
    source: 'catalog',
    provider: key,
    model: id,
    cost: {
      input: typeof cost.input === 'number' ? cost.input : null,
      cacheRead: typeof cost.cacheRead === 'number' ? cost.cacheRead : null,
      cacheWrite: typeof cost.cacheWrite === 'number' ? cost.cacheWrite : null,
      output: typeof cost.output === 'number' ? cost.output : null,
      peakMultiplier: 1
    }
  }
}

/**
 * Price four usage buckets.
 *
 * Rules that follow each provider's own billing:
 *  - cache writes bill at the cache-write price when the provider publishes one
 *    (Anthropic, OpenAI), otherwise at the input price (DeepSeek has no fee);
 *  - an unpublished cache-read price falls back to the input price, which is an
 *    upper bound;
 *  - a missing output or input price makes the whole figure null.
 */
export function priceUsage(price, usage, options = {}) {
  const cost = price?.cost
  if (cost === undefined || cost === null) return null
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return null

  const peak = options.peak === true && typeof cost.peakMultiplier === 'number' ? cost.peakMultiplier : 1
  const buckets = readUsage(usage)
  const uncachedInput = buckets.uncachedInput
  const cacheReadTokens = buckets.cacheRead
  const cacheWriteTokens = buckets.cacheWrite
  const outputTokens = buckets.output

  const cacheReadRate = typeof cost.cacheRead === 'number' ? cost.cacheRead : cost.input
  const cacheWriteRate = typeof cost.cacheWrite === 'number' ? cost.cacheWrite : cost.input

  const inputCost = ((uncachedInput * cost.input) + (cacheReadTokens * cacheReadRate) + (cacheWriteTokens * cacheWriteRate)) * peak
  const outputCost = outputTokens * cost.output * peak

  return {
    usd: (inputCost + outputCost) / 1e6,
    peakMultiplier: peak,
    tokens: uncachedInput + cacheReadTokens + cacheWriteTokens + outputTokens,
    breakdown: { uncachedInput, cacheReadTokens, cacheWriteTokens, outputTokens }
  }
}

export const __internals = { DEEPSEEK_OFFICIAL, DEEPSEEK_PEAK_WINDOWS, ROUTES, ALIASES }
