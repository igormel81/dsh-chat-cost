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
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { actualsByLabel, appendCostLog, costRecord, ensureGitignore, readLedger, spendSamples, summarizeTree, tokens } from './log.js'
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
const PLUGIN_VERSION = '0.4.2'

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
    language: typeof value.language === 'string' ? value.language : null
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

/** Price one session's usage; returns null figures for a session we cannot price. */
function priceSession(ctx, session, depth, parentId, now) {
  const header = session?.header
  const usage = usageOf(ctx, session)
  const attribution = modelOf(session) ?? { provider: null, model: null }
  const price = resolvePrice(priceCatalog(), attribution.provider, attribution.model)
  const peak = price !== null && price.provider === 'deepseek' ? isPeakUtc(now) : false
  const priced = price === null ? null : priceUsage(price, usage ?? {}, { peak })
  return {
    sessionId: session?.id ?? null,
    parentSessionId: parentId,
    depth,
    title: session?.header?.title ?? null,
    provider: attribution.provider,
    model: attribution.model,
    pricingSource: price === null ? 'none' : price.source,
    tier: price === null ? null : (price.cost.peakMultiplier > 1 ? (peak ? 'peak' : 'off-peak') : 'flat'),
    usage: usage ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    usd: priced === null ? null : priced.usd,
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
 * Build the summary for one session tree and append the cost log for every
 * session whose figure moved since the last write.
 * @param {object} ctx host plugin context
 * @param {object} settings resolved plugin config
 * @param {{ flushed: Map<string, number> }} state per-plugin write memory
 * @param {string} sessionId root session id
 */
async function buildSummary(ctx, settings, state, sessionId) {
  const flushed = state.flushed
    const store = ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return { ok: false, reason: 'session-store-unavailable' }
    const root = store.get(sessionId)
    if (root === undefined) return { ok: false, reason: 'unknown-session' }

    const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS)
    const tree = await collectTree(ctx, sessionId, signal)
    const now = new Date()

    const entries = []
    for (const id of tree.ids) {
      const session = store.get(id)
      if (session === undefined) {
        entries.push({
          sessionId: id,
          parentSessionId: tree.parents.get(id) ?? (id === sessionId ? null : sessionId),
          depth: depthOf(id, tree.parents, sessionId),
          title: null, provider: null, model: null, pricingSource: 'none', tier: null,
          usage: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usd: null, live: false
        })
        continue
      }
      entries.push(priceSession(ctx, session, depthOf(id, tree.parents, sessionId), id === sessionId ? null : (tree.parents.get(id) ?? sessionId), now))
    }

    const summary = summarizeTree(entries)
    const workspace = typeof root.header?.cwd === 'string' ? root.header.cwd : null

    let logPath = null
    let logError = null
    if (settings.writeLog === true && workspace !== null) {
      const pending = []
      for (const entry of summary.sessions) {
        if (entry.usd === null) continue
        const previous = flushed.get(entry.sessionId)
        if (previous !== undefined && Math.abs(previous - entry.usd) < 1e-9) continue
        pending.push({ entry, delta: previous === undefined ? entry.usd : entry.usd - previous })
      }
      if (pending.length > 0) {
        try {
          await ensureGitignore(workspace, { dir: settings.logDirectory })
          logPath = await appendCostLog(workspace, pending.map(({ entry, delta }) => costRecord({
            plugin: `dsh-chat-cost@${PLUGIN_VERSION}`,
            sessionId: entry.sessionId,
            parentSessionId: entry.parentSessionId,
            rootSessionId: sessionId,
            depth: entry.depth,
            kind: entry.kind,
            title: entry.title,
            workspace,
            provider: entry.provider,
            model: entry.model,
            pricingSource: entry.pricingSource,
            tier: entries.find((candidate) => candidate.sessionId === entry.sessionId)?.tier ?? null,
            usage: {
              uncachedInputTokens: entry.tokens.uncachedInput,
              cacheReadTokens: entry.tokens.cacheRead,
              cacheWriteTokens: entry.tokens.cacheWrite,
              outputTokens: entry.tokens.output
            },
            cumulativeUsd: entry.usd,
            deltaUsd: delta
          })), { dir: settings.logDirectory })
          for (const { entry } of pending) flushed.set(entry.sessionId, entry.usd)
        } catch (error) {
          logError = error instanceof Error ? error.message : String(error)
        }
      } else {
        try {
          const candidate = join(workspace, settings.logDirectory, 'cost.jsonl')
          statSync(candidate)
          logPath = candidate
        } catch {
          logPath = null
        }
      }
    }

    // Plan and budget live with the log: the summary carries both so the client
    // can show plan versus actual without a second request.
    let plan = null
    let budget = null
    let burn = null
    if (workspace !== null) {
      const options = { dir: settings.logDirectory }
      const ledger = await readLedger(workspace, options)
      const stored = await readBudget(workspace, options)
      const storedPlan = await readPlan(workspace, options)
      const actuals = actualsByLabel(ledger.entries)
      const spentUsd = ledger.costs.reduce((sum, record) => sum + (typeof record.deltaUsd === 'number' ? record.deltaUsd : 0), 0)
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
      complete: tree.complete,
      language: settings.language,
      plan,
      budget,
      updatedAt: now.toISOString(),
      ...summary,
      totals: { ...summary.totals, sessions: summary.sessions.length }
    }
}

const apply = (ctx) => {
  const settings = config(ctx.config)
  const state = { flushed: new Map() }

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
      // Returning the promise lets a caller (and the tests) await the write; the
      // HTTP server ignores a handler's return value.
      return buildSummary(ctx, settings, state, sessionId).then(
        (body) => sendJson(res, body),
        (error) => sendJson(res, { ok: false, reason: 'internal', message: error instanceof Error ? error.message : String(error) })
      )
    }
  }))
}

export { apply, buildSummary as __buildSummary, config as __config, collectTree as __collectTree, modelOf as __modelOf, priceSession as __priceSession, rootOf as __rootOf, SUMMARY_PATH as __summaryPath }
export { PLUGIN_VERSION }
