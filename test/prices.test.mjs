import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { canonicalModelId, isPeakUtc, priceUsage, providerKey, resolvePrice } from '../lib/prices.js'

const here = dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(await readFile(join(here, '..', 'data', 'prices.json'), 'utf8'))

test('provider routes map onto catalog providers', () => {
  assert.equal(providerKey('deepseek-official'), 'deepseek')
  assert.equal(providerKey('moonshot'), 'moonshotai')
  assert.equal(providerKey('Claude'), 'anthropic')
  assert.equal(providerKey('gemini'), 'google')
  assert.equal(providerKey('unknown-route'), null)
})

test('model ids are canonicalized', () => {
  assert.equal(canonicalModelId('deepseek/deepseek-v4.1-flash'), 'deepseek-flash')
  assert.equal(canonicalModelId('openai/gpt-5-nano:batch'), 'gpt-5-nano')
  assert.equal(canonicalModelId('Kimi-K3'), 'kimi-k3')
})

test('deepseek uses the official table with peak tiers', () => {
  const price = resolvePrice(catalog, 'deepseek-official', 'deepseek-flash')
  assert.equal(price.source, 'official')
  assert.equal(price.cost.input, 0.15)
  assert.equal(price.cost.peakMultiplier, 2)

  const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  assert.equal(Math.round(priceUsage(price, usage, { peak: false }).usd * 1000) / 1000, 0.15)
  assert.equal(Math.round(priceUsage(price, usage, { peak: true }).usd * 1000) / 1000, 0.3)
})

test('catalog providers resolve with cache write prices', () => {
  const anthropic = resolvePrice(catalog, 'anthropic', 'claude-opus-5')
  assert.equal(anthropic.source, 'catalog')
  assert.equal(anthropic.cost.cacheWrite, 6.25)

  const kimi = resolvePrice(catalog, 'moonshot', 'kimi-k3')
  assert.equal(kimi.cost.cacheRead, 0.3)

  const grok = resolvePrice(catalog, 'xai', 'grok-4.3')
  assert.equal(grok.cost.input, 1.25)
})

test('cache read without a published price falls back to the input price', () => {
  const price = { cost: { input: 2, output: 4, cacheRead: null, cacheWrite: null, peakMultiplier: 1 } }
  const usage = { uncachedInputTokens: 0, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 0 }
  assert.equal(priceUsage(price, usage).usd, 2)
})

test('both accepted usage shapes price identically', () => {
  const price = resolvePrice(catalog, 'deepseek-official', 'deepseek-flash')
  const raw = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  const normalized = { uncachedInput: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }
  const fromRaw = priceUsage(price, raw)
  const fromNormalized = priceUsage(price, normalized)
  assert.equal(fromRaw.usd, fromNormalized.usd, 'a shape mismatch must not silently price zero')
  assert.equal(fromNormalized.usd, 0.15)
})

test('unknown models resolve to null instead of a guessed price', () => {
  assert.equal(resolvePrice(catalog, 'openai', 'not-a-real-model'), null)
  assert.equal(resolvePrice(catalog, 'nope', 'gpt-5-nano'), null)
  assert.equal(priceUsage(null, {}), null)
})

test('peak windows are weekdays 01:00-04:00 and 06:00-10:00 UTC', () => {
  assert.equal(isPeakUtc(new Date('2026-09-14T02:00:00Z')), true)  // Monday
  assert.equal(isPeakUtc(new Date('2026-09-14T05:00:00Z')), false)
  assert.equal(isPeakUtc(new Date('2026-09-14T07:30:00Z')), true)
  assert.equal(isPeakUtc(new Date('2026-09-13T02:00:00Z')), false) // Sunday
})
