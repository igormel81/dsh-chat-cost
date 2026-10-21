import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __buildSummary, __config, __createState, __modelOf } from '../lib/index.js'

const route = { provider: 'deepseek-official', model: 'deepseek-flash' }
const otherRoute = { provider: 'moonshot', model: 'kimi-k3' }
const now = new Date('2026-09-14T12:00:00Z')

function session(id, parentSession) {
  return { id, header: { id, parentSession }, events: [], usage: { outputTokens: 1000 },
    modelSelection: { lastUsed: route, pending: otherRoute } }
}

function context(sessions, { query, cache } = {}) {
  const store = new Map(sessions.map(s => [s.id, s]))
  return {
    get(name) {
      if (name === 'sessions') return { get: id => store.get(id), list: () => [...store.values()] }
      if (name === 'sessionProjections') return { stateOf: (s, key) => key === 'tokenUsage' ? s.usage : s.modelSelection }
      if (name === 'sessionQuery') return query
      if (name === 'sessionProjectionCache') return cache
      return undefined
    }
  }
}

test('a session without raw headers uses the last actual route, not the pending choice', () => {
  const s = session('root')
  assert.deepEqual(__modelOf(s, context([s])), route)
  s.events = undefined
  assert.deepEqual(__modelOf(s, context([s])), route)
})

test('raw request headers take precedence over the model-selection fallback', () => {
  const s = session('root')
  s.events.push({ type: 'request/header', data: { header: { config: otherRoute } } })
  assert.deepEqual(__modelOf(s, context([s])), otherRoute)
})

test('a pending or incomplete route cannot be used to charge a session', () => {
  const s = session('root')
  for (const state of [{ pending: route }, { lastUsed: { provider: route.provider } }, { lastUsed: null }]) {
    s.modelSelection = state
    assert.equal(__modelOf(s, context([s])), null)
  }
  assert.equal(__modelOf(s, { get: () => ({ stateOf() { throw new Error('unavailable') } }) }), null)
})

test('live roots and subagents remain priced when the host omits request headers', async () => {
  const root = session('root')
  root.events.push({ type: 'assistant/message', data: { turn: 1, step: 1, usage: { outputTokens: 1000 } } })
  const child = session('child', 'root')
  child.modelSelection = { lastUsed: otherRoute }
  const result = await __buildSummary(context([root, child]), __config({ writeLog: false }), __createState(), 'root', now)
  assert.equal(result.self.provider, route.provider)
  assert.equal(result.self.model, route.model)
  assert.equal(result.subagents[0].provider, otherRoute.provider)
  assert.ok(Math.abs(result.self.usd - 0.0006) < 1e-9)
  assert.ok(Math.abs(result.subagents[0].usd - 0.015) < 1e-9)
  assert.ok(Math.abs(result.totals.usd - 0.0156) < 1e-9)
  assert.ok(Math.abs(result.turns[0].usd - 0.0006) < 1e-9)
})

test('an entirely released tree can inherit its root checkpoint route without a ledger', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-attribution-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const root = { id: 'root', cwd }
  const child = { id: 'child', parentSession: 'root', cwd }
  const query = { traceSession: async () => ({
    root: { header: root }, target: { header: root },
    descendants: [{ session: { header: child }, descendants: [] }], complete: true
  }) }
  const cache = { cachedSnapshot: header => ({ values: {
    tokenUsage: { outputTokens: 1000 },
    modelSelection: header.id === 'root' ? { lastUsed: route } : { pending: otherRoute }
  } }) }
  const result = await __buildSummary(context([], { query, cache }), __config({ writeLog: false }), __createState(), 'root', now)
  assert.equal(result.self.modelSource, 'session')
  assert.equal(result.subagents[0].modelSource, 'inherited')
  assert.equal(result.subagents[0].model, route.model)
  assert.ok(Math.abs(result.totals.usd - 0.0012) < 1e-9)
})

test('released subagents use their own checkpoint route before inheriting the root route', async t => {
  for (const method of ['cachedSnapshot', 'coldSnapshot']) {
    await t.test(method, async () => {
      const root = session('root')
      const header = { id: 'child', parentSession: 'root' }
      const query = { traceSession: async () => ({
        root: { header: root.header }, target: { header: root.header },
        descendants: [{ session: { header }, descendants: [] }], complete: true
      }) }
      const snapshot = { values: { tokenUsage: { outputTokens: 1000 }, modelSelection: { lastUsed: otherRoute } } }
      const result = await __buildSummary(context([root], { query, cache: { [method]: () => snapshot } }),
        __config({ writeLog: false }), __createState(), 'root', now)
      const child = result.subagents[0]
      assert.equal(child.provider, otherRoute.provider)
      assert.equal(child.model, otherRoute.model)
      assert.equal(child.modelSource, 'session')
      assert.ok(Math.abs(child.usd - 0.015) < 1e-9)
    })
  }
})
