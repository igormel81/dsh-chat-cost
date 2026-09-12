/**
 * The activation path: `apply(ctx, config)` against a stub host. This is what
 * the harness actually runs at boot — route registration, tool registration,
 * the turn-driven flush wiring and disposal.
 *
 * The stub refuses `ctx.config` exactly as Cordis does: a property the plugin
 * did not inject throws there, and reading config from the context instead of
 * the second argument once took the whole host down at boot. The Proxy below
 * keeps that mistake from passing here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** A minimal stand-in for the Cordis host context the plugin boots into. */
function hostContext({ sessions = [], projections = true, withTools = true, withQuery = false, config = {} } = {}) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const routes = []
  const registered = []
  const listeners = []
  const disposers = []

  const webServer = { register: (route) => { routes.push(route); return () => {} } }

  const base = {
    // `inject: ['webServer']` publishes the service as a context property; the
    // stub must model that, not only ctx.get().
    webServer,
    get(name) {
      if (name === 'sessions') return { get: (id) => byId.get(id), list: () => [...byId.values()] }
      if (name === 'sessionProjections') return projections ? { stateOf: (session, key) => (key === 'tokenUsage' ? session.usage : null) } : undefined
      if (name === 'tools') return withTools ? { register: (tool) => { registered.push(tool); return () => {} } } : undefined
      if (name === 'sessionQuery') {
        return withQuery ? { traceSession: async () => ({ root: sessions[0]?.id, complete: true, descendants: [] }) } : undefined
      }
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    // Exposed for assertions.
    __routes: routes,
    __tools: registered,
    __listeners: listeners,
    __dispose: () => { for (const disposer of disposers) disposer() }
  }
  const ctx = new Proxy(base, {
    get(target, property) {
      if (property === 'config') {
        throw new Error('cannot get property "config" without inject')
      }
      return Reflect.get(target, property)
    }
  })

  return ctx
}

function session(id, { cwd, parent, provider = 'deepseek-official', model = 'deepseek-flash', usage = null } = {}) {
  return {
    id,
    header: { version: 1, id, createdAt: '2026-09-12T00:00:00.000Z', ...(cwd ? { cwd } : {}), ...(parent ? { parentSession: parent } : {}) },
    events: [{ type: 'request/header', data: { header: { config: { provider, model } } } }],
    usage
  }
}

/** A stand-in for the node:http response the route handler writes to. */
function fakeResponse() {
  const captured = { status: null, headers: null, body: null }
  return {
    captured,
    res: {
      writeHead: (status, headers) => { captured.status = status; captured.headers = headers },
      end: (payload) => { captured.body = payload }
    }
  }
}

test('apply registers the summary route and all six tools', () => {
  const ctx = hostContext({ sessions: [] })
  apply(ctx, {})

  assert.equal(ctx.__routes.length, 1)
  assert.equal(ctx.__routes[0].kind, 'exact')
  assert.equal(ctx.__routes[0].path, '/api/plugins/dsh-chat-cost/summary')
  assert.equal(typeof ctx.__routes[0].handler, 'function')

  assert.deepEqual(ctx.__tools.map((tool) => tool.name).sort(), [
    'cost_estimate', 'cost_history', 'cost_mark', 'cost_plan', 'cost_price', 'cost_scenarios'
  ])
  for (const tool of ctx.__tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} has a body`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} can render`)
  }

  const events = ctx.__listeners.map((entry) => entry.event)
  assert.deepEqual(events, ['session/event'], 'the turn-driven flush subscribes to session events')
})

test('a composition without the tools registry still boots', () => {
  const ctx = hostContext({ sessions: [], withTools: false })
  apply(ctx, {})
  assert.equal(ctx.__routes.length, 1, 'the widget route is registered regardless')
  assert.equal(ctx.__tools.length, 0)
})

test('the route answers with a real summary for the session tree', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-boot-'))
  const ctx = hostContext({
    sessions: [
      session('root', { cwd: project, usage: { uncachedInputTokens: 1000000 } }),
      session('child', { cwd: project, parent: 'root', provider: 'moonshot', model: 'kimi-k3', usage: { outputTokens: 1000 } })
    ]
  })
  apply(ctx, {})
  const handler = ctx.__routes[0].handler

  const { res, captured } = fakeResponse()
  await handler({ method: 'GET', url: '/api/plugins/dsh-chat-cost/summary?sessionId=root' }, res)

  assert.equal(captured.status, 200)
  assert.equal(captured.headers['cache-control'], 'no-store')
  const body = JSON.parse(captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.rootSessionId, 'root')
  assert.equal(body.totals.sessions, 2)
  assert.equal(body.totals.subagentCount, 1)
  assert.ok(body.totals.usd > 0)
  assert.equal(body.logPath, join(project, '.dsh-cost', 'cost.jsonl'))

  // The boot-time request already wrote the log, without any client polling.
  const lines = (await readFile(body.logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
})

test('the route rejects a wrong method and a missing session id by name', async () => {
  const ctx = hostContext({ sessions: [session('root', { cwd: '/tmp' })] })
  apply(ctx, {})
  const handler = ctx.__routes[0].handler

  const post = fakeResponse()
  await handler({ method: 'POST', url: '/api/plugins/dsh-chat-cost/summary?sessionId=root' }, post.res)
  assert.deepEqual(JSON.parse(post.captured.body), { ok: false, reason: 'method' })

  const missing = fakeResponse()
  await handler({ method: 'GET', url: '/api/plugins/dsh-chat-cost/summary' }, missing.res)
  assert.deepEqual(JSON.parse(missing.captured.body), { ok: false, reason: 'sessionId-required' })

  const unknown = fakeResponse()
  await handler({ method: 'GET', url: '/api/plugins/dsh-chat-cost/summary?sessionId=nope' }, unknown.res)
  assert.deepEqual(JSON.parse(unknown.captured.body), { ok: false, reason: 'unknown-session' })
})

test('a turn in a subagent schedules a flush of its whole tree, and disposal is quiet', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-turn-'))
  const ctx = hostContext({
    sessions: [
      session('root', { cwd: project, usage: { outputTokens: 500 } }),
      session('child', { cwd: project, parent: 'root', usage: { outputTokens: 25 } })
    ]
  })
  apply(ctx, {})
  const listener = ctx.__listeners.find((entry) => entry.event === 'session/event').listener

  // A turn end fires the debounced flush; other events are ignored.
  assert.doesNotThrow(() => listener({ id: 'child', header: { parentSession: 'root' } }, { type: 'step/end' }))
  assert.doesNotThrow(() => listener({ id: 'child', header: { parentSession: 'root' } }, { type: 'turn/end' }))

  await new Promise((resolve) => setTimeout(resolve, 1700))
  const log = await readFile(join(project, '.dsh-cost', 'cost.jsonl'), 'utf8')
  assert.ok(log.trim().length > 0, 'the turn-driven flush wrote the log on its own')

  assert.doesNotThrow(() => ctx.__dispose())
  assert.doesNotThrow(() => ctx.__dispose(), 'disposal is idempotent')
})
