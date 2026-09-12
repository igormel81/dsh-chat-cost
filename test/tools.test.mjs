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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['cost_estimate', 'cost_history', 'cost_mark', 'cost_plan', 'cost_price', 'cost_scenarios'])
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

test('scenarios compare routings and name the models worth connecting', async () => {
  const { project, call } = await harness()
  await call('cost_plan', {
    action: 'write',
    goal: 'beta',
    budgetUsd: 25,
    units: [
      { label: 'collect', priority: 1, scenario: 'normal', routes: [{ provider: 'moonshot', model: 'kimi-k3' }] },
      { label: 'synthesis', priority: 3, critical: true, scenario: 'deep', routes: [{ provider: 'moonshot', model: 'kimi-k3' }] }
    ]
  })

  const result = await call('cost_scenarios', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.scenarios.map((scenario) => scenario.name), ['quality', 'connected', 'economy', 'balanced'])

  const quality = result.scenarios.find((scenario) => scenario.name === 'quality')
  const economy = result.scenarios.find((scenario) => scenario.name === 'economy')
  const balanced = result.scenarios.find((scenario) => scenario.name === 'balanced')
  assert.equal(quality.units.every((unit) => unit.route.model === 'kimi-k3'), true)
  assert.ok(economy.totals.p50Usd < quality.totals.p50Usd, 'the cheapest adequate routing is cheaper')
  assert.equal(balanced.units.find((unit) => unit.label === 'synthesis').route.model, 'kimi-k3', 'a critical unit keeps its preferred route')
  assert.ok(balanced.totals.p50Usd > economy.totals.p50Usd, 'and that costs more than pure economy')

  const recommendation = result.recommendation
  assert.ok(recommendation.savingsUsd > 0)
  assert.equal(recommendation.drivers[0].label, 'synthesis', 'the cost driver is ranked first')
  assert.ok(recommendation.drivers[0].share > 0.5)
  assert.ok(recommendation.opportunities.length >= 1)

  // The comparison is saved with the plan and rendered for a human reader.
  const json = JSON.parse(await readFile(join(project, '.dsh-cost', 'plan.json'), 'utf8'))
  assert.equal(json.scenarios.length, 4)
  assert.equal(typeof json.recommendation.savingsUsd, 'number')
  const markdown = await readFile(join(project, '.dsh-cost', 'plan.md'), 'utf8')
  assert.match(markdown, /## Scenarios/)
  assert.match(markdown, /\| Scenario \| Expected \| Worst case \| Fits budget \| Providers \|/)
  assert.match(markdown, /not a quality measurement/)
})

test('free-tier models are skipped unless they are asked for', async () => {
  const { call } = await harness()
  const units = [{ label: 'x', scenario: 'lean', needs: { tools: true }, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }]

  const without = await call('cost_scenarios', { units })
  const withFree = await call('cost_scenarios', { units, includeFree: true })

  assert.ok(without.units[0].freeSkipped >= 1, 'free-tier candidates exist in the catalog')
  assert.ok(without.units[0].cheapestAdequate.usd > 0, 'and are excluded from the paid floor')
  const note = without.scenarios.find((scenario) => scenario.name === 'economy').notes.find((entry) => entry.kind === 'free-models-skipped')
  assert.ok(note !== undefined, 'the exclusion is stated, not silent')
  assert.match(note.detail, /includeFree/)

  assert.equal(withFree.units[0].freeSkipped, 0)
  assert.ok(withFree.units[0].cheapestAdequate.usd <= without.units[0].cheapestAdequate.usd, 'pricing free tiers can only lower the floor')
})

test('a cheaper adequate model that is much narrower is flagged, not hidden', async () => {
  const { call } = await harness()
  const result = await call('cost_scenarios', {
    units: [{
      label: 'long-read',
      scenario: 'normal',
      needs: { tools: true, context: 100000 },
      routes: [{ provider: 'anthropic', model: 'claude-opus-5' }]
    }]
  })
  const cheapest = result.units[0].cheapestAdequate
  assert.ok(cheapest !== null)
  assert.ok(cheapest.usd < 1, 'the cheap option is genuinely cheaper than Opus')
  const flagged = result.units[0].alternatives.some((alternative) => alternative.narrower === true)
  assert.equal(flagged, true, 'a smaller context than the preferred route is visible in the comparison')
  const note = result.scenarios.find((scenario) => scenario.name === 'economy').notes.find((entry) => entry.kind === 'narrower-context')
  assert.ok(note !== undefined)
})

test('a unit with no requirements gets no catalog-wide recommendation, and says why', async () => {
  const { call } = await harness()
  const result = await call('cost_scenarios', {
    units: [{ label: 'mystery', routes: [{ provider: 'not-a-provider', model: 'not-a-model' }], scenario: 'lean' }]
  })
  assert.equal(result.units[0].knowsRequirements, false)
  assert.equal(result.units[0].candidates, 0)
  assert.equal(result.units[0].cheapestAdequate, null)
  const note = result.scenarios.find((scenario) => scenario.name === 'economy').notes.find((entry) => entry.kind === 'no-requirements')
  assert.ok(note !== undefined, 'the silence is explained rather than hidden')
})

test('an adequate route names a harness route, not only a catalog key', async () => {
  const { call } = await harness()
  const result = await call('cost_scenarios', {
    units: [{ label: 'code', scenario: 'lean', needs: { tools: true, context: 100000 }, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }]
  })
  const alternatives = result.units[0].alternatives
  assert.ok(alternatives.length > 0)
  for (const alternative of alternatives) {
    assert.equal(typeof alternative.route, 'string')
    assert.equal(alternative.route, alternative.route.toLowerCase())
  }
  const known = ['deepseek-official', 'moonshot', 'openai', 'anthropic', 'google', 'xai', 'mistral']
  assert.ok(known.includes(result.units[0].cheapestAdequate.route), `unexpected route ${result.units[0].cheapestAdequate.route}`)
})

test('scenarios refuse without units and say what to do', async () => {
  const { call } = await harness()
  const result = await call('cost_scenarios', {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-units')
  assert.match(result.hint, /cost_plan/)
})
