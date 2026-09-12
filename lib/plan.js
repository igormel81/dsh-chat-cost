/**
 * Plan and budget files, in the project folder next to the cost log:
 *
 *   <project>/.dsh-cost/plan.json    units, routes, estimates, statuses
 *   <project>/.dsh-cost/budget.json  the money limit for this project
 *   <project>/.dsh-cost/plan.md      the same plan for a human reader
 *
 * Files rather than hidden state: the plan is meant to be read, diffed and
 * committed by the person paying the bill.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LOG_DIR } from './log.js'

export const PLAN_FILE = 'plan.json'
export const BUDGET_FILE = 'budget.json'
export const PLAN_MARKDOWN = 'plan.md'

function directory(projectDir, options = {}) {
  const name = typeof options.dir === 'string' && options.dir !== '' ? options.dir : LOG_DIR
  return join(projectDir, name)
}

export function planPaths(projectDir, options = {}) {
  const dir = directory(projectDir, options)
  return { dir, plan: join(dir, PLAN_FILE), budget: join(dir, BUDGET_FILE), markdown: join(dir, PLAN_MARKDOWN) }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 1) + '\n', 'utf8')
  return file
}

export async function writePlan(projectDir, plan, options = {}) {
  const paths = planPaths(projectDir, options)
  const document = { ...plan, kind: 'dsh-chat-cost-plan', updatedAt: new Date().toISOString() }
  await writeJson(paths.plan, document)
  await writeFile(paths.markdown, renderPlanMarkdown(document, options.context ?? {}), 'utf8')
  return { plan: paths.plan, markdown: paths.markdown }
}

export async function readPlan(projectDir, options = {}) {
  return readJson(planPaths(projectDir, options).plan)
}

export async function writeBudget(projectDir, budget, options = {}) {
  const paths = planPaths(projectDir, options)
  const document = { ...budget, kind: 'dsh-chat-cost-budget', updatedAt: new Date().toISOString() }
  await writeJson(paths.budget, document)
  return paths.budget
}

export async function readBudget(projectDir, options = {}) {
  return readJson(planPaths(projectDir, options).budget)
}

function usd(value) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) return '—'
  if (value >= 100) return value.toFixed(2)
  if (value >= 1) return value.toFixed(3)
  if (value >= 0.01) return value.toFixed(4)
  return value.toFixed(5)
}

/** Human-readable plan: budget, per-unit estimate and actual, and what is left. */
export function renderPlanMarkdown(plan, context = {}) {
  const units = Array.isArray(plan?.units) ? plan.units : []
  const actuals = new Map((context.actuals ?? []).map((entry) => [entry.label, entry]))
  const lines = []
  lines.push(`# Cost plan${plan?.goal ? `: ${plan.goal}` : ''}`)
  lines.push('')
  if (plan?.budgetUsd !== null && plan?.budgetUsd !== undefined) {
    lines.push(`- Budget: $${usd(plan.budgetUsd)}${plan.reserveUsd ? ` (reserve $${usd(plan.reserveUsd)}, spendable $${usd(plan.spendableUsd)})` : ''}`)
  } else {
    lines.push('- Budget: not set')
  }
  if (plan?.totals) {
    lines.push(`- Planned: $${usd(plan.totals.p50Usd)} expected, $${usd(plan.totals.p90Usd)} worst case${plan.totals.deferredCount ? `, ${plan.totals.deferredCount} unit(s) deferred` : ''}`)
  }
  if (context.burn?.usdPerHour !== undefined && context.burn?.usdPerHour !== null) {
    lines.push(`- Burn: $${usd(context.burn.usdPerHour)}/hour over ${context.burn.samples} samples${context.burn.hoursToLimit ? `, limit in ${context.burn.hoursToLimit.toFixed(1)} h` : ''}`)
  }
  lines.push('')
  lines.push('| Unit | Route | Expected | Worst case | Actual | Status |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const unit of units) {
    const actual = actuals.get(unit.label)
    const route = unit.route ? `${unit.route.model}` : '—'
    lines.push(`| ${unit.title ?? unit.label} | ${route} | $${usd(unit.p50Usd)} | $${usd(unit.p90Usd)} | ${actual ? `$${usd(actual.usd)}` : '—'} | ${unit.status ?? 'planned'} |`)
  }
  const scenarios = Array.isArray(plan?.scenarios) ? plan.scenarios : []
  if (scenarios.length > 0) {
    lines.push('')
    lines.push('## Scenarios')
    lines.push('')
    lines.push('| Scenario | Expected | Worst case | Fits budget | Providers |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const scenario of scenarios) {
      const fits = scenario.totals?.fitsBudget === null || scenario.totals?.fitsBudget === undefined ? '—' : (scenario.totals.fitsBudget ? 'yes' : `over by $${usd(scenario.totals.overBudgetBy)}`)
      lines.push(`| ${scenario.name} | $${usd(scenario.totals?.p50Usd)} | $${usd(scenario.totals?.p90Usd)} | ${fits} | ${(scenario.providers ?? []).join(', ') || '—'} |`)
    }
    const recommendation = plan?.recommendation
    if (recommendation !== undefined && recommendation !== null) {
      lines.push('')
      if (typeof recommendation.savingsUsd === 'number' && recommendation.savingsUsd > 0) {
        lines.push(`Cheapest adequate routing would save $${usd(recommendation.savingsUsd)} on this plan.`)
      }
      for (const opportunity of recommendation.opportunities ?? []) {
        const from = opportunity.from?.model ?? '—'
        const to = opportunity.to?.model ?? '—'
        lines.push(`- ${opportunity.label}: ${from} → ${to}, saves $${usd(opportunity.usd)}`)
      }
    }
    lines.push('')
    lines.push('_Adequacy uses capability facts from the catalog; it is a cost comparison, not a quality measurement._')
  }

  if (Array.isArray(plan?.deferred) && plan.deferred.length > 0) {
    lines.push('')
    lines.push('## Deferred (would not fit the budget)')
    lines.push('')
    for (const unit of plan.deferred) lines.push(`- ${unit.title ?? unit.label} — worst case $${usd(unit.p90Usd)}, cheapest route $${usd(unit.cheapestP90Usd)}`)
  }
  lines.push('')
  lines.push('_Estimates named `bootstrap` come from default token profiles until history exists; they are guesses, not measurements._')
  lines.push('')
  return lines.join('\n')
}
