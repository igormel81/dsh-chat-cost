/**
 * dsh-chat-cost — Host half.
 *
 * Walks the session tree rooted at the requesting session (the chat plus every
 * subagent session it spawned), prices each session's provider-reported usage
 * from the bundled multi-provider catalog, appends a JSONL cost log inside the
 * project folder, and serves the summary the client renders.
 *
 * Data sources, all first-party:
 *  - the tree        -> ctx.sessionQuery.traceSession() when mounted (live and
 *                       persisted sessions alike), else ctx.sessions.list();
 *  - token usage     -> ctx.sessionProjections.stateOf(session, 'tokenUsage'),
 *                       the provider-reported four buckets;
 *  - provider/model  -> the newest `request/header` event of that session;
 *  - project folder  -> the root session's durable header `cwd`;
 *  - prices          -> data/prices.json, plus the official DeepSeek table.
 *
 * Only live sessions expose a usage state; a persisted-only session is reported
 * without a price rather than estimated, and the tooltip names it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { UNLABELED_LABEL, actualsByLabel, appendCostLog, costRecord, ensureGitignore, ledgerBase, readLedger, spendSamples, subtractUsage, summarizeTree, tokens, totalTokens } from './log.js'
import { createLocks } from './locks.js'
import { burnRate } from './budget.js'
import { readBudget, readPlan } from './plan.js'
import { isPeakUtc, priceUsage, resolvePrice } from './prices.js'
import { buildTools } from './tools.js'

export const name = 'dsh-chat-cost'
export const inject = ['webServer']

const SUMMARY_PATH = '/api/plugins/dsh-chat-cost/summary'
/** Coalescing window for turn-driven flushes of one session tree. */
const FLUSH_DEBOUNCE_MS = 1500
const QUERY_TIMEOUT_MS = 5000
/** Bytes of the ledger tail the summary reads; the tools still read everything. */
const DEFAULT_LEDGER_TAIL_BYTES = 2 * 1024 * 1024
const PLUGIN_VERSION = '0.5.3'

let catalog = null

/** The bundled catalog, read once. A missing or broken file yields an empty one. */
function priceCatalog() {
  if (catalog !== null) return catalog
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'prices.json')
    catalog = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    catalog = { providers: {} }
  }
  return catalog
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

/** Normalize one lineage entry (a string id or an object) to a session id. */
function entryId(entry) {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.sessionId === 'string') return entry.sessionId
  if (typeof entry.id === 'string') return entry.id
  if (entry.header !== undefined && typeof entry.header?.id === 'string') return entry.header.id
  return null
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))]
}

/**
 * Session ids of the tree rooted at `rootId`, with their parent links.
 * Uses the query engine (live + persisted) when mounted; falls back to the live
 * store, which sees only live sessions.
 */
async function collectTree(ctx, rootId, signal) {
  const ids = [rootId]
  const parents = new Map()
  let complete = true

  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.traceSession === 'function') {
    try {
      const trace = await query.traceSession(rootId, signal)
      const root = entryId(trace?.root ?? trace?.target) ?? rootId
      for (const entry of trace?.descendants ?? []) {
        const id = entryId(entry)
        if (id === null) continue
        ids.push(id)
        const parent = typeof entry?.parentId === 'string' ? entry.parentId : (typeof entry?.parentSession === 'string' ? entry.parentSession : null)
        if (parent !== null) parents.set(id, parent)
      }
      complete = trace?.complete !== false
      return { ids: unique([root, ...ids]), parents, complete }
    } catch {
      // fall through to the live store
    }
  }

  const store = ctx.get('sessions')
  if (store !== undefined && typeof store.list === 'function') {
    const live = store.list()
    const byParent = new Map()
    for (const session of live) {
      const parent = session?.header?.parentSession
      if (typeof parent !== 'string') continue
      if (byParent.has(parent) === false) byParent.set(parent, [])
      byParent.get(parent).push(session.id)
    }
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const child of byParent.get(current) ?? []) {
        ids.push(child)
        parents.set(child, current)
        queue.push(child)
      }
    }
  } else {
    complete = false
  }

  return { ids: unique(ids), parents, complete }
}

/** Newest provider/model this session actually asked with. */
function modelOf(session) {
  const events = session?.events
  if (Array.isArray(events) === false) return null
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
 * Price one session, incrementally.
 *
 * The ledger is the base: every record already priced the tokens of its own
 * interval at the tariff in effect when they arrived. Only the delta that has
 * not been recorded yet is priced here, at the tariff in effect now — so a
 * session that ran off-peak is never re-priced at today's peak tariff, which
 * would be wrong by up to the peak multiplier.
 */
function priceSession(ctx, session, depth, parentId, now, base) {
  const usage = usageOf(ctx, session)
  const attribution = modelOf(session) ?? { provider: null, model: null }
  const price = resolvePrice(priceCatalog(), attribution.provider, attribution.model)
  const cumulative = usage ?? EMPTY_USAGE
  const delta = subtractUsage(cumulative, base?.tokens ?? EMPTY_USAGE)
  const peak = price !== null && price.provider === 'deepseek' ? isPeakUtc(now) : false
  const deltaPriced = price === null ? null : priceUsage(price, delta, { peak })
  const recordedUsd = typeof base?.cumulativeUsd === 'number' ? base.cumulativeUsd : 0
  return {
    sessionId: session?.id ?? null,
    parentSessionId: parentId,
    depth,
    title: session?.header?.title ?? null,
    provider: attribution.provider,
    model: attribution.model,
    pricingSource: price === null ? 'none' : price.source,
    tier: price === null ? null : (price.cost.peakMultiplier > 1 ? (peak ? 'peak' : 'off-peak') : 'flat'),
    usage: cumulative,
    delta,
    deltaUsd: deltaPriced === null ? null : deltaPriced.usd,
    recordedUsd,
    usd: deltaPriced === null ? null : recordedUsd + deltaPriced.usd,
    live: usage !== null
  }
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
 */
function buildSummary(ctx, settings, state, sessionId) {
  return state.locks.run(`summary:${sessionId}`, () => buildSummaryOnce(ctx, settings, state, sessionId))
}

/**
 * Build the summary for one session tree and append the cost log for every
 * session whose figure moved since the last write. Callers go through
 * {@link buildSummary} so overlapping requests cannot double-append.
 */
async function buildSummaryOnce(ctx, settings, state, sessionId) {
  const store = ctx.get('sessions')
  if (store === undefined || typeof store.get !== 'function') return { ok: false, reason: 'session-store-unavailable' }
  const root = store.get(sessionId)
  if (root === undefined) return { ok: false, reason: 'unknown-session' }

  const options = { dir: settings.logDirectory }
  const workspace = typeof root.header?.cwd === 'string' ? root.header.cwd : null
  const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS)
  const now = new Date()

  // The ledger leads: it holds what earlier intervals cost at the tariff in
  // effect back then, and the cache keeps an unchanged file from being parsed
  // again on the next poll.
  const ledger = workspace === null
    ? { entries: [], costs: [], marks: [], broken: [], path: null, truncated: false, skippedBytes: 0 }
    : await readLedger(workspace, { ...options, tailBytes: settings.ledgerTailBytes, cache: state.ledgerCache })
  const base = ledgerBase(ledger.costs)

  const tree = await collectTree(ctx, sessionId, signal)
  const entries = []
  for (const id of tree.ids) {
    const parentSessionId = id === sessionId ? null : (tree.parents.get(id) ?? sessionId)
    const depth = depthOf(id, tree.parents, sessionId)
    const session = store.get(id)
    if (session === undefined) {
      // Reported, never priced: a session the store no longer holds has no
      // usage to price, and guessing one would be worse than an empty row.
      entries.push({
        sessionId: id,
        parentSessionId,
        depth,
        title: null,
        provider: null,
        model: null,
        pricingSource: 'none',
        tier: null,
        usage: EMPTY_USAGE,
        delta: EMPTY_USAGE,
        deltaUsd: null,
        recordedUsd: 0,
        usd: null,
        live: false
      })
      continue
    }
    entries.push(priceSession(ctx, session, depth, parentSessionId, now, base.get(id)))
  }

  const summary = summarizeTree(entries)

  // Only what moved since a session's last record is appended: the ledger is a
  // series of intervals, not a series of snapshots.
  let logPath = null
  let logError = null
  const pending = entries.filter((entry) => entry.usd !== null && totalTokens(entry.delta) > 0)
  if (settings.writeLog === true && workspace !== null) {
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
          pricingSource: entry.pricingSource,
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

export { apply, createState as __createState, buildSummary as __buildSummary, config as __config, collectTree as __collectTree, modelOf as __modelOf, priceSession as __priceSession, rootOf as __rootOf, SUMMARY_PATH as __summaryPath, DEFAULT_LEDGER_TAIL_BYTES as __defaultLedgerTailBytes }
export { PLUGIN_VERSION }
