/**
 * Scenario planning: which models are worth connecting for this project.
 *
 * The plugin owns money and catalog facts; the caller owns judgement. Three
 * kinds of statement appear here, and they never blur:
 *
 *  - **facts** — prices, cache rates and capability flags from the bundled
 *    models.dev snapshot (`reasoning`, `tools`, `vision`, context limits);
 *  - **the caller's choices** — the routes a unit is willing to use, in
 *    preference order, plus optional `capability` labels for quality;
 *  - **labelled assumptions** — where a scenario has to guess (for example the
 *    capability floor used when a unit declares no requirements), it says so in
 *    `notes` instead of presenting a guess as a measurement.
 *
 * Scenarios differ only in routing; the work, the token profiles and the reserve
 * are the same, so the comparison is honest.
 */
import { estimateUnit } from './budget.js'
import { providerKey, routeForProvider } from './prices.js'

/**
 * Capability names a unit or a route may require. Open weights are reported but
 * never required on a unit's behalf: they say how a model is distributed, not
 * whether it can do the job.
 */
const FLAGS = ['reasoning', 'tools', 'structured', 'vision']
/** Flags copied from a preferred route when a unit declares no requirements. */
const IMPLIED_FLAGS = FLAGS

/** Price one route for one unit, reusing the single estimation path. */
function priceRoute(unit, route, history, catalog) {
  const estimate = estimateUnit({ ...unit, routes: [route] }, history, catalog)
  const priced = estimate.preferred
  return priced === null ? null : { route, priced, estimate }
}

/**
 * Capability facts of one catalog model, or null when it is not priced.
 * Accepts either a harness route (`deepseek-official`, `gemini`) or a catalog
 * provider key (`deepseek`, `google`).
 */
function capsOf(catalog, provider, model) {
  const key = providerKey(provider) ?? provider
  const entry = catalog?.providers?.[key]?.models?.[model]
  if (entry === undefined) return null
  return { cost: entry.cost ?? null, caps: entry.caps ?? {} }
}

/**
 * Does a model satisfy the requirements?
 * Requirements are facts the caller states: context size, capability flags,
 * output limit. An absent requirement is not checked.
 */
export function meetsRequirements(entry, needs = {}) {
  if (entry === null) return false
  const caps = entry.caps ?? {}
  for (const flag of FLAGS) {
    if (needs[flag] === true && caps[flag] !== true) return false
  }
  if (typeof needs.context === 'number' && (typeof caps.context !== 'number' || caps.context < needs.context)) return false
  if (typeof needs.output === 'number' && (typeof caps.output !== 'number' || caps.output < needs.output)) return false
  return true
}

/** Capability floor implied by the caller's preferred route, when no needs are declared. */
function impliedNeeds(unit, catalog) {
  const preferred = Array.isArray(unit?.routes) ? unit.routes[0] : undefined
  if (preferred === undefined || preferred === null || typeof preferred !== 'object') return { needs: {}, implied: false, resolved: false }
  const entry = capsOf(catalog, preferred.provider === undefined ? undefined : preferred.provider, preferred.model)
  if (entry === null) return { needs: {}, implied: false, resolved: false }
  const caps = entry.caps ?? {}
  const needs = {}
  for (const flag of FLAGS) if (caps[flag] === true) needs[flag] = true
  if (typeof caps.context === 'number') needs.context = caps.context
  const known = Object.keys(needs).length > 0
  return { needs, implied: known, resolved: true, from: { provider: preferred.provider ?? null, model: preferred.model ?? null } }
}

/**
 * Every priced model in the catalog that satisfies the requirements, cheapest
 * first for THIS unit's token profile.
 */
export function adequateRoutes(unit, needs, history, catalog, options = {}) {
  const limit = typeof options.limit === 'number' ? options.limit : 40
  const includeFree = options.includeFree === true
  const candidates = []
  let freeSkipped = 0
  for (const [provider, value] of Object.entries(catalog?.providers ?? {})) {
    for (const model of Object.keys(value.models ?? {})) {
      const entry = value.models[model]
      if (entry.cost === undefined || entry.cost === null) continue
      if (meetsRequirements(entry, needs) === false) continue
      // A free tier is usually experimental or rate-limited; proposing it as the
      // cheap scenario without being asked would be a recommendation the plugin
      // cannot stand behind.
      if (includeFree === false && entry.cost.input === 0 && entry.cost.output === 0) {
        freeSkipped += 1
        continue
      }
      const priced = priceRoute(unit, { provider, model }, history, catalog)
      if (priced === null || priced.priced.usd === null) continue
      const preferredCaps = options.preferredCaps ?? null
      candidates.push({
        provider,
        route: routeForProvider(provider),
        narrower: preferredCaps !== null && typeof preferredCaps.context === 'number' && typeof entry.caps?.context === 'number'
          ? entry.caps.context < preferredCaps.context
          : null,
        model,
        usd: priced.priced.usd,
        p90Usd: priced.estimate.p90Usd,
        usdPeak: priced.priced.usdPeak,
        caps: entry.caps ?? {},
        name: entry.name ?? model,
        released: entry.caps?.released ?? null,
        input: entry.cost.input ?? null,
        output: entry.cost.output ?? null
      })
    }
  }
  candidates.sort((a, b) => a.usd - b.usd)
  return { candidates: candidates.slice(0, limit), freeSkipped, total: candidates.length }
}

/** Total one routing decision set into a scenario row. */
function totalize(name, description, unitChoices, budgetUsd, notes) {
  const priced = unitChoices.filter((choice) => choice.route !== null && choice.p50Usd !== null)
  const p50 = priced.reduce((sum, choice) => sum + choice.p50Usd, 0)
  const p90 = priced.reduce((sum, choice) => sum + (choice.p90Usd ?? choice.p50Usd), 0)
  return {
    name,
    description,
    units: unitChoices,
    totals: {
      p50Usd: priced.length > 0 ? p50 : null,
      p90Usd: priced.length > 0 ? p90 : null,
      pricedUnits: priced.length,
      unpricedUnits: unitChoices.length - priced.length,
      budgetUsd: typeof budgetUsd === 'number' ? budgetUsd : null,
      fitsBudget: typeof budgetUsd === 'number' ? p90 <= budgetUsd * 0.8 : null,
      overBudgetBy: typeof budgetUsd === 'number' && p90 > budgetUsd * 0.8 ? p90 - budgetUsd * 0.8 : 0
    },
    providers: [...new Set(priced.map((choice) => choice.route.provider))].sort(),
    notes
  }
}

/**
 * Build the standard scenarios for a plan.
 *
 *  - `quality`   — the caller's preferred route for every unit;
 *  - `connected` — the cheapest route the caller already listed per unit;
 *  - `economy`   — the cheapest adequate model in the whole catalog per unit,
 *                  which may mean connecting a provider that is not in use yet;
 *  - `balanced`  — `quality` for units marked `critical`, `economy` for the rest.
 *
 * @param {{ units: object[], catalog: object, budgetUsd?: number|null, history?: object[], custom?: object[] }} input
 */
export function buildScenarios(input) {
  const { units, catalog, budgetUsd = null, history = [], custom = [], includeFree = false } = input
  const perUnit = []

  for (const unit of units) {
    const declared = (Array.isArray(unit.routes) ? unit.routes : []).map((route) => priceRoute(unit, route, history, catalog)).filter((entry) => entry !== null)
    const declaredPriced = declared.filter((entry) => entry.priced.usd !== null)
    const preferred = declaredPriced[0] ?? null
    const cheapestDeclared = declaredPriced.length > 0 ? declaredPriced.reduce((best, entry) => (entry.priced.usd < best.priced.usd ? entry : best)) : null
    const declaredNeeds = unit.needs !== undefined && unit.needs !== null && typeof unit.needs === 'object' ? unit.needs : null
    const derived = declaredNeeds === null ? impliedNeeds(unit, catalog) : { needs: declaredNeeds, implied: false, resolved: true, from: null }
    const needs = derived.needs ?? {}
    const knowsRequirements = Object.keys(needs).length > 0
    // A catalog-wide search is only meaningful against stated (or derivable)
    // requirements. Without them "cheapest adequate" would recommend a media
    // model for a reasoning task, which is worse than recommending nothing.
    const preferredEntry = preferred === null ? null : capsOf(catalog, preferred.route.provider, preferred.route.model)
    const searched = knowsRequirements
      ? adequateRoutes(unit, needs, history, catalog, { includeFree, preferredCaps: preferredEntry?.caps ?? null })
      : { candidates: [], freeSkipped: 0, total: 0 }
    const adequate = searched.candidates
    perUnit.push({
      unit, preferred, cheapestDeclared, adequate, needs, knowsRequirements,
      freeSkipped: searched.freeSkipped,
      implied: derived.implied, impliedFrom: derived.from ?? null
    })
  }

  const notesFor = (perUnitEntries) => perUnitEntries.flatMap((entry) => {
    const notes = []
    if (entry.implied === true) {
      notes.push({
        unit: entry.unit.label ?? null,
        kind: 'implied-requirements',
        detail: `requirements derived from the preferred route (${entry.impliedFrom?.model ?? '?'}) because the unit declared none`
      })
    }
    if (entry.knowsRequirements === false) {
      notes.push({
        unit: entry.unit.label ?? null,
        kind: 'no-requirements',
        detail: 'no requirements declared and none derivable, so no catalog-wide alternative is proposed'
      })
    }
    const narrow = entry.adequate.filter((candidate) => candidate.narrower === true).length
    if (narrow > 0) {
      notes.push({
        unit: entry.unit.label ?? null,
        kind: 'narrower-context',
        detail: `${narrow} adequate candidate(s) offer a smaller context than the preferred route; they are priced as options, not recommended blindly`
      })
    }
    if (entry.freeSkipped > 0) {
      notes.push({
        unit: entry.unit.label ?? null,
        kind: 'free-models-skipped',
        detail: `${entry.freeSkipped} free-tier model(s) met the requirements and were skipped: they are usually experimental or rate-limited. Pass includeFree to price them.`
      })
    }
    return notes
  })

  const choose = (resolver) => perUnit.map((entry) => {
    const route = resolver(entry)
    const p90 = route === null ? null : (route.estimate !== undefined ? route.estimate.p90Usd : route.p90Usd ?? null)
    return {
      label: entry.unit.label ?? null,
      title: entry.unit.title ?? null,
      critical: entry.unit.critical === true,
      route: route === null ? null : {
        provider: route.route.provider,
        model: route.route.model,
        ...(route.route.catalogProvider === undefined ? {} : { catalogProvider: route.route.catalogProvider })
      },
      p50Usd: route === null ? null : route.priced.usd,
      p90Usd: p90 === null && route !== null ? route.priced.usd * 2 : p90,
      peakUsd: route === null ? null : (route.priced.usdPeak ?? null),
      pricingSource: route === null ? 'none' : route.priced.source,
      basis: route === null ? null : entry.unit.tokens ? 'declared' : (entry.preferred === null ? 'bootstrap' : 'history-or-bootstrap')
    }
  })

  /** Wrap a catalog candidate in the same shape a declared route produces. */
  const asRoute = (candidate) => candidate === undefined || candidate === null
    ? null
    : {
        route: { provider: candidate.route ?? routeForProvider(candidate.provider), model: candidate.model, catalogProvider: candidate.provider },
        priced: { usd: candidate.usd, usdPeak: candidate.usdPeak ?? null, source: 'catalog' },
        p90Usd: candidate.p90Usd ?? candidate.usd * 2
      }

  const scenarios = []

  scenarios.push(totalize(
    'quality',
    'the preferred route for every unit',
    choose((entry) => entry.preferred),
    budgetUsd,
    notesFor(perUnit)
  ))

  scenarios.push(totalize(
    'connected',
    'the cheapest route already listed for each unit',
    choose((entry) => entry.cheapestDeclared),
    budgetUsd,
    []
  ))

  scenarios.push(totalize(
    'economy',
    'the cheapest adequate model in the catalog per unit (falls back to the cheapest listed route when no requirements are known)',
    choose((entry) => asRoute(entry.adequate[0]) ?? entry.cheapestDeclared),
    budgetUsd,
    notesFor(perUnit)
  ))

  scenarios.push(totalize(
    'balanced',
    'the preferred route for critical units, the cheapest adequate model for the rest',
    choose((entry) => (entry.unit.critical === true ? entry.preferred : (asRoute(entry.adequate[0]) ?? entry.cheapestDeclared ?? entry.preferred))),
    budgetUsd,
    notesFor(perUnit)
  ))

  for (const definition of custom) {
    if (definition === null || typeof definition !== 'object' || typeof definition.name !== 'string') continue
    const routes = definition.routes ?? {}
    scenarios.push(totalize(
      definition.name,
      typeof definition.description === 'string' ? definition.description : 'custom scenario',
      choose((entry) => {
        const listed = routes[entry.unit.label]
        if (Array.isArray(listed) && listed.length > 0) return priceRoute(entry.unit, listed[0], history, catalog)
        return definition.fallback === 'economy' ? (asRoute(entry.adequate[0]) ?? entry.cheapestDeclared) : entry.preferred
      }),
      budgetUsd,
      []
    ))
  }

  return {
    scenarios,
    units: perUnit.map((entry) => ({
      label: entry.unit.label ?? null,
      needs: entry.needs,
      implied: entry.implied,
      knowsRequirements: entry.knowsRequirements,
      candidates: entry.adequate.length,
      freeSkipped: entry.freeSkipped,
      cheapestAdequate: entry.adequate[0] === undefined ? null : {
        route: entry.adequate[0].route,
        catalogProvider: entry.adequate[0].provider,
        model: entry.adequate[0].model,
        usd: entry.adequate[0].usd,
        narrower: entry.adequate[0].narrower ?? null
      },
      alternatives: entry.adequate.slice(0, 3).map((candidate) => ({
        route: candidate.route,
        catalogProvider: candidate.provider,
        model: candidate.model,
        name: candidate.name,
        usd: candidate.usd,
        input: candidate.input,
        output: candidate.output,
        context: candidate.caps?.context ?? null,
        released: candidate.released,
        narrower: candidate.narrower ?? null
      }))
    }))
  }
}

/**
 * What to tell the user: where the money goes, what switching would save, and
 * which providers a scenario needs.
 */
export function recommend(scenarios, { budgetUsd = null, details = null } = {}) {
  const byName = new Map(scenarios.map((scenario) => [scenario.name, scenario]))
  const quality = byName.get('quality') ?? scenarios[0] ?? null
  const economy = byName.get('economy') ?? null

  const drivers = quality === null ? [] : quality.units
    .filter((unit) => unit.p50Usd !== null)
    .sort((a, b) => b.p50Usd - a.p50Usd)
    .map((unit, index) => ({
      label: unit.label,
      title: unit.title,
      route: unit.route,
      usd: unit.p50Usd,
      share: quality.totals.p50Usd > 0 ? unit.p50Usd / quality.totals.p50Usd : null,
      rank: index + 1
    }))

  const unitAlternatives = Array.isArray(details?.units) ? details.units : []
  const opportunities = []
  if (quality !== null && economy !== null) {
    for (const unit of quality.units) {
      const alternative = economy.units.find((candidate) => candidate.label === unit.label)
      if (alternative === undefined || alternative.p50Usd === null || unit.p50Usd === null) continue
      if (alternative.p50Usd >= unit.p50Usd) continue
      const details = unitAlternatives.find((entry) => entry.label === unit.label)
      opportunities.push({
        label: unit.label,
        title: unit.title,
        from: unit.route,
        to: alternative.route,
        usd: unit.p50Usd - alternative.p50Usd,
        factor: alternative.p50Usd > 0 ? unit.p50Usd / alternative.p50Usd : null,
        alternatives: details?.alternatives ?? []
      })
    }
    opportunities.sort((a, b) => b.usd - a.usd)
  }

  return {
    drivers,
    opportunities,
    savingsUsd: opportunities.reduce((sum, entry) => sum + entry.usd, 0),
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      p50Usd: scenario.totals.p50Usd,
      p90Usd: scenario.totals.p90Usd,
      fitsBudget: scenario.totals.fitsBudget,
      overBudgetBy: scenario.totals.overBudgetBy,
      providers: scenario.providers
    })),
    budgetUsd,
    note: 'Capability flags and prices are catalog facts; quality tiers, when given, are the caller\'s judgement. Nothing here measures model quality.'
  }
}
