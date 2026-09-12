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

/** The strings the generated plan document is written in. */
const PLAN_STRINGS = {
  en: {
    title: 'Cost plan',
    budget: 'Budget',
    reserve: 'reserve',
    spendable: 'spendable',
    notSet: 'not set',
    planned: (p50, p90, deferred) => `- Planned: $${p50} expected, $${p90} worst case${deferred > 0 ? `, ${deferred} unit(s) deferred` : ''}`,
    burn: (rate, samples, hours) => `- Burn: $${rate}/hour over ${samples} samples${hours ? `, limit in ${hours} h` : ''}`,
    columns: ['Unit', 'Route', 'Expected', 'Worst case', 'Actual', 'Status'],
    deferredTitle: 'Deferred (would not fit the budget)',
    deferredLine: (title, p90, cheapest) => `- ${title} — worst case $${p90}, cheapest route $${cheapest}`,
    scenariosTitle: 'Scenarios',
    scenarioColumns: ['Scenario', 'Expected', 'Worst case', 'Fits budget', 'Providers'],
    fitsYes: 'yes',
    fitsOver: (over) => `over by $${over}`,
    savings: (usd) => `Cheapest adequate routing would save $${usd} on this plan.`,
    opportunity: (label, from, to, usd) => `- ${label}: ${from} → ${to}, saves $${usd}`,
    bootstrap: '_Estimates named `bootstrap` come from default token profiles until history exists; they are guesses, not measurements._',
    adequacy: '_Adequacy uses capability facts from the catalog; it is a cost comparison, not a quality measurement._'
  },
  zh: {
    title: '费用计划',
    budget: '预算',
    reserve: '预留',
    spendable: '可用',
    notSet: '未设置',
    planned: (p50, p90, deferred) => `- 计划：预期 $${p50}，最坏 $${p90}${deferred > 0 ? `，${deferred} 个单元被推迟` : ''}`,
    burn: (rate, samples, hours) => `- 消耗速度：每小时 $${rate}（${samples} 个样本）${hours ? `，约 ${hours} 小时后达到上限` : ''}`,
    columns: ['单元', '路由', '预期', '最坏', '实际', '状态'],
    deferredTitle: '已推迟（预算内放不下）',
    deferredLine: (title, p90, cheapest) => `- ${title} —— 最坏 $${p90}，最便宜路由 $${cheapest}`,
    scenariosTitle: '方案',
    scenarioColumns: ['方案', '预期', '最坏', '符合预算', '供应商'],
    fitsYes: '是',
    fitsOver: (over) => `超出 $${over}`,
    savings: (usd) => `改用足够便宜的路由，本计划可省 $${usd}。`,
    opportunity: (label, from, to, usd) => `- ${label}：${from} → ${to}，省 $${usd}`,
    bootstrap: '_标记为 `bootstrap` 的估算来自默认 token 配置，在有历史数据前它们只是猜测，不是测量值。_',
    adequacy: '_合格性依据目录中的能力事实，这是成本比较，不是质量评分。_'
  },
  ru: {
    title: 'План расходов',
    budget: 'Бюджет',
    reserve: 'резерв',
    spendable: 'доступно',
    notSet: 'не задан',
    planned: (p50, p90, deferred) => `- План: ожидается $${p50}, худший случай $${p90}${deferred > 0 ? `, отложено пунктов: ${deferred}` : ''}`,
    burn: (rate, samples, hours) => `- Темп расхода: $${rate}/час по ${samples} замерам${hours ? `, лимит примерно через ${hours} ч` : ''}`,
    columns: ['Пункт', 'Маршрут', 'Ожидание', 'Худший случай', 'Факт', 'Статус'],
    deferredTitle: 'Отложено (не влезло в бюджет)',
    deferredLine: (title, p90, cheapest) => `- ${title} — худший случай $${p90}, дешёвый маршрут $${cheapest}`,
    scenariosTitle: 'Сценарии',
    scenarioColumns: ['Сценарий', 'Ожидание', 'Худший случай', 'В бюджет', 'Провайдеры'],
    fitsYes: 'да',
    fitsOver: (over) => `перерасход на $${over}`,
    savings: (usd) => `Переход на достаточно дешёвые маршруты сэкономит на этом плане $${usd}.`,
    opportunity: (label, from, to, usd) => `- ${label}: ${from} → ${to}, экономия $${usd}`,
    bootstrap: '_Оценки с пометкой `bootstrap` берутся из типовых профилей токенов, пока нет истории: это догадка, а не измерение._',
    adequacy: '_Пригодность определяется фактами каталога о возможностях; это сравнение стоимости, а не оценка качества._'
  }
}

/** Human-readable plan: budget, per-unit estimate and actual, and what is left. */
export function renderPlanMarkdown(plan, context = {}) {
  const s = PLAN_STRINGS[context.language] ?? PLAN_STRINGS.en
  const units = Array.isArray(plan?.units) ? plan.units : []
  const actuals = new Map((context.actuals ?? []).map((entry) => [entry.label, entry]))
  const lines = []
  lines.push(`# ${s.title}${plan?.goal ? `: ${plan.goal}` : ''}`)
  lines.push('')
  if (plan?.budgetUsd !== null && plan?.budgetUsd !== undefined) {
    const extra = plan.reserveUsd ? ` (${s.reserve} $${usd(plan.reserveUsd)}, ${s.spendable} $${usd(plan.spendableUsd)})` : ''
    lines.push(`- ${s.budget}: $${usd(plan.budgetUsd)}${extra}`)
  } else {
    lines.push(`- ${s.budget}: ${s.notSet}`)
  }
  if (plan?.totals) lines.push(s.planned(usd(plan.totals.p50Usd), usd(plan.totals.p90Usd), plan.totals.deferredCount ?? 0))
  if (context.burn?.usdPerHour !== undefined && context.burn?.usdPerHour !== null) {
    lines.push(s.burn(usd(context.burn.usdPerHour), context.burn.samples, context.burn.hoursToLimit ? context.burn.hoursToLimit.toFixed(1) : null))
  }
  lines.push('')
  lines.push(`| ${s.columns.join(' | ')} |`)
  lines.push(`| ${s.columns.map(() => '---').join(' | ')} |`)
  for (const unit of units) {
    const actual = actuals.get(unit.label)
    const route = unit.route ? unit.route.model : '—'
    lines.push(`| ${unit.title ?? unit.label} | ${route} | $${usd(unit.p50Usd)} | $${usd(unit.p90Usd)} | ${actual ? `$${usd(actual.usd)}` : '—'} | ${unit.status ?? 'planned'} |`)
  }

  const scenarios = Array.isArray(plan?.scenarios) ? plan.scenarios : []
  if (scenarios.length > 0) {
    lines.push('')
    lines.push(`## ${s.scenariosTitle}`)
    lines.push('')
    lines.push(`| ${s.scenarioColumns.join(' | ')} |`)
    lines.push(`| ${s.scenarioColumns.map(() => '---').join(' | ')} |`)
    for (const scenario of scenarios) {
      const fits = scenario.totals?.fitsBudget === null || scenario.totals?.fitsBudget === undefined
        ? '—'
        : (scenario.totals.fitsBudget ? s.fitsYes : s.fitsOver(usd(scenario.totals.overBudgetBy)))
      lines.push(`| ${scenario.name} | $${usd(scenario.totals?.p50Usd)} | $${usd(scenario.totals?.p90Usd)} | ${fits} | ${(scenario.providers ?? []).join(', ') || '—'} |`)
    }
    const recommendation = plan?.recommendation
    if (recommendation !== undefined && recommendation !== null) {
      lines.push('')
      if (typeof recommendation.savingsUsd === 'number' && recommendation.savingsUsd > 0) lines.push(s.savings(usd(recommendation.savingsUsd)))
      for (const opportunity of recommendation.opportunities ?? []) {
        lines.push(s.opportunity(opportunity.label, opportunity.from?.model ?? '—', opportunity.to?.model ?? '—', usd(opportunity.usd)))
      }
    }
    lines.push('')
    lines.push(s.adequacy)
  }

  if (Array.isArray(plan?.deferred) && plan.deferred.length > 0) {
    lines.push('')
    lines.push(`## ${s.deferredTitle}`)
    lines.push('')
    for (const unit of plan.deferred) lines.push(s.deferredLine(unit.title ?? unit.label, usd(unit.p90Usd), usd(unit.cheapestP90Usd)))
  }
  lines.push('')
  lines.push(s.bootstrap)
  lines.push('')
  return lines.join('\n')
}
