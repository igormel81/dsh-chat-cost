#!/usr/bin/env node
/**
 * Rebuild data/prices.json from the public models.dev catalog.
 *
 * Usage: node scripts/build-prices.mjs [--all]
 *
 * Without --all only the curated providers below are snapshotted (small file,
 * offline-capable). With --all every provider in the catalog is included.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Providers whose prices are snapshotted by default. */
const CURATED = ['deepseek', 'moonshotai', 'openai', 'anthropic', 'google', 'xai', 'mistral']

const SOURCE = 'https://models.dev/api.json'
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'prices.json')
const all = process.argv.includes('--all')

/** Keep only the price-relevant fields; drop nulls so the file stays small. */
function normalizeCost(cost) {
  if (cost === null || typeof cost !== 'object') return null
  const out = {}
  if (typeof cost.input === 'number') out.input = cost.input
  if (typeof cost.output === 'number') out.output = cost.output
  if (typeof cost.cache_read === 'number') out.cacheRead = cost.cache_read
  if (typeof cost.cache_write === 'number') out.cacheWrite = cost.cache_write
  if (typeof cost.reasoning === 'number') out.reasoning = cost.reasoning
  if (Array.isArray(cost.tiers) && cost.tiers.length > 0) {
    out.tiers = cost.tiers.map((tier) => ({
      size: typeof tier?.tier?.size === 'number' ? tier.tier.size : null,
      input: tier?.input ?? null,
      output: tier?.output ?? null,
      cacheRead: tier?.cache_read ?? null,
      cacheWrite: tier?.cache_write ?? null
    }))
  }
  return Object.keys(out).length > 0 ? out : null
}

const response = await fetch(SOURCE, { headers: { 'user-agent': 'dsh-chat-cost price snapshot' } })
if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
const catalog = await response.json()

const providers = {}
for (const [key, provider] of Object.entries(catalog)) {
  if (!all && !CURATED.includes(key)) continue
  const models = {}
  for (const [id, model] of Object.entries(provider.models ?? {})) {
    const cost = normalizeCost(model.cost)
    if (cost === null) continue
    models[id] = { name: model.name ?? id, cost }
  }
  if (Object.keys(models).length === 0) continue
  providers[key] = { name: provider.name ?? key, models }
}

const snapshot = {
  source: SOURCE,
  generatedAt: new Date().toISOString(),
  curated: all ? null : CURATED,
  providers
}

await writeFile(out, JSON.stringify(snapshot, null, 1) + '\n')
const modelCount = Object.values(providers).reduce((sum, p) => sum + Object.keys(p.models).length, 0)
console.log(`wrote ${out}: ${Object.keys(providers).length} providers, ${modelCount} priced models`)
