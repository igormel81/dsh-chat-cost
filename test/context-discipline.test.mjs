/**
 * Context discipline: what a half of the plugin is allowed to touch on `ctx`.
 *
 * Cordis serves a plugin context through a proxy that throws
 * `cannot get property "<name>" without inject` for anything the plugin did not
 * declare in `inject`. That rule has now taken the host down once (0.5.0 read
 * settings from `ctx.config`) and broken the web shell once (0.5.1 fixed the
 * Host half and left the same read in the Client half), so it is checked
 * mechanically instead of being remembered.
 *
 * Services reached through `ctx.get(name)` are fine — that is the explicit,
 * optional lookup the shell's own plugins use — and so is the Cordis API
 * itself. Everything else must be declared in `inject`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Cordis API a plugin may call on its context without declaring it. */
const CONTEXT_API = new Set([
  'get', 'set', 'provide', 'inject', 'effect', 'on', 'once', 'off', 'emit',
  'parallel', 'waterfall', 'bail', 'plugin', 'dispose', 'start', 'stop',
  'scope', 'isolate', 'extend', 'logger', 'reflect', 'registry', 'fiber',
  'root', 'events', 'uid', 'name', 'config'
])

/**
 * Every property read on a context-like object in the source.
 *
 * `config` stays in CONTEXT_API because `ctx.config` is legitimate *when
 * declared in inject*; the halves here declare only services, so for them it is
 * reported — the check below subtracts the actual inject list, not this list.
 */
function contextReads(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const reads = new Set()
  for (const match of stripped.matchAll(/\b(?:ctx|scope|this\.ctx)\.([A-Za-z_$][\w$]*)/g)) {
    reads.add(match[1])
  }
  return reads
}

/** The names a module declares in `export const inject = [...]`. */
function declaredInject(source) {
  const match = source.match(/export const inject = \[([^\]]*)\]/)
  if (match === null) return new Set()
  return new Set(match[1].split(',').map((entry) => entry.trim().replace(/['"]/g, '')).filter((entry) => entry !== ''))
}

const HALVES = [
  { file: 'lib/index.js', half: 'Host' },
  { file: 'lib/client.js', half: 'Client' }
]

test('each half only touches context properties it injected', async () => {
  for (const { file, half } of HALVES) {
    const source = await readFile(join(root, file), 'utf8')
    const injected = declaredInject(source)
    const offenders = [...contextReads(source)]
      .filter((name) => !injected.has(name) && !CONTEXT_API.has(name))
    assert.deepEqual(offenders, [],
      `${half} half (${file}) reads ${offenders.join(', ')} without declaring it in inject`)
  }
})

test('both halves take their config from the loader argument', async () => {
  for (const { file, half } of HALVES) {
    const source = await readFile(join(root, file), 'utf8')
    assert.match(source, /const apply = \(ctx, (config|rawConfig)\)/,
      `${half} half (${file}) must accept the config the loader passes as the second argument`)
    assert.doesNotMatch(source, /ctx\.config\b/,
      `${half} half (${file}) must not read ctx.config: it throws unless "config" is injected`)
  }
})
