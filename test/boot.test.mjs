/**
 * The loader contract: `apply(ctx, config)` on a real Cordis application.
 *
 * The stub-host activation suite models the host by hand, which is exactly how
 * a boot-breaking mistake once slipped through: the plugin read its settings
 * from `ctx.config`, and in this Cordis any property a plugin did not inject
 * throws "cannot get property ... without inject" — the whole plugin tree
 * failed to load and the host would not start. This suite boots the plugin on
 * the real Cordis the harness uses, so the contract is enforced rather than
 * imitated.
 *
 * `@deepseek-ai/cordis` resolves only inside a DSH profile, like the schema
 * validator, so outside one the suite reports a skip instead of passing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name as pluginName, __summaryPath as SUMMARY_PATH } from '../lib/index.js'

let cordis = null
try {
  cordis = await import('@deepseek-ai/cordis')
} catch {
  cordis = null
}

const NO_CORDIS = '@deepseek-ai/cordis is not resolvable here; install the plugin into a DSH profile to boot it for real'

/** A response object that records what the route handler wrote. */
function recorder() {
  const answer = { status: null, headers: null, body: '' }
  return {
    answer,
    res: {
      writeHead(status, headers) { answer.status = status; answer.headers = headers },
      end(payload) { answer.body = payload ?? '' }
    }
  }
}

/** A real Cordis app with the one service the plugin injects. */
function boot(config) {
  const routes = []
  const app = new cordis.Context()
  app.provide('webServer', {
    register: (route) => {
      routes.push(route)
      return () => { route.disposed = true }
    }
  })
  const fiber = app.plugin({ name: pluginName, inject, apply }, config)
  return { app, fiber, routes }
}

test('the plugin loads on a real Cordis app and registers its route', { skip: cordis === null ? NO_CORDIS : false }, async () => {
  const { fiber, routes } = boot({ writeLog: false })
  await fiber
  assert.equal(routes.length, 1, 'the summary route is registered once the plugin is active')
  assert.equal(routes[0].path, SUMMARY_PATH)
  assert.equal(typeof routes[0].handler, 'function')
  await fiber.dispose()
})

test('a config that arrives as the second argument is honoured, and a missing one is not an error', { skip: cordis === null ? NO_CORDIS : false }, async () => {
  // No config at all: the defaults must hold, and nothing may throw.
  const bare = boot(undefined)
  await bare.fiber
  assert.equal(bare.routes.length, 1)
  await bare.fiber.dispose()

  // An explicit config survives the boot: the route answers, which means the
  // plugin got as far as handling a request.
  const configured = boot({ writeLog: false, logDir: '.custom-cost', language: 'ru' })
  await configured.fiber
  const { answer, res } = recorder()
  await configured.routes[0].handler({ method: 'GET', url: SUMMARY_PATH + '?sessionId=missing&language=ru' }, res)
  assert.equal(answer.status, 200, 'the handler answers instead of the plugin failing to load')
  // No sessions service is mounted here, so the honest answer is exactly that
  // — the point is that the handler runs at all, on the real loader.
  assert.deepEqual(JSON.parse(answer.body), { ok: false, reason: 'session-store-unavailable' })

  // The same handler rejects a wrong method, so the route really is live.
  const bad = recorder()
  await configured.routes[0].handler({ method: 'POST', url: SUMMARY_PATH }, bad.res)
  assert.equal(JSON.parse(bad.answer.body).reason, 'method')
  await configured.fiber.dispose()
})

test('disposal takes the route down with it', { skip: cordis === null ? NO_CORDIS : false }, async () => {
  const { fiber, routes } = boot({ writeLog: false })
  await fiber
  await fiber.dispose()
  assert.equal(routes[0].disposed, true, 'the web server disposer ran')
})
