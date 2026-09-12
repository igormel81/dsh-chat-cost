/**
 * The five model-facing budget tools, driven end to end against a temporary
 * project folder: price lookup, estimation, plan persistence, unit marks, and
 * actual spend attributed back to the plan.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { appendCostLog, costRecord } from '../lib/log.js'
import { buildTools } from '../lib/tools.js'

const catalog = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'prices.json'), 'utf8'))

const settings = { logDirectory: '.dsh-cost' }
const exec = { agent: { sessionId: 'root-1' } }

async function harness() {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-tools-'))
  const tools = buildTools({ catalog, settings, resolveProject: () => ({ dir: project, sessionId: 'root-1', rootSessionId: 'root-1' }) })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const call = (name, args) => byName.get(name).execute(args, exec)
  return { project, tools, call }
}

test('every tool declares a model-facing schema and an output contract', async () => {
  const { tools } = await harness()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['cost_estimate', 'cost_history', 'cost_mark', 'cost_plan', 'cost_price'])
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} explains itself`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(tool.output.schema, `${tool.name} declares an output schema`)
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('cost_price finds official and catalog prices', async () => {
  const { call } = await harness()
  const deepseek = await call('cost_price', { provider: 'deepseek-official' })
  assert.equal(deepseek.ok, true)
  assert.ok(deepseek.matches.length >= 2)
  assert.equal(deepseek.matches.every((match) => match.source === 'official'), true)

  const kimi = await call('cost_price', { model: 'kimi-k3' })
  assert.equal(kimi.matches[0].model, 'kimi-k3')
  assert.equal(kimi.matches[0].cacheRead, 0.3)

  const nothing = await call('cost_price', { model: 'not-a-model' })
  assert.equal(nothing.count, 0)
})

test('cost_estimate prices declared tokens exactly and says where the number came from', async () => {
  const { call } = await harness()
  const result = await call('cost_estimate', {
    budgetUsd: 5,
    units: [{
      label: 'research',
      tokens: { input: 1000000, output: 0 },
      routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }]
    }]
  })
  assert.equal(result.ok, true)
  assert.equal(result.planned[0].basis, 'declared')
  assert.equal(result.planned[0].p50Usd, 0.15, 'off-peak DeepSeek flash input price')
  assert.equal(result.reserveUsd, 1)
  assert.equal(result.totals.fits, true)

  const guessed = await call('cost_estimate', { units: [{ label: 'unknown-work', scenario: 'lean' }] })
  assert.equal(guessed.planned[0].basis, 'bootstrap', 'a guess is labelled a guess')
})

test('a plan is written to the project and honoured by later estimation', async () => {
  const { project, call } = await harness()
  const written = await call('cost_plan', {
    action: 'write',
    goal: 'ship the beta',
    budgetUsd: 10,
    units: [
      { label: 'research', priority: 2, scenario: 'lean', routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] },
      { label: 'synthesis', priority: 1, scenario: 'normal', routes: [{ provider: 'moonshot', model: 'kimi-k3' }] }
    ]
  })
  assert.equal(written.ok, true)
  assert.equal(written.plan.units.length, 2)
  assert.equal(written.plan.units[0].label, 'research', 'priority order is preserved')

  const json = JSON.parse(await readFile(join(project, '.dsh-cost', 'plan.json'), 'utf8'))
  assert.equal(json.goal, 'ship the beta')
  assert.equal(json.budgetUsd, 10)
  const markdown = await readFile(join(project, '.dsh-cost', 'plan.md'), 'utf8')
  assert.match(markdown, /# Cost plan: ship the beta/)
  assert.match(markdown, /\| Unit \| Route \| Expected \| Worst case \| Actual \| Status \|/)
  assert.match(markdown, /bootstrap/)
})

test('the budget can be set, shown and cleared', async () => {
  const { project, call } = await harness()
  const set = await call('cost_plan', { action: 'budget', budgetUsd: 7.5 })
  assert.equal(set.budgetUsd, 7.5)
  const shown = await call('cost_plan', { action: 'budget' })
  assert.equal(shown.budgetUsd, 7.5)
  const cleared = await call('cost_plan', { action: 'budget', clear: true })
  assert.equal(cleared.cleared, true)
  assert.equal((await call('cost_plan', { action: 'budget' })).budgetUsd, null)
  assert.equal(JSON.parse(await readFile(join(project, '.dsh-cost', 'budget.json'), 'utf8')).kind, 'dsh-chat-cost-budget')
})

test('marks attribute later spend to the plan unit', async () => {
  const { project, call } = await harness()
  await call('cost_mark', { label: 'research', title: 'Market research' })
  await appendCostLog(project, [costRecord({ sessionId: 'root-1', model: 'deepseek-flash', deltaUsd: 0.04, cumulativeUsd: 0.04, usage: { uncachedInputTokens: 1000 } })], settings)
  await call('cost_mark', { label: 'synthesis', title: 'Write-up' })
  await appendCostLog(project, [
    costRecord({ sessionId: 'root-1', model: 'kimi-k3', deltaUsd: 0.5, cumulativeUsd: 0.54, usage: { outputTokens: 2000 } }),
    costRecord({ sessionId: 'root-1', model: 'kimi-k3', deltaUsd: 0.1, cumulativeUsd: 0.64, usage: { outputTokens: 400 } })
  ], settings)

  const history = await call('cost_history', {})
  assert.equal(history.ok, true)
  assert.equal(history.marks, 2)
  const research = history.byLabel.find((entry) => entry.label === 'research')
  const synthesis = history.byLabel.find((entry) => entry.label === 'synthesis')
  assert.equal(research.usd, 0.04, 'spend before the second mark belongs to the first unit')
  assert.ok(Math.abs(synthesis.usd - 0.6) < 1e-9, 'both later records belong to the second unit')
  assert.equal(synthesis.tokens.output, 2400)
  assert.deepEqual(history.byModel[0].model, 'kimi-k3', 'models are ranked by spend')
})

test('history is usable as the calibration source for the next estimate', async () => {
  const { project, call } = await harness()
  await call('cost_mark', { label: 'research' })
  await appendCostLog(project, [costRecord({
    sessionId: 'root-1', model: 'deepseek-flash', deltaUsd: 0.02, cumulativeUsd: 0.02,
    usage: { uncachedInputTokens: 700000, cacheReadTokens: 300000, outputTokens: 20000 }
  })], settings)

  const estimate = await call('cost_estimate', {
    units: [{ label: 'research', routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }]
  })
  assert.equal(estimate.planned[0].basis, 'history', 'a measured unit is no longer a guess')
})

test('a project without a log degrades without inventing numbers', async () => {
  const { call } = await harness()
  const history = await call('cost_history', {})
  assert.equal(history.ok, true)
  assert.equal(history.costRecords, 0)
  assert.deepEqual(history.byLabel, [])
  const read = await call('cost_plan', { action: 'read' })
  assert.deepEqual(read, { ok: false, reason: 'no-plan', project: read.project })
})

test('without a project directory the tools refuse instead of writing somewhere else', async () => {
  const tools = buildTools({ catalog, settings, resolveProject: () => ({ dir: null, sessionId: null, rootSessionId: null }) })
  const history = tools.find((tool) => tool.name === 'cost_history')
  assert.deepEqual(await history.execute({}, exec), { ok: false, reason: 'no-project-directory' })
  const mark = tools.find((tool) => tool.name === 'cost_mark')
  assert.deepEqual(await mark.execute({ label: 'x' }, exec), { ok: false, reason: 'no-project-directory' })
})
