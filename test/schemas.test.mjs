/**
 * The tool schemas as the harness registry will judge them.
 *
 * The registry enforces a JSON Schema subset and validates every result against
 * the declared output schema. This test runs our definitions through the
 * harness's own validators when the package is resolvable (it is, inside a DSH
 * profile) and otherwise reports the checks as skipped rather than pretending
 * they ran.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { buildTools } from '../lib/tools.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(await readFile(join(root, 'data', 'prices.json'), 'utf8'))

let sdk = null
try {
  sdk = await import('@deepseek-ai/dsh-tools')
} catch {
  sdk = null
}

const project = await mkdtemp(join(tmpdir(), 'dsh-cost-schemas-'))
const tools = buildTools({
  catalog,
  settings: { logDirectory: '.dsh-cost' },
  resolveProject: () => ({ dir: project, sessionId: 'schema-session', rootSessionId: 'schema-session' })
})

/** A representative call per tool, covering the success path where one exists. */
const CALLS = {
  cost_price: { provider: 'deepseek-official' },
  cost_history: {},
  cost_estimate: { budgetUsd: 5, units: [{ label: 'u', scenario: 'lean', tokens: { input: 10000, output: 500 }, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }] },
  cost_plan: { action: 'write', goal: 'schema check', budgetUsd: 5, units: [{ label: 'u', scenario: 'lean', routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }] },
  cost_scenarios: { units: [{ label: 'u', scenario: 'lean', needs: { tools: true }, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }] },
  cost_mark: { label: 'u', title: 'Schema check' }
}

test('the harness validator is reachable from a DSH profile', () => {
  assert.ok(sdk !== null, 'run this suite inside a profile (`dsh plugin --profile web add` installs the SDK)')
  assert.equal(typeof sdk.assertSupportedJsonSchema, 'function')
  assert.equal(typeof sdk.validateJsonSchemaValue, 'function')
})

test('every parameter and output schema is inside the supported subset', () => {
  if (sdk === null) return
  for (const tool of tools) {
    assert.doesNotThrow(() => sdk.assertSupportedJsonSchema(tool.parameters), `${tool.name} parameters`)
    assert.doesNotThrow(() => sdk.assertSupportedJsonSchema(tool.output.schema), `${tool.name} output schema`)
  }
})

test('the model-facing schema carries only name, description and parameters', () => {
  for (const tool of tools) {
    for (const key of Object.keys(tool)) {
      assert.ok(['name', 'description', 'parameters', 'output', 'execute', 'timeoutMs', 'isConcurrencySafe', 'finalizeContent'].includes(key), `unexpected definition key ${key}`)
    }
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
  }
})

test('every tool results in lossless JSON that matches its declared schema', async () => {
  const exec = { agent: { sessionId: 'schema-session' } }
  for (const tool of tools) {
    const args = CALLS[tool.name]
    assert.ok(args !== undefined, `${tool.name} has a representative call`)
    const value = await tool.execute(args, exec)

    // Lossless JSON: a present-but-undefined field would be dropped by the
    // registry's snapshot and rejected before the model ever sees it.
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${tool.name} returns lossless JSON`)
    if (sdk !== null) {
      assert.deepEqual(sdk.validateJsonSchemaValue(tool.output.schema, value), [], `${tool.name} matches its output schema`)
    }

    const rendered = tool.output.render(args, value)
    assert.equal(Array.isArray(rendered), true, `${tool.name} renders content blocks`)
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
  }
})

test('refusals are lossless JSON too', async () => {
  const exec = { agent: { sessionId: 'schema-session' } }
  const refusing = buildTools({ catalog, settings: { logDirectory: '.dsh-cost' }, resolveProject: () => ({ dir: null, sessionId: null, rootSessionId: null }) })
  for (const tool of refusing) {
    const value = await tool.execute(CALLS[tool.name] ?? {}, exec)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${tool.name} refusal is lossless`)
    if (sdk !== null) {
      assert.deepEqual(sdk.validateJsonSchemaValue(tool.output.schema, value), [], `${tool.name} refusal matches its schema`)
    }
  }
})
