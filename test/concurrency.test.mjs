/**
 * Overlapping flushes. The widget polls, a second tab may poll at the same time,
 * and a turn end fires its own flush — the ledger must still gain one line per
 * change, and the queue must be per session tree rather than global.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __buildSummary, __config, __createState } from '../lib/index.js'

function session(id, cwd, tokens) {
  return {
    id,
    header: { version: 1, id, createdAt: '2026-09-12T00:00:00.000Z', cwd },
    events: [{ type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }],
    usage: { uncachedInputTokens: tokens }
  }
}

function contextFor(sessions) {
  const byId = new Map(sessions.map((entry) => [entry.id, entry]))
  return {
    get(name) {
      if (name === 'sessions') return { get: (id) => byId.get(id), list: () => [...byId.values()] }
      if (name === 'sessionProjections') return { stateOf: (session) => session.usage }
      return undefined
    }
  }
}

async function ledgerLines(project) {
  const text = await readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8')
  return text.trim().split('\n').filter((line) => line !== '')
}

test('three overlapping requests for one tree write one ledger line', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-race-'))
  const ctx = contextFor([session('root', project, 1000000)])
  const settings = __config({})
  const state = __createState()

  const results = await Promise.all([
    __buildSummary(ctx, settings, state, 'root'),
    __buildSummary(ctx, settings, state, 'root'),
    __buildSummary(ctx, settings, state, 'root')
  ])
  assert.equal(results.every((result) => result.ok === true), true)
  assert.equal(results[0].totals.usd, results[2].totals.usd, 'every caller sees the same figure')

  const lines = await ledgerLines(project)
  assert.equal(lines.length, 1, `one change, one line — got ${lines.length}`)
})

test('a later change still appends exactly one more line', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-race-'))
  const root = session('root', project, 1000000)
  const ctx = contextFor([root])
  const settings = __config({})
  const state = __createState()

  await Promise.all([__buildSummary(ctx, settings, state, 'root'), __buildSummary(ctx, settings, state, 'root')])
  root.usage = { uncachedInputTokens: 2000000 }
  await Promise.all([__buildSummary(ctx, settings, state, 'root'), __buildSummary(ctx, settings, state, 'root')])

  const lines = await ledgerLines(project)
  assert.equal(lines.length, 2)
  const records = lines.map((line) => JSON.parse(line))
  assert.equal(records[0].cumulativeUsd, 0.15)
  assert.equal(records[1].cumulativeUsd, 0.3)
  assert.ok(Math.abs(records[1].deltaUsd - 0.15) < 1e-9)
})

test('the queue is per session tree, so two chats flush independently', async () => {
  const first = await mkdtemp(join(tmpdir(), 'dsh-cost-a-'))
  const second = await mkdtemp(join(tmpdir(), 'dsh-cost-b-'))
  const ctx = contextFor([session('a', first, 1000000), session('b', second, 500000)])
  const settings = __config({})
  const state = __createState()

  const [a, b] = await Promise.all([
    __buildSummary(ctx, settings, state, 'a'),
    __buildSummary(ctx, settings, state, 'b')
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal((await ledgerLines(first)).length, 1)
  assert.equal((await ledgerLines(second)).length, 1)
  assert.deepEqual(state.locks.busy(), [], 'finished trees leave no queue behind')
})
