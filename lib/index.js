/**
 * dsh-chat-cost — Host half.
 *
 * Walks the session tree rooted at the requesting session (the chat plus every
 * subagent session it spawned), prices each session's provider-reported usage in
 * RMB from DeepSeek's own rate card, appends a JSONL cost log inside the project
 * folder, and serves the summary the client renders.
 *
 * Data sources, all first-party:
 *  - the tree        -> ctx.sessionQuery.traceSession() when mounted (live and
 *                       persisted sessions alike), else ctx.sessions.list();
 *  - token usage     -> ctx.sessionProjections.stateOf(session, 'tokenUsage'),
 *                       the provider-reported four buckets;
 *  - provider/model  -> the newest `request/header` event of that session, or the
 *                       modelSelection projection when the log carries none;
 *  - project folder  -> the root session's durable header `cwd`;
 *  - prices          -> DeepSeek's Chinese rate card, fetched once per host launch
 *                       and cached beside the plugin (rates.js).
 *
 * Only live sessions expose a usage state; a persisted-only session is reported
 * without a price rather than estimated, and the tooltip names it. Models outside
 * DeepSeek's table have no price at all, and the readout says the table is unknown
 * instead of applying another vendor's numbers to them.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { UNLABELED_LABEL, actualsByLabel, appendCostLog, costRecord, ensureGitignore, ledgerBase, readLedger, spendSamples, subtractUsage, summarizeTree, tokens, totalTokens } from './log.js'
import { createLocks } from './locks.js'
import { burnRate } from './budget.js'
import { readBudget, readPlan } from './plan.js'
import { isPeak, priceUsage, refreshIfStale, resolvePrice, tariff as currentTariff, catalog as buildCatalog, provenance } from './rates.js'
import { buildTools } from './tools.js'
import { turnUsage, unbilledSearchCalls } from './turns.js'

export const name = 'dsh-chat-cost'
export const inject = ['webServer']

const SUMMARY_PATH = '/api/plugins/dsh-chat-cost/summary'
/** Coalescing window for turn-driven flushes of one session tree. */
const FLUSH_DEBOUNCE_MS = 1500
const QUERY_TIMEOUT_MS = 5000
/** Bytes of the ledger tail the summary reads; the tools still read everything. */
const DEFAULT_LEDGER_TAIL_BYTES = 2 * 1024 * 1024
/** Turns carried in a summary: enough for the transcript, bounded on purpose. */
const MAX_TURNS = 50
const PLUGIN_VERSION = '0.6.11'

let catalog = null

/**
 * The price table, in the catalog shape the rest of the plugin reads.
 *
 * The table is DeepSeek's own RMB rate card, fetched from the vendor's page and
 * cached on disk (see rates.js). Only DeepSeek is priced: a route with no table
 * resolves to no price, and the readout says the table is unknown rather than
 * inventing a figure. The object is rebuilt on each call rather than cached for
 * the process lifetime, so a completed background refresh is visible to the very
 * next summary poll.
 */
function priceCatalog() {
  catalog = buildCatalog()
  return catalog
}

/**
 * Refresh the RMB rate table once, when the plugin starts.
 *
 * Once per host launch is deliberate: the plugin is loaded as the harness comes
 * up, so one fetch here means "the rate table is refreshed each time DSH is
 * opened" — which is the cadence the deployment wants. Nothing schedules itself
 * afterwards, so a long-running host keeps a stable table instead of silently
 * changing its rates mid-session; the readout shows the table's date, and
 * `--fetch` on the apply script can refresh it on demand.
 *
 * The fetch never blocks startup and never throws: a failure keeps the table that
 * is already on disk (or the seed before the first success) and merely leaves it
 * marked stale, which the readout reports.
 */
function refreshRatesAtStartup(ctx) {
  const pending = refreshIfStale()
  if (pending === null) return
  pending.then((result) => {
    if (result.ok === false && typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn(`dsh-chat-cost: rate table refresh at startup failed: ${result.reason}`)
    }
  }).catch(() => {})
}

function config(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    writeLog: value.writeLog !== false,
    logDirectory: typeof value.logDir === 'string' && value.logDir.trim() !== '' ? value.logDir.trim() : '.dsh-cost',
    language: typeof value.language === 'string' ? value.language : null,
    ledgerTailBytes: typeof value.ledgerTailBytes === 'number' && Number.isFinite(value.ledgerTailBytes) && value.ledgerTailBytes > 0
      ? value.ledgerTailBytes
      : DEFAULT_LEDGER_TAIL_BYTES
  }
}

/**
 * Normalize one lineage entry to a session id.
 *
 * Three callers hand over three shapes and they disagree about where the id
 * lives: a persistent header has it at the top (`{id}`), the query engine wraps
 * a whole session record in a trace node (`{session: {header: {id}}}`), and the
 * subagent listing returns flat rows (`{sessionId}`). Reading only one of them
 * is how a tree walk silently returns a single session: the trace does answer,
 * it just answers in a shape the walk cannot read.
 */
function entryId(entry) {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.sessionId === 'string') return entry.sessionId
  if (typeof entry.id === 'string') return entry.id
  if (entry.session !== undefined) return entryId(entry.session)
  if (entry.header !== undefined) return entryId(entry.header)
  return null
}

/** The durable header a traced record carries, or null. */
function headerOf(entry) {
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.header?.id === 'string') return entry.header
  if (entry.session !== undefined) return headerOf(entry.session)
  return null
}

/**
 * Flatten one trace's descendants into `{id, parentId, header}` links.
 *
 * The query engine returns a nested forest — each node is
 * `{session, descendants}` — so a walk over the first level keeps the children
 * of the chat and drops every grandchild: a workflow inside a subagent, or a
 * subagent of a subagent, would be invisible and unbilled.
 */
function flattenDescendants(nodes, parentId, out = []) {
  if (Array.isArray(nodes) === false) return out
  for (const node of nodes) {
    const id = entryId(node)
    const own = typeof node?.parentId === 'string' ? node.parentId : parentId
    if (id !== null) out.push({ id, parentId: own, header: headerOf(node) })
    flattenDescendants(node?.descendants, id ?? parentId, out)
  }
  return out
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))]
}

/**
 * Session ids of the tree rooted at `rootId`, with their parent links and the
 * durable header of every session seen on the way.
 *
 * Three first-party sources describe the same forest and each knows something
 * the others do not, so the tree is their union rather than the first one that
 * answers:
 *  - the query engine traces live *and* persisted sessions, which is what lets a
 *    chat that is not open here be priced at all;
 *  - the live store holds a child the moment it is created, before anything is
 *    persisted, and is the only source that also hands over the live session;
 *  - session persistence still lists the children of a host that never loaded
 *    the query engine.
 *
 * The union is not belt-and-braces: a subagent missing from this list is a
 * subagent nobody prices, and losing the children of a chat is indistinguishable
 * from a cheap chat.
 *
 * @param {object} ctx host plugin context
 * @param {string} rootId the session whose tree is walked
 * @param {AbortSignal} [signal] cancellation for corpus reads
 * @returns {Promise<{ids: string[], parents: Map<string, string>, headers: Map<string, object>, complete: boolean, workspace: string|null}>}
 */
async function collectTree(ctx, rootId, signal) {
  const ids = [rootId]
  const parents = new Map()
  const headers = new Map()
  let complete = false
  let workspace = null

  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.traceSession === 'function') {
    try {
      const trace = await query.traceSession(rootId, signal)
      const root = headerOf(trace?.root) ?? headerOf(trace?.target)
      const target = headerOf(trace?.target) ?? root
      for (const header of [target, root]) {
        if (header !== null && header !== undefined) headers.set(header.id, header)
      }
      // The workspace comes from the target: the cwd of the chat being asked
      // about, not of the ancestor this trace happens to root at.
      const cwd = typeof target?.cwd === 'string' && target.cwd !== '' ? target.cwd : (typeof root?.cwd === 'string' ? root.cwd : null)
      if (cwd !== null && cwd !== '') workspace = cwd
      const top = target?.id ?? root?.id ?? entryId(trace?.root ?? trace?.target) ?? rootId
      for (const link of flattenDescendants(trace?.descendants, top)) {
        ids.push(link.id)
        parents.set(link.id, link.parentId)
        if (link.header !== null && link.header !== undefined) headers.set(link.header.id, link.header)
      }
      // `complete` is the engine's own claim about its corpus: false there means
      // an ancestor it could not resolve, which is a partial lineage and must not
      // be described as a whole tree.
      complete = trace?.complete !== false
    } catch {
      // The trace can fail for a session the corpus does not hold (yet). The
      // sources below still know the sessions this host is running.
    }
  }

  // The live store is walked even when the trace answered: a child created since
  // the corpus was read is live here and unknown there, and its usage is real.
  const store = ctx.get('sessions')
  if (store !== undefined && typeof store.list === 'function') {
    const byParent = new Map()
    for (const session of store.list()) {
      const header = session?.header
      if (typeof header?.id !== 'string') continue
      headers.set(header.id, header)
      const parent = header.parentSession
      if (typeof parent !== 'string') continue
      if (byParent.has(parent) === false) byParent.set(parent, [])
      byParent.get(parent).push(header.id)
    }
    const seen = new Set([rootId])
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const child of byParent.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        ids.push(child)
        parents.set(child, current)
        queue.push(child)
      }
    }
  }

  // A host without the query engine has no corpus of closed sessions; its
  // persistence backend still lists them, one header per materialized log.
  if (complete === false) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      try {
        const links = new Map()
        for (const header of await persistence.list(signal)) {
          if (typeof header?.id !== 'string') continue
          headers.set(header.id, header)
          if (typeof header.parentSession !== 'string') continue
          if (links.has(header.parentSession) === false) links.set(header.parentSession, [])
          links.get(header.parentSession).push(header.id)
        }
        const seen = new Set(ids)
        const queue = [...ids]
        while (queue.length > 0) {
          const current = queue.shift()
          for (const child of links.get(current) ?? []) {
            if (seen.has(child)) continue
            seen.add(child)
            ids.push(child)
            parents.set(child, current)
            queue.push(child)
          }
        }
        complete = true
      } catch {
        complete = false
      }
    }
  }

  return { ids: unique(ids), parents, headers, complete, workspace }
}

/**
 * What each turn of a session cost.
 *
 * Only a live session has events to fold, and only a priced route can be
 * charged: a turn with no usable model is reported with `usd: null` rather than
 * an estimate, for the same reason an unpriced session shows `—`.
 */
function priceTurns(ctx, session, tariff = null) {
  const attribution = modelOf(session, ctx) ?? { provider: null, model: null }
  const fallbackTime = Date.now()
  return turnUsage(session?.events, { limit: MAX_TURNS }).map((turn) => {
    const route = turn.model ?? attribution
    const price = route.provider === null || route.model === null ? null : resolvePrice(priceCatalog(), route.provider, route.model)
    // The tier is read at the turn's own timestamp, not at the moment this summary
    // happens to be built: a request that ran off-peak must not be charged at the
    // peak rate because the page was polled an hour later.
    const at = typeof turn.time === 'number' && Number.isFinite(turn.time) ? new Date(turn.time) : new Date(fallbackTime)
    const peak = price !== null && price.provider === 'deepseek' ? isPeak(at) : false
    const priced = price === null ? null : priceUsage(price, turn.buckets, { peak })
    return {
      turn: turn.turn,
      tokens: turn.tokens,
      time: turn.time,
      usd: priced === null ? null : priced.usd,
      provider: route.provider,
      model: route.model,
      pricingSource: price === null ? 'none' : price.source,
      tariff,
      tier: price === null ? null : (price.cost.peakMultiplier > 1 ? (peak ? 'peak' : 'off-peak') : 'flat')
    }
  })
}

/**
 * The route the tree last ran under, according to its own cost log.
 *
 * A chat that is not open in this host has no live session to read a request
 * header from, so the only first-party statement about its route is the last
 * record this plugin wrote while watching it. That is enough to price a child
 * whose own log is gone, and `modelSource: 'inherited'` keeps the credit honest:
 * the figure is priced by the tree's route, not by a route anyone read off the
 * child.
 *
 * @param {Array<object>} costs ledger records in file order
 * @param {Set<string>} ids sessions of the tree being priced
 * @returns {{provider: string, model: string}|null}
 */
function treeRouteFromLedger(costs, ids) {
  let route = null
  for (const record of costs) {
    if (typeof record?.sessionId !== 'string' || ids.has(record.sessionId) === false) continue
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') continue
    route = { provider: record.provider, model: record.model }
  }
  return route
}

/**
 * The latest state the cost log recorded for each session: cumulative tokens and
 * what those tokens cost, as the file wrote them.
 *
 * @param {Array<object>} costs records in file order
 * @returns {Map<string, {record: object, usd: number}>}
 */
function recordedBySession(costs) {
  const bySession = new Map()
  for (const record of costs) {
    const id = record?.sessionId
    if (typeof id !== 'string') continue
    const cumulative = typeof record.cumulativeUsd === 'number' ? record.cumulativeUsd : null
    const delta = typeof record.deltaUsd === 'number' ? record.deltaUsd : 0
    bySession.set(id, {
      record,
      usd: cumulative === null ? (bySession.get(id)?.usd ?? 0) + delta : cumulative
    })
  }
  return bySession
}

/**
 * A session that is no longer live and whose counters no durable source can
 * still describe, so its last log record describes it.
 *
 * Nothing is priced here and nothing is invented: the numbers are the ones the
 * log already holds, and a session the log never saw stays unpriced.
 */
function recordedEntry(id, parentSessionId, depth, recorded) {
  const record = recorded?.record ?? null
  const usage = record === null ? EMPTY_USAGE : tokens(record.tokens)
  return {
    sessionId: id,
    parentSessionId,
    depth,
    title: record?.title ?? null,
    provider: record?.provider ?? null,
    model: record?.model ?? null,
    modelSource: 'session',
    basis: 'log',
    pricingSource: record?.pricingSource ?? 'none',
    tier: record?.tier ?? null,
    usage,
    delta: EMPTY_USAGE,
    deltaUsd: null,
    recordedUsd: recorded?.usd ?? 0,
    usd: recorded === undefined ? null : recorded.usd,
    live: false
  }
}

/**
 * Newest provider/model this session actually asked with.
 *
 * The request-header events are the first source and stay the first source: when
 * a log carries them, they answer directly. On builds that fold those events into
 * the modelSelection projection without leaving them in the event list the plugin
 * reads, the projection is asked instead — it is folded from the same
 * `request/header` payload, so the route it names is the one the harness routed
 * by, not a guess. With neither source the route stays null and the figure stays
 * `—`, which is the honest answer rather than a made-up tariff.
 *
 * @param session - the session whose route is wanted
 * @param ctx - host plugin context, for the projection registry; optional so a
 *   caller that only has the log (and the exported test seam) still works
 */
function modelOf(session, ctx) {
  const events = session?.events
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'request/header') continue
      const call = event?.data?.header?.config
      if (call === null || typeof call !== 'object') continue
      return {
        provider: typeof call.provider === 'string' ? call.provider : null,
        model: typeof call.model === 'string' ? call.model : null
      }
    }
  }

  // Local patch: builds that supply no `request/header` event still name the
  // route in this projection, whose state is `{ lastUsed, pending }` while its
  // wire view is `{ lastUsed, next }` — both are accepted so either shape works.
  const projections = ctx?.get?.('sessionProjections')
  if (projections !== undefined && typeof projections.stateOf === 'function' && session !== undefined) {
    try {
      const state = projections.stateOf(session, 'modelSelection')
      const used = state?.lastUsed ?? state?.next ?? state?.pending ?? null
      if (typeof used?.provider === 'string' && typeof used?.model === 'string') {
        return { provider: used.provider, model: used.model }
      }
    } catch {
      // An unregistered key or a session the projection cannot fold is the same
      // answer as a log without headers: no route known, and no route invented.
    }
  }

  return null
}

/** Provider-reported usage buckets for a live session, or null. */
function usageOf(ctx, session) {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined || typeof projections.stateOf !== 'function' || session === undefined) return null
  try {
    const state = projections.stateOf(session, 'tokenUsage')
    if (state === null || typeof state !== 'object') return null
    return tokens(state)
  } catch {
    return null
  }
}

const EMPTY_USAGE = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

/**
 * Price one session's usage, incrementally, whatever carried the usage here.
 *
 * The ledger is the base: every record already priced the tokens of its own
 * interval at the tariff in effect when they arrived. Only the delta that has
 * not been recorded yet is priced here, at the tariff in effect now — so a
 * session that ran off-peak is never re-priced at today's peak tariff, which
 * would be wrong by up to the peak multiplier.
 *
 * @param {Date} now the moment the unrecorded interval is priced at
 * @param {object} input session identity, usage, route and where they came from
 */
function pricedEntry(now, input) {
  const price = resolvePrice(priceCatalog(), input.provider, input.model)
  const cumulative = input.usage ?? EMPTY_USAGE
  // A base priced in another tariff epoch cannot be subtracted from: its
  // cumulative is denominated in a table this figure is not using. When the epoch
  // moved, the session is priced from zero under the current table instead, which
  // makes the total whole again rather than adding two currencies together — and
  // the interval is the whole cumulative, which is what the delta has to say.
  const restart = input.base?.restart === true
  const base = restart ? null : input.base
  const delta = restart === true ? tokens(cumulative) : subtractUsage(cumulative, base?.tokens ?? EMPTY_USAGE)
  const clockPeak = price !== null && price.provider === 'deepseek' ? isPeak(now) : false
  // A price is a property of the interval that earned it. With no new tokens the
  // reported tariff is the one the log recorded, not the one in force now.
  const priced = totalTokens(delta) > 0
  const recordedTier = priced ? null : (typeof base?.tier === 'string' ? base.tier : null)
  // Which tariff window this interval actually fell in, when the calling path
  // knows it from the token events. `input.tier` is stated per turn, so it is a
  // fact about consumption where `now` is only a fact about the clock that is
  // reading the ledger. Without it, the clock is the fallback and is correct
  // whenever no window boundary was crossed since the tokens arrived.
  const statedPeak = input.tier === 'peak' ? true : (input.tier === 'off-peak' ? false : null)
  const peak = price !== null && price.provider === 'deepseek'
    ? (statedPeak === null ? clockPeak : statedPeak)
    : false
  const deltaPriced = price === null ? null : priceUsage(price, delta, { peak })
  const recordedUsd = typeof base?.cumulativeUsd === 'number' ? base.cumulativeUsd : 0
  return {
    sessionId: input.id ?? null,
    parentSessionId: input.parentId ?? null,
    depth: input.depth ?? 0,
    title: input.title ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    // How the route was learned: from the session's own log, or inherited from
    // the tree it belongs to when the session is gone and only its counters
    // survived. The distinction travels all the way to the readout.
    modelSource: input.modelSource ?? 'session',
    // What the figure was read from: a running session, the harness's durable
    // checkpoint of a session that ended, or the log alone.
    basis: input.basis ?? 'live',
    pricingSource: price === null ? 'none' : price.source,
    // Which tariff table priced this interval, so a later figure can tell whether
    // this record's cumulative is comparable to its own.
    tariff: input.tariff ?? null,
    tier: price === null ? null : (price.cost.peakMultiplier > 1 ? (recordedTier ?? (peak ? 'peak' : 'off-peak')) : 'flat'),
    usage: cumulative,
    delta,
    deltaUsd: deltaPriced === null ? null : deltaPriced.usd,
    recordedUsd,
    usd: deltaPriced === null ? null : recordedUsd + deltaPriced.usd,
    live: input.live === true
  }
}

/** Price one session this host is running, from the live usage projection. */
function priceSession(ctx, session, depth, parentId, now, base, tariff = null, tier = null) {
  const usage = usageOf(ctx, session)
  const attribution = modelOf(session, ctx) ?? { provider: null, model: null }
  return pricedEntry(now, {
    id: session?.id ?? null,
    parentId,
    depth,
    title: session?.header?.title ?? null,
    provider: attribution.provider,
    model: attribution.model,
    tariff,
    tier,
    usage,
    base,
    basis: 'live',
    live: usage !== null
  })
}

/** The four buckets inside a projection snapshot, or null when it holds none. */
function usageFromSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const value = snapshot.values?.tokenUsage
  if (value === undefined || value === null) return null
  return tokens(value)
}

/**
 * What a session spent, read from the harness's durable record of it.
 *
 * A released subagent is not a mystery and its cost is not zero: the harness
 * checkpoints every session's token counters to disk, so the figure outlives the
 * session. `cachedSnapshot` is a synchronous read of those rows — the cheap path,
 * and the one that answers on every poll; `coldSnapshot` refolds the log tail
 * behind the checkpoint for a session whose last turn never reached one, and is
 * asked for once per session, never per poll.
 *
 * @returns {Promise<{usage: object, source: 'cache'|'durable'}|null>} null when
 *   nothing durable describes this session — an honestly unknown figure
 */
async function durableUsage(ctx, id, header, signal) {
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined || id === null) return null
  try {
    if (header !== undefined && typeof cache.cachedSnapshot === 'function') {
      const usage = usageFromSnapshot(cache.cachedSnapshot(header))
      if (usage !== null) return { usage, source: 'cache' }
    }
    if (typeof cache.coldSnapshot === 'function') {
      const usage = usageFromSnapshot(await cache.coldSnapshot(id, signal))
      if (usage !== null) return { usage, source: 'durable' }
    }
  } catch {
    // No checkpoint, no persisted log, or a cancelled read: the caller falls
    // back to the log, which is a smaller answer and never a wrong one.
  }
  return null
}

/**
 * Price one session this host is not running.
 *
 * A session nobody can still read the counters of is described by the log alone,
 * exactly as before: an unknown figure stays unknown rather than becoming zero.
 *
 * The route is the session's own whenever the log remembers it (the last flush
 * that watched it), and otherwise the tree's: a child normally runs the route it
 * was configured with, and `modelSource: 'inherited'` says so instead of
 * pretending the session was seen.
 */
function priceCold(now, { id, header, parentId, depth, base, recorded, inherited, usage, source, tariff = null, tier = null }) {
  if (usage === null || usage === undefined) return recordedEntry(id, parentId, depth, recorded)
  const known = recorded?.record ?? null
  const provider = known?.provider ?? inherited?.provider ?? null
  const model = known?.model ?? inherited?.model ?? null
  return pricedEntry(now, {
    id,
    parentId,
    depth,
    title: known?.title ?? header?.title ?? null,
    provider,
    model,
    modelSource: known?.model !== undefined && known?.model !== null ? 'session' : 'inherited',
    tariff,
    tier,
    usage,
    base,
    basis: source,
    live: false
  })
}

/**
 * The tariff window of the newest turn that actually consumed tokens.
 *
 * The interval being charged is the newest one, so its window is the window the
 * session's new tokens were consumed in. An empty answer in the middle of a peak
 * hour carries no tokens and must not relabel the interval.
 *
 * @param {Array<{ tokens: number, tier: string|null }>} turns newest last
 * @returns {'peak'|'off-peak'|null}
 */
function newestTurnTier(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn.tokens > 0 && (turn.tier === 'peak' || turn.tier === 'off-peak')) return turn.tier
  }
  return null
}

/**
 * Walk up from a session to the root of its live tree. A parent that is no
 * longer in the store (a released subagent) ends the walk at the last live
 * ancestor, which is the tree the harness can still describe.
 */
function rootOf(session, store) {
  let current = session
  const seen = new Set()
  for (let step = 0; step < 32; step += 1) {
    const parentId = current?.header?.parentSession
    if (typeof parentId !== 'string' || seen.has(parentId)) break
    seen.add(parentId)
    const parent = typeof store?.get === 'function' ? store.get(parentId) : undefined
    if (parent === undefined) break
    current = parent
  }
  return current?.id ?? session?.id ?? null
}

function depthOf(id, parents, rootId) {
  let depth = 0
  let cursor = parents.get(id)
  const seen = new Set([id])
  while (typeof cursor === 'string' && seen.has(cursor) === false && depth < 32) {
    seen.add(cursor)
    depth += 1
    if (cursor === rootId) break
    cursor = parents.get(cursor)
  }
  return depth
}

function sendJson(res, body) {
  const payload = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function sendFailure(res, reason, status = 200) {
  const payload = JSON.stringify({ ok: false, reason })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Serialize one session tree's flushes.
 *
 * The widget polls, a second tab may poll too, and a turn end fires its own
 * flush: overlapping runs would each decide from the same base and append the
 * same figures twice. One flush per tree at a time keeps the ledger a ledger.
 *
 * @param {object} ctx host plugin context
 * @param {object} settings resolved plugin config
 * @param {{ locks: ReturnType<typeof createLocks>, ledgerCache: Map<string, { key: string, value: object }> }} state per-plugin write memory
 * @param {string} sessionId root session id
 * @param {Date} [now] the moment the tariff is read at; tests pin it, because a
 *   price test that depends on when it runs is a test that fails at 07:00 UTC
 */
function buildSummary(ctx, settings, state, sessionId, now = new Date()) {
  return state.locks.run(`summary:${sessionId}`, () => buildSummaryOnce(ctx, settings, state, sessionId, now))
}

/**
 * Build the summary for one session tree and append the cost log for every
 * session whose figure moved since the last write. Callers go through
 * {@link buildSummary} so overlapping requests cannot double-append.
 */
async function buildSummaryOnce(ctx, settings, state, sessionId, now = new Date()) {
  const store = ctx.get('sessions')
  if (store === undefined || typeof store.get !== 'function') return { ok: false, reason: 'session-store-unavailable' }

  const options = { dir: settings.logDirectory }
  const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS)

  // A chat that is not open in this host is not a live session, but it is not
  // unknown either: the query engine still knows where it lived, so its cost can
  // come from the log instead of being reported as nothing at all.
  const liveRoot = store.get(sessionId)
  const tree = await collectTree(ctx, sessionId, signal)
  const workspace = typeof liveRoot?.header?.cwd === 'string' && liveRoot.header.cwd !== ''
    ? liveRoot.header.cwd
    : tree.workspace
  if (liveRoot === undefined && workspace === null) return { ok: false, reason: 'unknown-session' }
  const recorded = liveRoot === undefined

  // The ledger leads: it holds what earlier intervals cost at the tariff in
  // effect back then, and the cache keeps an unchanged file from being parsed
  // again on the next poll.
  const ledger = workspace === null
    ? { entries: [], costs: [], marks: [], broken: [], path: null, truncated: false, skippedBytes: 0 }
    : await readLedger(workspace, { ...options, tailBytes: settings.ledgerTailBytes, cache: state.ledgerCache })
  // The tariff epoch this summary is priced in. Records stamped with another epoch
  // are not additive with it, so the base refuses their money and re-prices the
  // session under the current table (see ledgerBase).
  const tariff = currentTariff()
  const base = ledgerBase(ledger.costs, tariff)
  const logged = recorded ? recordedBySession(ledger.costs) : null

  const entries = []
  // The tree's own route, inherited by a child whose log no longer exists to ask:
  // read from the live session when this host runs it, and otherwise from the
  // last record the log wrote while it did.
  const treeModel = liveRoot === undefined
    ? treeRouteFromLedger(ledger.costs, new Set(tree.ids))
    : modelOf(liveRoot, ctx)
  // Per-answer prices, computed once: they are what the transcript renders, and
  // they are also where the interval's tariff window comes from — the newest turn
  // that consumed tokens is the interval being charged, so its window is the one
  // the session total is priced in.
  const turns = liveRoot === undefined ? [] : priceTurns(ctx, liveRoot, tariff)
  const turnTier = newestTurnTier(turns)
  for (const id of tree.ids) {
    const parentSessionId = id === sessionId ? null : (tree.parents.get(id) ?? sessionId)
    const depth = depthOf(id, tree.parents, sessionId)
    const session = store.get(id)
    if (session !== undefined) {
      // Only the chat being viewed has its turns folded here; a subagent's own
      // interval falls back to the clock, which is correct unless a window
      // boundary was crossed between its tokens arriving and this poll.
      const tier = id === sessionId ? turnTier : null
      entries.push(priceSession(ctx, session, depth, parentSessionId, now, base.get(id), tariff, tier))
      continue
    }
    // Not live — a subagent that has already finished, or a chat closed since.
    // The harness keeps a durable checkpoint of every session's counters, so ask
    // it before falling back to the log: that read is what makes the children of
    // a chat countable at all, and a released subagent is the normal case, not an
    // edge one.
    const header = tree.headers.get(id)
    const cold = await durableUsage(ctx, id, header, signal)
    entries.push(priceCold(now, {
      id,
      header,
      parentId: parentSessionId,
      depth,
      base: base.get(id),
      recorded: logged?.get(id),
      inherited: treeModel,
      tariff,
      tier: id === sessionId ? turnTier : null,
      usage: cold?.usage ?? null,
      source: cold === null ? 'log' : 'durable'
    }))
  }

  const summary = summarizeTree(entries)

  // Only what moved since a session's last record is appended: the ledger is a
  // series of intervals, not a series of snapshots.
  let logPath = null
  let logError = null
  const pending = entries.filter((entry) => entry.usd !== null && totalTokens(entry.delta) > 0)
  if (settings.writeLog === true && workspace !== null && recorded === false) {
    const file = join(workspace, settings.logDirectory, 'cost.jsonl')
    if (pending.length > 0) {
      try {
        await ensureGitignore(workspace, options)
        logPath = await appendCostLog(workspace, pending.map((entry) => costRecord({
          plugin: `dsh-chat-cost@${PLUGIN_VERSION}`,
          sessionId: entry.sessionId,
          parentSessionId: entry.parentSessionId,
          rootSessionId: sessionId,
          depth: entry.depth,
          kind: entry.parentSessionId === null ? 'chat' : 'subagent',
          title: entry.title,
          workspace,
          provider: entry.provider,
          model: entry.model,
          modelSource: entry.modelSource,
          basis: entry.basis,
          pricingSource: entry.pricingSource,
          tariff: entry.tariff,
          tier: entry.tier,
          usage: entry.usage,
          deltaTokens: entry.delta,
          cumulativeUsd: entry.usd,
          deltaUsd: entry.deltaUsd
        })), options)
        // The file just changed; make the next read see it.
        state.ledgerCache?.delete(file)
      } catch (error) {
        logError = error instanceof Error ? error.message : String(error)
      }
    } else {
      logPath = existsSync(file) ? file : null
    }
  }

  // Plan and budget live with the log: the summary carries both so the client
  // can show plan versus actual without a second request.
  let plan = null
  let budget = null
  let burn = null
  let unlabeledUsd = null
  if (workspace !== null) {
    const stored = await readBudget(workspace, options)
    const storedPlan = await readPlan(workspace, options)
    const actuals = actualsByLabel(ledger.entries)
    unlabeledUsd = actuals.find((entry) => entry.label === UNLABELED_LABEL)?.usd ?? 0

    const recordedUsd = ledger.costs.reduce((sum, record) => sum + (typeof record.deltaUsd === 'number' ? record.deltaUsd : 0), 0)
    const pendingUsd = pending.reduce((sum, entry) => sum + (entry.deltaUsd ?? 0), 0)
    const spentUsd = recordedUsd + pendingUsd
    const limit = typeof stored?.usd === 'number' ? stored.usd : (typeof storedPlan?.budgetUsd === 'number' ? storedPlan.budgetUsd : null)
    burn = burnRate(spendSamples(ledger.costs), { budgetUsd: limit, spentUsd })
    budget = limit === null ? null : { usd: limit, spentUsd, remainingUsd: limit - spentUsd, projection: burn.projection, usdPerHour: burn.usdPerHour }

    if (storedPlan !== null) {
      const byLabel = new Map(actuals.map((entry) => [entry.label, entry]))
      plan = {
        goal: storedPlan.goal ?? null,
        totals: storedPlan.totals ?? null,
        budgetUsd: storedPlan.budgetUsd ?? null,
        units: (storedPlan.units ?? []).map((unit) => ({
          label: unit.label,
          title: unit.title ?? null,
          route: unit.route ?? null,
          p50Usd: unit.p50Usd ?? null,
          p90Usd: unit.p90Usd ?? null,
          status: unit.status ?? 'planned',
          actualUsd: byLabel.get(unit.label)?.usd ?? null
        })),
        deferredCount: Array.isArray(storedPlan.deferred) ? storedPlan.deferred.length : 0,
        scenarios: (Array.isArray(storedPlan.scenarios) ? storedPlan.scenarios : []).map((scenario) => ({
          name: scenario.name,
          p50Usd: scenario.totals?.p50Usd ?? null,
          providers: Array.isArray(scenario.providers) ? scenario.providers : []
        })),
        savingsUsd: typeof storedPlan.recommendation?.savingsUsd === 'number' ? storedPlan.recommendation.savingsUsd : null,
        opportunities: (storedPlan.recommendation?.opportunities ?? []).slice(0, 5).map((entry) => ({
          label: entry.label,
          from: entry.from?.model ?? null,
          to: entry.to?.model ?? null,
          usd: typeof entry.usd === 'number' ? entry.usd : null
        }))
      }
    }
  }

  return {
    ok: true,
    rootSessionId: sessionId,
    workspace,
    // The readout names the release that produced the numbers, so "which version
    // are you running?" is answerable from the interface and not only from the CLI.
    version: PLUGIN_VERSION,
    // Where the RMB figures came from and how old they are: the table is fetched
    // from DeepSeek's page, so a stale or seed-sourced table has to be visible
    // rather than implied by an unlabelled number.
    rates: provenance(),
    // Per-turn cost of the chat being viewed: the client renders it under each
    // finished answer, so a turn has a price where the answer is.
    turns,
    // Provider calls this session made whose usage the session log does not
    // carry: the readout names the count so a figure that is a floor is known to
    // be one. Only a live session's events are here to count; a closed chat says
    // nothing rather than zero.
    searchCalls: liveRoot === undefined ? null : unbilledSearchCalls(liveRoot.events),
    logPath,
    logError,
    // Reported after the flush: a client asking about the ledger wants the state
    // it will find on disk, not the state this run started from.
    ledger: {
      records: ledger.costs.length + pending.length,
      marks: ledger.marks.length,
      brokenLines: ledger.broken.length,
      truncated: ledger.truncated,
      skippedBytes: ledger.skippedBytes
    },
    complete: tree.complete,
    // True when the numbers come from the log rather than from a live session:
    // the client says so instead of passing them off as current.
    recorded,
    language: settings.language,
    unlabeledUsd,
    plan,
    budget,
    updatedAt: now.toISOString(),
    ...summary,
    totals: { ...summary.totals, sessions: summary.sessions.length }
  }
}

/**
 * Boot the plugin.
 *
 * The loader calls `apply(ctx, config)` with the row's config as the second
 * argument. It must not be read from `ctx`: in this Cordis, any property a
 * plugin did not inject throws "cannot get property ... without inject", which
 * takes the whole plugin tree down at boot.
 */
const apply = (ctx, rawConfig) => {
  const settings = config(rawConfig)
  const state = { locks: createLocks(), ledgerCache: new Map(), language: null }

  // The RMB rate table is fetched once, as the host comes up.
  refreshRatesAtStartup(ctx)

  // Log on its own schedule as well: an event-driven flush means the cost log
  // fills up while the conversation runs, whether or not a client is polling.
  const scheduled = new Map()

  function scheduleTree(rootId) {
    if (typeof rootId !== 'string' || rootId === '' || scheduled.has(rootId)) return
    const timer = setTimeout(() => {
      scheduled.delete(rootId)
      buildSummary(ctx, settings, state, rootId).catch(() => {})
    }, FLUSH_DEBOUNCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    scheduled.set(rootId, timer)
  }

  ctx.effect(() => () => {
    for (const timer of scheduled.values()) clearTimeout(timer)
    scheduled.clear()
  })

  // Model-facing budget tools: the model plans, these price, pack and record.
  const toolRegistry = ctx.get('tools')
  if (toolRegistry !== undefined && typeof toolRegistry.register === 'function') {
    const tools = buildTools({
      catalog: priceCatalog(),
      settings,
      locks: state.locks,
      languageOf: () => state.language ?? null,
      resolveProject: (exec) => {
        const agent = exec?.agent
        const sessionId = typeof agent?.sessionId === 'string' ? agent.sessionId : null
        const store = ctx.get('sessions')
        const session = sessionId === null || typeof store?.get !== 'function' ? undefined : store.get(sessionId)
        const dir = typeof session?.header?.cwd === 'string' ? session.header.cwd : null
        return { dir, sessionId, rootSessionId: session === undefined ? null : rootOf(session, store) }
      }
    })
    for (const tool of tools) ctx.effect(() => toolRegistry.register(tool))
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    scheduleTree(rootOf(session, ctx.get('sessions')))
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUMMARY_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') return sendFailure(res, 'method')
      let sessionId = null
      try {
        sessionId = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('sessionId')
      } catch {
        sessionId = null
      }
      if (typeof sessionId !== 'string' || sessionId === '') return sendFailure(res, 'sessionId-required')
      // The widget reports the language it resolved (config, then harness locale,
      // then the browser), which is the only way the Host learns what a ru-*
      // browser wants; generated documents follow it.
      try {
        const reported = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('language')
        if (typeof reported === 'string' && ['en', 'zh', 'ru'].includes(reported)) state.language = reported
      } catch {
        // a malformed url simply leaves the language as it was
      }
      // Returning the promise lets a caller (and the tests) await the write; the
      // HTTP server ignores a handler's return value.
      return buildSummary(ctx, settings, state, sessionId).then(
        (body) => sendJson(res, body),
        (error) => sendJson(res, { ok: false, reason: 'internal', message: error instanceof Error ? error.message : String(error) })
      )
    }
  }))
}

/** The per-plugin state the summary needs; tests build it the same way apply does. */
function createState() {
  return { locks: createLocks(), ledgerCache: new Map() }
}

export { apply, createState as __createState, buildSummary as __buildSummary, config as __config, collectTree as __collectTree, treeRouteFromLedger as __treeRouteFromLedger, modelOf as __modelOf, priceSession as __priceSession, rootOf as __rootOf, SUMMARY_PATH as __summaryPath, DEFAULT_LEDGER_TAIL_BYTES as __defaultLedgerTailBytes, priceCatalog as __catalog, provenance as __rateProvenance, currentTariff as __tariff }
export { PLUGIN_VERSION }
