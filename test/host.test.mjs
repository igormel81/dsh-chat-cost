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
import { __buildSummary, __collectTree, __config, __modelOf, __rootOf } from '../lib/index.js'

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

  const summary = await __buildSummary(ctx, settings, { flushed: new Map() }, 'root')

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
  assert.equal(childRecord.plugin, 'dsh-chat-cost@0.4.3')
  assert.equal(await readFile(join(project, '.gitignore'), 'utf8'), '.dsh-cost/\n')
})

test('an unchanged tree writes nothing, a changed session appends only its delta', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { uncachedInputTokens: 1000000 } })
  const ctx = context({ sessions: [root] })
  const state = { flushed: new Map() }

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
  const summary = await __buildSummary(context({ sessions: [root], query }), settings, { flushed: new Map() }, 'root')

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
  const summary = await __buildSummary(ctx, settings, { flushed: new Map() }, 'root')

  assert.equal(summary.sessions[0].pricingSource, 'none')
  assert.equal(summary.sessions[0].usd, null)
  assert.equal(summary.totals.usd, null)
  assert.equal(summary.logPath, null, 'nothing is logged without a price')
})

test('writeLog: false never touches the project folder', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 100 } })
  const summary = await __buildSummary(context({ sessions: [root] }), __config({ writeLog: false }), { flushed: new Map() }, 'root')
  await assert.rejects(() => readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8'))
  assert.equal(summary.logPath, null)
})

test('unknown sessions and a missing store fail with named reasons', async () => {
  const ctx = context({ sessions: [] })
  assert.deepEqual(await __buildSummary(ctx, settings, { flushed: new Map() }, 'nope'), { ok: false, reason: 'unknown-session' })

  const empty = { get: () => undefined }
  assert.deepEqual(await __buildSummary(empty, settings, { flushed: new Map() }, 'root'), { ok: false, reason: 'session-store-unavailable' })
})

test('a custom log directory is respected', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-proj-'))
  await mkdir(join(project, '.git'), { recursive: true })
  const root = session({ id: 'root', cwd: project, usage: { outputTokens: 100 } })
  const summary = await __buildSummary(context({ sessions: [root] }), __config({ logDir: '.cost' }), { flushed: new Map() }, 'root')
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
  const summary = await __buildSummary(context({ sessions: [root] }), __config({ language: 'ru' }), { flushed: new Map() }, 'root')
  assert.equal(summary.language, 'ru')
  const plain = await __buildSummary(context({ sessions: [root] }), __config({}), { flushed: new Map() }, 'root')
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
  assert.deepEqual(__config(undefined), { writeLog: true, logDirectory: '.dsh-cost', language: null })
  assert.equal(__config({ writeLog: false }).writeLog, false)
  assert.equal(__config({ logDir: '  ' }).logDirectory, '.dsh-cost')
  assert.equal(__config({ language: 'zh' }).language, 'zh')
})
