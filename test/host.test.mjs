/**
 * Host-half tests with stubbed harness services: the session tree walk, pricing
 * per session, the JSONL cost log (including its delta logic) and the failure
 * modes. No live harness is required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_VERSION, __buildSummary, __collectTree, __config, __createState, __defaultLedgerTailBytes, __modelOf, __rootOf } from '../lib/index.js'
import { appendCostLog, appendMarks, costRecord, markRecord } from '../lib/log.js'

function session({ id, cwd, parent = undefined, provider = 'deepseek-official', model = 'deepseek-flash', usage = null }) {
  return {
    id,
    header: { version: 1, id, createdAt: '2026-09-12T00:00:00.000Z', ...(cwd ? { cwd } : {}), ...(parent ? { parentSession: parent } : {}) },
    events: provider === null ? [] : [{ type: 'request/header', data: { header: { config: { provider, model } } } }],
    usage
  }
}

function context({ sessions, query, projections = true }) {
  const byId = new Map(sessions.map((entry) => [entry.id, entry]))
  return {
    get(name) {
      if (name === 'sessions') return { get: (id) => byId.get(id), list: () => [...byId.values()] }
      if (name === 'sessionProjections') return projections ? { stateOf: (entry, key) => (key === 'tokenUsage' ? entry.usage : null) } : undefined
      if (name === 'sessionQuery') return query
      return undefined
    }
  }
}

/** Monday noon UTC: outside both DeepSeek peak windows, so the tariff is fixed. */
const OFF_PEAK = new Date('2026-09-14T12:00:00Z')
/** Monday 07:00 UTC: inside the 06:00-10:00 peak window, where the price doubles. */
const PEAK = new Date('2026-09-14T07:00:00Z')
/** Price the tree at a pinned moment; a price test must not depend on when it runs. */
const summaryAt = (ctx, settings, state, sessionId, now = OFF_PEAK) => __buildSummary(ctx, settings, state, sessionId, now)

const settings = __config({})

test('a live chat plus a live subagent are priced into one tree and logged', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } })
  const child = session({ id: 'child', parent: 'root', provider: 'moonshot', model: 'kimi-k3', usage: { outputTokens: 1000 } })
  const ctx = context({ sessions: [root, child] })

  const summary = await summaryAt(ctx, settings, __createState(), 'root')

  assert.equal(summary.ok, true)
  assert.equal(summary.rootSessionId, 'root')
  assert.equal(summary.workspace, project)
  assert.equal(summary.totals.sessions, 2)
  assert.equal(summary.totals.subagentCount, 1)
  assert.equal(summary.self.sessionId, 'root')
  assert.equal(summary.subagents[0].sessionId, 'child')
  assert.equal(summary.subagents[0].depth, 1)
  assert.equal(summary.sessions[0].pricingSource, 'official')
  assert.equal(summary.sessions[1].pricingSource, 'catalog')
  // DeepSeek flash off-peak: 1M input at 0.15 -> 0.15; Kimi K3: 1000 output at 15/1M -> 0.015
  assert.ok(Math.abs(summary.sessions[0].usd - 0.15) < 1e-9, `root usd ${summary.sessions[0].usd}`)
  assert.ok(Math.abs(summary.sessions[1].usd - 0.015) < 1e-9, `child usd ${summary.sessions[1].usd}`)
  assert.ok(Math.abs(summary.totals.usd - 0.165) < 1e-9)
  assert.equal(summary.logPath, join(project, '.dsh-cost', 'cost.jsonl'))
  assert.equal(summary.logError, null)

  const lines = (await readFile(summary.logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  const records = lines.map((line) => JSON.parse(line))
  const childRecord = records.find((record) => record.sessionId === 'child')
  assert.equal(childRecord.kind, 'subagent')
  assert.equal(childRecord.rootSessionId, 'root')
  assert.equal(childRecord.parentSessionId, 'root')
  assert.equal(childRecord.model, 'kimi-k3')
  assert.equal(childRecord.pricingSource, 'catalog')
  assert.equal(childRecord.plugin, `dsh-chat-cost@${PLUGIN_VERSION}`, 'the record names the release that wrote it')
  assert.equal(await readFile(join(project, '.gitignore'), 'utf8'), '.dsh-cost/\n')
})

test('an unchanged tree writes nothing, a changed session appends only its delta', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000000 } })
  const ctx = context({ sessions: [root] })
  const state = __createState()

  const first = await summaryAt(ctx, settings, state, 'root')
  const afterFirst = (await readFile(first.logPath, 'utf8')).trim().split('\n').length
  assert.equal(afterFirst, 1)

  const second = await summaryAt(ctx, settings, state, 'root')
  assert.equal((await readFile(second.logPath, 'utf8')).trim().split('\n').length, 1, 'no new line without a change')

  root.usage = { uncachedInputTokens: 2000000 }
  const third = await summaryAt(ctx, settings, state, 'root')
  const lines = (await readFile(third.logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  const last = JSON.parse(lines[1])
  assert.ok(Math.abs(last.deltaUsd - 0.15) < 1e-9, `delta ${last.deltaUsd}`)
  assert.ok(Math.abs(last.cumulativeUsd - 0.3) < 1e-9)
})

test('a persisted-only child is reported unpriced instead of estimated', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 1000000 } })
  const query = {
    traceSession: async () => ({ root: 'root', complete: true, descendants: [{ sessionId: 'cold-1', parentId: 'root', depth: 1 }] })
  }
  const summary = await summaryAt(context({ sessions: [root], query }), settings, __createState(), 'root')

  assert.equal(summary.totals.sessions, 2)
  assert.deepEqual(summary.totals.unpricedSessions, ['cold-1'])
  assert.equal(summary.subagents[0].live, false)
  assert.equal(summary.subagents[0].usd, null)
  assert.ok(Math.abs(summary.totals.usd - summary.sessions[0].usd) < 1e-9, 'totals cover only priced sessions')
  const records = (await readFile(summary.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.length, 1, 'an unpriced session is not logged as a figure')
})

test('a model with no catalog price stays unpriced and does not poison the tree total', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, provider: 'unknown-vendor', model: 'mystery-1', usage: { outputTokens: 500 } })
  const ctx = context({ sessions: [root] })
  const summary = await summaryAt(ctx, settings, __createState(), 'root')

  assert.equal(summary.sessions[0].pricingSource, 'none')
  assert.equal(summary.sessions[0].usd, null)
  assert.equal(summary.totals.usd, null)
  assert.equal(summary.logPath, null, 'nothing is logged without a price')
})

test('writeLog: false never touches the project folder', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 100 } })
  const summary = await summaryAt(context({ sessions: [root] }), __config({ writeLog: false }), __createState(), 'root')
  await assert.rejects(() => readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8'))
  assert.equal(summary.logPath, null)
})

test('unknown sessions and a missing store fail with named reasons', async () => {
  const ctx = context({ sessions: [] })
  assert.deepEqual(await summaryAt(ctx, settings, __createState(), 'nope'), { ok: false, reason: 'unknown-session' })

  const empty = { get: () => undefined }
  assert.deepEqual(await summaryAt(empty, settings, __createState(), 'root'), { ok: false, reason: 'session-store-unavailable' })
})

test('a custom log directory is respected', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 100 } })
  const summary = await summaryAt(context({ sessions: [root] }), __config({ logDir: '.cost' }), __createState(), 'root')
  assert.equal(summary.logPath, join(project, '.cost', 'cost.jsonl'))
  assert.equal(await readFile(join(project, '.gitignore'), 'utf8'), '.cost/\n')
})

test('the tree walk falls back to the live store when no query engine is mounted', async () => {
  const root = session({ id: 'root', cwd: '/tmp' })
  const child = session({ id: 'child', parent: 'root' })
  const grandchild = session({ id: 'grandchild', parent: 'child' })
  const ctx = context({ sessions: [root, child, grandchild] })
  const tree = await __collectTree(ctx, 'root', AbortSignal.timeout(1000))
  assert.deepEqual(tree.ids, ['root', 'child', 'grandchild'])
  assert.equal(tree.parents.get('grandchild'), 'child')
  assert.equal(tree.complete, true)

  const withoutStore = await __collectTree({ get: () => undefined }, 'root', AbortSignal.timeout(1000))
  assert.deepEqual(withoutStore.ids, ['root'])
  assert.equal(withoutStore.complete, false)
})

test('model attribution reads the newest request header', () => {
  const value = session({ id: 's', provider: 'anthropic', model: 'claude-opus-5' })
  value.events.push({ type: 'request/header', data: { header: { config: { provider: 'moonshot', model: 'kimi-k3' } } } })
  assert.deepEqual(__modelOf(value), { provider: 'moonshot', model: 'kimi-k3' })
  assert.equal(__modelOf(session({ id: 's', provider: null })), null)
  assert.equal(__modelOf(undefined), null)
})

test('the Host forwards its configured language to the client', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 10 } })
  const summary = await summaryAt(context({ sessions: [root] }), __config({ language: 'ru' }), __createState(), 'root')
  assert.equal(summary.language, 'ru')
  const plain = await summaryAt(context({ sessions: [root] }), __config({}), __createState(), 'root')
  assert.equal(plain.language, null, 'an unset language lets the client fall back')
})

test('a turn in a subagent flushes the whole tree it belongs to', () => {
  const root = session({ id: 'root', cwd: '/tmp' })
  const child = session({ id: 'child', parent: 'root' })
  const grandchild = session({ id: 'grandchild', parent: 'child' })
  const store = context({ sessions: [root, child, grandchild] }).get('sessions')
  assert.equal(__rootOf(grandchild, store), 'root')
  assert.equal(__rootOf(root, store), 'root')

  // A released parent ends the walk at the last live ancestor instead of a dead id.
  const orphan = session({ id: 'orphan', parent: 'gone' })
  assert.equal(__rootOf(orphan, store), 'orphan')

  // A cycle cannot loop forever.
  const first = session({ id: 'a', parent: 'b' })
  const second = session({ id: 'b', parent: 'a' })
  const cyclic = context({ sessions: [first, second] }).get('sessions')
  assert.ok(['a', 'b'].includes(__rootOf(first, cyclic)))
})

test('config defaults are conservative', () => {
  assert.deepEqual(__config(undefined), { writeLog: true, logDirectory: '.dsh-cost', language: null, ledgerTailBytes: __defaultLedgerTailBytes })
  assert.equal(__config({ writeLog: false }).writeLog, false)
  assert.equal(__config({ logDir: '  ' }).logDirectory, '.dsh-cost')
  assert.equal(__config({ language: 'zh' }).language, 'zh')
})

test('spend that no plan unit claimed is reported as unlabelled', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await appendCostLog(project, [costRecord({ sessionId: 'root', model: 'deepseek-flash', deltaUsd: 0.42, cumulativeUsd: 0.42, usage: { outputTokens: 1000 } })], {})
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 1000 } })
  const summary = await summaryAt(context({ sessions: [root] }), settings, __createState(), 'root')

  assert.equal(summary.ok, true)
  assert.ok(Math.abs(summary.unlabeledUsd - 0.42) < 1e-9, `expected the unclaimed spend, got ${summary.unlabeledUsd}`)
  assert.equal(summary.ledger.records, 1)
  assert.equal(summary.ledger.truncated, false)
})

test('a mark claims the spend that follows it, so nothing stays unlabelled', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await appendMarks(project, [markRecord({ sessionId: 'root', label: 'research' })], {})
  await appendCostLog(project, [costRecord({ sessionId: 'root', model: 'deepseek-flash', deltaUsd: 0.42, cumulativeUsd: 0.42, usage: { outputTokens: 1000 } })], {})
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 1000 } })
  const summary = await summaryAt(context({ sessions: [root] }), settings, __createState(), 'root')

  assert.equal(summary.unlabeledUsd, 0)
  assert.equal(summary.ledger.marks, 1)
})

test('a second run over an unchanged tree appends nothing and reuses the read', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000000 } })
  const ctx = context({ sessions: [root] })
  const state = __createState()

  const first = await summaryAt(ctx, settings, state, 'root')
  assert.equal(first.ledger.records, 1, 'the first run records the interval')
  assert.equal(state.ledgerCache.size, 0, 'a write invalidates the cached read')

  const second = await summaryAt(ctx, settings, state, 'root')
  assert.equal(second.ledger.records, 1, 'an unchanged tree adds no record')
  assert.equal(second.totals.usd, first.totals.usd, 'and the figure holds')
  assert.equal(state.ledgerCache.size, 1, 'a run that writes nothing leaves the read cached for the next poll')

  // The interval is priced once: adding tokens prices only the difference.
  root.usage = { uncachedInputTokens: 2000000 }
  const third = await summaryAt(ctx, settings, state, 'root')
  assert.equal(third.ledger.records, 2)
  assert.ok(Math.abs(third.totals.usd - 0.3) < 1e-9, `expected 1M off-peak + 1M more = 0.30, got ${third.totals.usd}`)
  assert.equal(state.ledgerCache.size, 0, 'and the new record invalidates it again')
})

test('a session carrying the real projection state is priced, not reported as free', async () => {
  // The harness hands over { totals, last }, and reading only the top level made
  // every live chat cost $0. Both shapes must price identically.
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-shape-'))
  const flat = session({ id: 'flat', cwd: project, usage: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  const projected = session({
    id: 'projected',
    cwd: project,
    usage: {
      totals: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      last: { turn: 1, step: 1, buckets: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } }
    }
  })

  const fromFlat = await summaryAt(context({ sessions: [flat] }), settings, __createState(), 'flat')
  const fromProjection = await summaryAt(context({ sessions: [projected] }), settings, __createState(), 'projected')

  assert.ok(Math.abs(fromProjection.self.usd - 0.15) < 1e-9, `projected usd ${fromProjection.self.usd}`)
  assert.equal(fromProjection.self.usd, fromFlat.self.usd, 'the wrapper must not change the price')
  assert.equal(fromProjection.self.tokens.cacheRead, 0, 'totals wins over the last step')
  assert.equal(fromProjection.self.tokens.uncachedInput, 1000000)
})

test('a chat that is not open is priced from the log instead of reported as nothing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-recorded-'))
  const past = 'session-past'
  await appendCostLog(project, [
    costRecord({
      plugin: 'dsh-chat-cost@0.5.4',
      sessionId: past,
      rootSessionId: past,
      depth: 0,
      kind: 'chat',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSource: 'official',
      tier: 'off-peak',
      usage: { uncachedInputTokens: 2000000, outputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cumulativeUsd: 0.36,
      deltaUsd: 0.36
    })
  ])

  // The store holds nothing live; only the query engine knows where it lived.
  const ctx = context({
    sessions: [],
    query: {
      traceSession: async () => ({
        target: { header: { id: past, cwd: project } },
        root: { header: { id: past, cwd: project } },
        descendants: [],
        complete: true
      })
    }
  })

  const before = (await readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8')).trim().split('\n').length
  const summary = await summaryAt(ctx, settings, __createState(), past)

  assert.equal(summary.ok, true)
  assert.equal(summary.recorded, true, 'the answer says the numbers come from the log')
  assert.equal(summary.workspace, project)
  assert.equal(summary.sessions[0].live, false)
  assert.equal(summary.sessions[0].model, 'deepseek-flash')
  assert.equal(summary.totals.usd, 0.36)
  assert.equal(summary.totals.sessions, 1)
  assert.equal(summary.self.totalTokens, 2100000, 'the logged tokens are shown')

  // Nothing new was spent, so nothing was appended for it.
  const after = (await readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8')).trim().split('\n').length
  assert.equal(after, before, 'a session that is not live has no delta to record')
})

test('a session the log never saw is reported without a price, and an unresolvable one is unknown', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-recorded-empty-'))
  const ctx = context({
    sessions: [],
    query: {
      traceSession: async () => ({
        target: { header: { id: 'never-logged', cwd: project } },
        root: { header: { id: 'never-logged', cwd: project } },
        descendants: [],
        complete: true
      })
    }
  })

  const summary = await summaryAt(ctx, settings, __createState(), 'never-logged')
  assert.equal(summary.ok, true)
  assert.equal(summary.recorded, true)
  assert.equal(summary.totals.usd, null, 'no record, no invented price')
  assert.deepEqual(summary.totals.unpricedSessions, ['never-logged'])

  // Neither live nor traceable: the answer stays what it was.
  const blind = context({ sessions: [], query: { traceSession: async () => { throw new Error('not found') } } })
  assert.deepEqual(await summaryAt(blind, settings, __createState(), 'gone'), { ok: false, reason: 'unknown-session' })
})

test('the summary carries a price per turn, so an answer can show its own cost', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-turns-'))
  const root = session({
    id: 'root',
    cwd: project,
    usage: { uncachedInputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  })
  root.events = [
    ...root.events,
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1000000, outputTokens: 0 } } },
    { type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 500000, outputTokens: 0 } } }
  ]

  const summary = await summaryAt(context({ sessions: [root] }), settings, __createState(), 'root')

  assert.equal(Array.isArray(summary.turns), true)
  assert.deepEqual(summary.turns.map((turn) => turn.turn), [1, 2])
  // DeepSeek flash off-peak: 0.15 per million input tokens.
  assert.ok(Math.abs(summary.turns[0].usd - 0.15) < 1e-9, `turn 1 usd ${summary.turns[0].usd}`)
  assert.ok(Math.abs(summary.turns[1].usd - 0.075) < 1e-9, `turn 2 usd ${summary.turns[1].usd}`)
  assert.equal(summary.turns[0].model, 'deepseek-flash')
  assert.equal(summary.turns[0].pricingSource, 'official')
  assert.equal(summary.turns[0].tier, 'off-peak')
  assert.equal(summary.turns[0].tokens, 1000000)
})

test('a chat priced from the log has no per-turn numbers to offer', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-turns-recorded-'))
  await appendCostLog(project, [
    costRecord({ sessionId: 'past', rootSessionId: 'past', depth: 0, kind: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', usage: { uncachedInputTokens: 1000 }, cumulativeUsd: 0.00015, deltaUsd: 0.00015 })
  ])
  const ctx = context({
    sessions: [],
    query: { traceSession: async () => ({ target: { header: { id: 'past', cwd: project } }, root: { header: { id: 'past', cwd: project } }, descendants: [], complete: true }) }
  })

  const summary = await summaryAt(ctx, settings, __createState(), 'past')
  assert.equal(summary.recorded, true)
  assert.deepEqual(summary.turns, [], 'the log has no turn boundaries, so none are invented')
})

test('the same tokens cost double inside a DeepSeek peak window, and the record says which', async () => {
  // The suite used to assert off-peak prices against the wall clock, so it failed
  // between 01:00-04:00 and 06:00-10:00 UTC on weekdays — in CI as well. The clock
  // is now an argument, and this test is the reason it exists.
  const offProject = await mkdtemp(join(tmpdir(), 'dsh-cost-peak-off-'))
  const peakProject = await mkdtemp(join(tmpdir(), 'dsh-cost-peak-on-'))
  const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }

  const off = await summaryAt(context({ sessions: [session({ id: 'root', cwd: offProject, usage })] }), settings, __createState(), 'root', OFF_PEAK)
  const on = await summaryAt(context({ sessions: [session({ id: 'root', cwd: peakProject, usage })] }), settings, __createState(), 'root', PEAK)

  assert.ok(Math.abs(off.self.usd - 0.15) < 1e-9, `off-peak usd ${off.self.usd}`)
  assert.ok(Math.abs(on.self.usd - 0.3) < 1e-9, `peak usd ${on.self.usd}`)
  assert.equal(off.self.tier, 'off-peak')
  assert.equal(on.self.tier, 'peak')

  // And the interval is not re-priced later: viewing an off-peak chat during a
  // peak window keeps the tariff it was billed at, which is the whole point of
  // pricing deltas instead of snapshots.
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-peak-recorded-'))
  const root = session({ id: 'root', cwd: project, usage })
  const state = __createState()
  const first = await summaryAt(context({ sessions: [root] }), settings, state, 'root', OFF_PEAK)
  const later = await summaryAt(context({ sessions: [root] }), settings, state, 'root', PEAK)

  assert.ok(Math.abs(first.self.usd - 0.15) < 1e-9)
  assert.ok(Math.abs(later.self.usd - 0.15) < 1e-9, `recorded interval re-priced at peak: ${later.self.usd}`)
  assert.equal(later.self.tier, 'off-peak', 'the record keeps the tariff it was written with')
})

test('the summary names the release that produced it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-version-'))
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000 } })
  const summary = await summaryAt(context({ sessions: [root] }), settings, __createState(), 'root')
  assert.equal(summary.version, PLUGIN_VERSION, 'the readout can answer "which version am I running"')
})
