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

const settings = __config({})

test('a live chat plus a live subagent are priced into one tree and logged', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } })
  const child = session({ id: 'child', parent: 'root', provider: 'moonshot', model: 'kimi-k3', usage: { outputTokens: 1000 } })
  const ctx = context({ sessions: [root, child] })

  const summary = await __buildSummary(ctx, settings, __createState(), 'root')

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

  const first = await __buildSummary(ctx, settings, state, 'root')
  const afterFirst = (await readFile(first.logPath, 'utf8')).trim().split('\n').length
  assert.equal(afterFirst, 1)

  const second = await __buildSummary(ctx, settings, state, 'root')
  assert.equal((await readFile(second.logPath, 'utf8')).trim().split('\n').length, 1, 'no new line without a change')

  root.usage = { uncachedInputTokens: 2000000 }
  const third = await __buildSummary(ctx, settings, state, 'root')
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
  const summary = await __buildSummary(context({ sessions: [root], query }), settings, __createState(), 'root')

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
  const summary = await __buildSummary(ctx, settings, __createState(), 'root')

  assert.equal(summary.sessions[0].pricingSource, 'none')
  assert.equal(summary.sessions[0].usd, null)
  assert.equal(summary.totals.usd, null)
  assert.equal(summary.logPath, null, 'nothing is logged without a price')
})

test('writeLog: false never touches the project folder', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 100 } })
  const summary = await __buildSummary(context({ sessions: [root] }), __config({ writeLog: false }), __createState(), 'root')
  await assert.rejects(() => readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8'))
  assert.equal(summary.logPath, null)
})

test('unknown sessions and a missing store fail with named reasons', async () => {
  const ctx = context({ sessions: [] })
  assert.deepEqual(await __buildSummary(ctx, settings, __createState(), 'nope'), { ok: false, reason: 'unknown-session' })

  const empty = { get: () => undefined }
  assert.deepEqual(await __buildSummary(empty, settings, __createState(), 'root'), { ok: false, reason: 'session-store-unavailable' })
})

test('a custom log directory is respected', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 100 } })
  const summary = await __buildSummary(context({ sessions: [root] }), __config({ logDir: '.cost' }), __createState(), 'root')
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
  const summary = await __buildSummary(context({ sessions: [root] }), __config({ language: 'ru' }), __createState(), 'root')
  assert.equal(summary.language, 'ru')
  const plain = await __buildSummary(context({ sessions: [root] }), __config({}), __createState(), 'root')
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
  const summary = await __buildSummary(context({ sessions: [root] }), settings, __createState(), 'root')

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
  const summary = await __buildSummary(context({ sessions: [root] }), settings, __createState(), 'root')

  assert.equal(summary.unlabeledUsd, 0)
  assert.equal(summary.ledger.marks, 1)
})

test('a second run over an unchanged tree appends nothing and reuses the read', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000000 } })
  const ctx = context({ sessions: [root] })
  const state = __createState()

  const first = await __buildSummary(ctx, settings, state, 'root')
  assert.equal(first.ledger.records, 1, 'the first run records the interval')
  assert.equal(state.ledgerCache.size, 0, 'a write invalidates the cached read')

  const second = await __buildSummary(ctx, settings, state, 'root')
  assert.equal(second.ledger.records, 1, 'an unchanged tree adds no record')
  assert.equal(second.totals.usd, first.totals.usd, 'and the figure holds')
  assert.equal(state.ledgerCache.size, 1, 'a run that writes nothing leaves the read cached for the next poll')

  // The interval is priced once: adding tokens prices only the difference.
  root.usage = { uncachedInputTokens: 2000000 }
  const third = await __buildSummary(ctx, settings, state, 'root')
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

  const fromFlat = await __buildSummary(context({ sessions: [flat] }), settings, __createState(), 'flat')
  const fromProjection = await __buildSummary(context({ sessions: [projected] }), settings, __createState(), 'projected')

  assert.ok(Math.abs(fromProjection.self.usd - 0.15) < 1e-9, `projected usd ${fromProjection.self.usd}`)
  assert.equal(fromProjection.self.usd, fromFlat.self.usd, 'the wrapper must not change the price')
  assert.equal(fromProjection.self.tokens.cacheRead, 0, 'totals wins over the last step')
  assert.equal(fromProjection.self.tokens.uncachedInput, 1000000)
})
