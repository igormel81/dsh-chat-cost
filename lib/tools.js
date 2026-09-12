/**
 * Model-facing budget tools.
 *
 * Raw tool definitions (no dependency on the tools SDK): a plain
 * `{ name, description, parameters, output, execute }` object registered on
 * `ctx.tools`. The model plans; this module prices, packs, records and reports.
 *
 * Every tool resolves the *calling* session from `exec.agent.sessionId`, so a
 * subagent's marks and plans land in the project folder of the chat it belongs
 * to, not in the plugin's own working directory.
 */
import { join } from 'node:path'
import { burnRate, packPlan } from './budget.js'
import { LOG_DIR, actualsByLabel, appendMarks, markRecord, readLedger as readProjectLedger, spendSamples } from './log.js'
import { PLAN_MARKDOWN, planPaths, readBudget, readPlan, writeBudget, writePlan } from './plan.js'
import { providerKey, resolvePrice } from './prices.js'

const json = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }]

const textOutput = (schema) => ({ schema, render: (_args, value) => json(value) })

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * Build the tool set.
 * @param {{ catalog: object, settings: { logDirectory: string }, resolveProject: (exec) => ({ dir: string|null, sessionId: string|null }) }} deps
 */
export function buildTools(deps) {
  const { catalog, settings, resolveProject } = deps

  async function ledgerFor(exec) {
    const project = resolveProject(exec)
    if (project.dir === null) return { project, ledger: null }
    return { project, ledger: await readProjectLedger(project.dir, { dir: settings.logDirectory }) }
  }

  const price = {
    name: 'cost_price',
    description: 'Look up token prices (USD per 1M tokens) for a provider and/or model from the bundled catalog, including cache read and cache write rates and the DeepSeek peak multiplier. Use it to choose a route deliberately instead of guessing what a model costs.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', description: 'Provider route, e.g. deepseek-official, moonshot, openai, anthropic, google, xai, mistral. Omit to search every provider.' },
        model: { type: 'string', description: 'Model id or a fragment of it, e.g. kimi-k3, gpt-5, claude-opus, deepseek-flash. Omit to list the provider.' }
      }
    },
    output: textOutput({ type: 'object' }),
    async execute(args) {
      const provider = typeof args?.provider === 'string' ? args.provider : null
      const model = typeof args?.model === 'string' ? args.model.toLowerCase() : null
      const matches = []
      // A harness route (deepseek-official, moonshot, gemini) names a catalog
      // provider key; accept both spellings.
      const wanted = provider === null ? null : (providerKey(provider) ?? provider.toLowerCase())
      const providers = wanted === null
        ? Object.keys(catalog?.providers ?? {})
        : Object.keys(catalog?.providers ?? {}).filter((key) => key === wanted || key.startsWith(wanted))
      for (const key of providers) {
        for (const id of Object.keys(catalog.providers[key]?.models ?? {})) {
          if (model !== null && id.toLowerCase().includes(model) === false) continue
          const resolved = resolvePrice(catalog, key, id)
          if (resolved === null) continue
          matches.push({
            provider: key,
            model: id,
            name: catalog.providers[key].models[id]?.name ?? id,
            source: resolved.source,
            input: resolved.cost.input,
            cacheRead: resolved.cost.cacheRead,
            cacheWrite: resolved.cost.cacheWrite,
            output: resolved.cost.output,
            peakMultiplier: resolved.cost.peakMultiplier
          })
          if (matches.length >= 60) break
        }
        if (matches.length >= 60) break
      }
      return { ok: true, count: matches.length, truncated: matches.length >= 60, matches }
    }
  }

  const history = {
    name: 'cost_history',
    description: 'Read the actual spend recorded in this project\'s cost log: totals per marked plan unit and per model, with P50/P90 spread. Use it to calibrate estimates before promising a budget.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Only report this plan unit label.' },
        limit: { type: 'number', description: 'Maximum number of cost records to consider, newest first. Default: all.' }
      }
    },
    output: textOutput({ type: 'object' }),
    async execute(args, exec) {
      const { project, ledger } = await ledgerFor(exec)
      if (ledger === null) return { ok: false, reason: 'no-project-directory' }
      const costs = typeof args?.limit === 'number' && args.limit > 0 ? ledger.costs.slice(-args.limit) : ledger.costs
      const byLabel = actualsByLabel(ledger.entries)
        .filter((entry) => typeof args?.label !== 'string' || entry.label === args.label)
      const byModel = new Map()
      for (const record of costs) {
        const key = record.model ?? '(unknown)'
        if (byModel.has(key) === false) byModel.set(key, { model: key, provider: record.provider ?? null, usd: 0, records: 0, tokens: 0 })
        const entry = byModel.get(key)
        entry.usd += typeof record.deltaUsd === 'number' ? record.deltaUsd : 0
        entry.records += 1
        entry.tokens += typeof record.totalTokens === 'number' ? record.totalTokens : 0
      }
      return {
        ok: true,
        project: project.dir,
        log: ledger.path,
        costRecords: costs.length,
        marks: ledger.marks.length,
        brokenLines: ledger.broken.length,
        byLabel,
        byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd)
      }
    }
  }

  const estimate = {
    name: 'cost_estimate',
    description: 'Estimate what a list of work units would cost, and check whether they fit a budget. Units declare a scenario (lean | normal | deep), optional explicit token counts, and candidate routes; the result gives P50 and P90 per unit, the cheapest sufficient route, the 20% reserve, and which units would not fit. Estimates say whether they came from declared tokens, history, or a bootstrap default.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        units: {
          type: 'array',
          description: 'Work units to price.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              label: { type: 'string', description: 'Stable identifier used by cost_mark and cost_history.' },
              title: { type: 'string' },
              priority: { type: 'number', description: 'Higher packs first. Default 0.' },
              scenario: { type: 'string', enum: ['lean', 'normal', 'deep'] },
              tokens: {
                type: 'object',
                additionalProperties: true,
                properties: { input: { type: 'number' }, output: { type: 'number' } }
              },
              routes: {
                type: 'array',
                description: 'Candidate routes in preference order; the cheapest one that fits is chosen.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    provider: { type: 'string' },
                    model: { type: 'string' },
                    tokenFactor: { type: 'number', description: 'Relative token cost of this route, e.g. 0.7 when a stronger model needs fewer passes.' }
                  }
                }
              }
            }
          }
        },
        budgetUsd: { type: 'number', description: 'Money limit to pack against. Omit to price without packing.' },
        bufferRatio: { type: 'number', description: 'Share of the budget held back for rework. Default 0.2.' }
      },
      required: ['units']
    },
    output: textOutput({ type: 'object' }),
    async execute(args, exec) {
      const { ledger } = await ledgerFor(exec)
      const units = Array.isArray(args?.units) ? args.units : []
      const historySamples = ledger === null ? [] : actualsByLabel(ledger.entries)
        .map((entry) => ({ label: entry.label, tokens: entry.tokens }))
      const plan = packPlan({
        units,
        budgetUsd: numberOrNull(args?.budgetUsd),
        bufferRatio: numberOrNull(args?.bufferRatio) ?? undefined,
        history: historySamples,
        catalog
      })
      return { ok: true, units: units.length, ...plan }
    }
  }

  const plan = {
    name: 'cost_plan',
    description: 'Work with the project cost plan stored in <project>/.dsh-cost/: write or refresh it (priced and packed against the budget), read it back with actual spend merged, or set/clear/show the money budget. The plan file is meant to be edited by a human too.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['write', 'read', 'budget'] },
        goal: { type: 'string', description: 'What the project is trying to achieve (write).' },
        units: { type: 'array', description: 'Plan units (write), same shape as cost_estimate.', items: { type: 'object', additionalProperties: true } },
        budgetUsd: { type: 'number', description: 'Budget to set (budget) or to pack against (write).' },
        clear: { type: 'boolean', description: 'With action=budget, remove the limit.' },
        note: { type: 'string' }
      },
      required: ['action']
    },
    output: textOutput({ type: 'object' }),
    async execute(args, exec) {
      const { project, ledger } = await ledgerFor(exec)
      if (project.dir === null) return { ok: false, reason: 'no-project-directory' }
      const action = args?.action
      const options = { dir: settings.logDirectory }
      const actuals = ledger === null ? [] : actualsByLabel(ledger.entries)
      const stored = await readBudget(project.dir, options)
      const burn = ledger === null ? null : burnRate(spendSamples(ledger.costs), {
        budgetUsd: stored?.usd ?? null,
        spentUsd: ledger.costs.reduce((sum, record) => sum + (typeof record.deltaUsd === 'number' ? record.deltaUsd : 0), 0)
      })

      if (action === 'budget') {
        if (args?.clear === true) {
          await writeBudget(project.dir, { usd: null, note: args?.note ?? null, clearedAt: new Date().toISOString() }, options)
          return { ok: true, action: 'budget', cleared: true, project: project.dir }
        }
        if (numberOrNull(args?.budgetUsd) === null) {
          return { ok: true, action: 'budget', budgetUsd: stored?.usd ?? null, spentUsd: burn?.spentUsd ?? 0, remainingUsd: burn?.remainingUsd ?? null, projection: burn?.projection ?? 'no-budget' }
        }
        const path = await writeBudget(project.dir, { usd: args.budgetUsd, note: args?.note ?? null, setAt: new Date().toISOString() }, options)
        return { ok: true, action: 'budget', budgetUsd: args.budgetUsd, file: path }
      }

      if (action === 'read') {
        const existing = await readPlan(project.dir, options)
        if (existing === null) return { ok: false, reason: 'no-plan', project: project.dir }
        return { ok: true, action: 'read', project: project.dir, plan: existing, actuals, burn, markdown: join(planPaths(project.dir, options).dir, PLAN_MARKDOWN) }
      }

      const units = Array.isArray(args?.units) ? args.units : []
      if (units.length === 0) return { ok: false, reason: 'no-units' }
      const budgetUsd = numberOrNull(args?.budgetUsd) ?? numberOrNull(stored?.usd)
      const historySamples = actuals.map((entry) => ({ label: entry.label, tokens: entry.tokens }))
      const packed = packPlan({ units, budgetUsd, history: historySamples, catalog })
      const document = {
        goal: typeof args?.goal === 'string' ? args.goal : null,
        budgetUsd: packed.budgetUsd,
        reserveUsd: packed.reserveUsd,
        spendableUsd: packed.spendableUsd,
        units: packed.planned.map((unit) => ({ ...unit, status: 'planned' })),
        deferred: packed.deferred,
        totals: packed.totals,
        assumptions: { bufferRatio: 0.2, cacheReadShare: 0.3, uncertainty: 2 }
      }
      const files = await writePlan(project.dir, document, { dir: settings.logDirectory, context: { actuals, burn } })
      return { ok: true, action: 'write', project: project.dir, files, plan: document, burn }
    }
  }

  const mark = {
    name: 'cost_mark',
    description: 'Open a plan unit: spend from now on belongs to this label until the next mark. Call it when you start a unit from the plan, so actual cost can be attributed to the plan instead of guessed from timestamps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Plan unit label, matching the label used in cost_plan.' },
        title: { type: 'string', description: 'Human-readable title.' },
        note: { type: 'string', description: 'Optional context for the ledger.' }
      },
      required: ['label']
    },
    output: textOutput({ type: 'object' }),
    async execute(args, exec) {
      const { project, ledger } = await ledgerFor(exec)
      if (project.dir === null) return { ok: false, reason: 'no-project-directory' }
      const options = { dir: settings.logDirectory }
      await appendMarks(project.dir, [markRecord({
        sessionId: project.sessionId,
        rootSessionId: project.rootSessionId ?? project.sessionId,
        label: args.label,
        title: args?.title ?? null,
        note: args?.note ?? null
      })], options)
      const before = ledger === null ? [] : actualsByLabel(ledger.entries)
      return {
        ok: true,
        label: args.label,
        project: project.dir,
        previousUnits: before.map((entry) => ({ label: entry.label, usd: entry.usd })),
        plan: (await readPlan(project.dir, options)) !== null
      }
    }
  }

  return [price, history, estimate, plan, mark]
}

export { LOG_DIR }
