/**
 * Loads the shipped client bundle (lib/client.js) with a stubbed module loader
 * and React, so the three-language UI strings and the language resolution are
 * covered as they actually ship — not as a copy kept in the test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Evaluate the bundle as a browser would: a bare script with `window`. */
function loadBundle() {
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } }, navigator: { language: 'en-US' } }
  new Function('window', source)(window)
  assert.equal(entry.id, 'dsh-chat-cost', 'bundle registers under its package id')
  const react = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}
  }
  const loaded = entry.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error('unexpected require: ' + specifier)
  })
  return loaded
}

const bundle = loadBundle()
const strings = bundle.__strings
const resolveLanguage = bundle.__resolveLanguage

/** The languages the plugin promises to ship. */
const EXPECTED = ['en', 'zh', 'ru']

test('the bundle exposes a Cordis plugin contract', () => {
  assert.equal(bundle.name, 'dsh-chat-cost')
  assert.deepEqual(bundle.inject, ['connection'])
  assert.equal(typeof bundle.apply, 'function')
})

test('all three languages ship', () => {
  assert.deepEqual(Object.keys(strings).sort(), [...EXPECTED].sort())
  assert.deepEqual([...bundle.__languages].sort(), [...EXPECTED].sort())
})

test('every language defines exactly the same keys', () => {
  const reference = Object.keys(strings.en).sort()
  for (const language of EXPECTED) {
    assert.deepEqual(Object.keys(strings[language]).sort(), reference, `${language} key set`)
  }
})

test('every string is a non-empty value and every function has one arity per key', () => {
  for (const key of Object.keys(strings.en)) {
    const arities = new Set()
    for (const language of EXPECTED) {
      const value = strings[language][key]
      const kind = typeof value
      assert.ok(kind === 'string' || kind === 'function', `${language}.${key} is a string or function`)
      if (kind === 'string') assert.notEqual(value.trim(), '', `${language}.${key} is not empty`)
      else arities.add(value.length)
    }
    assert.equal(arities.size <= 1, true, `${key} keeps one arity across languages`)
  }
})

test('every message renders in every language with sample arguments', () => {
  const buckets = { uncachedInput: '1.2K', cacheRead: '3.4K', cacheWrite: '0', output: '567' }
  const sample = { self: ['0.0123'], subagents: ['0.0040', 3], tree: ['0.0163'], tokens: [buckets], models: ['deepseek-flash · kimi-k3'], unpriced: [2], log: ['/tmp/p/.dsh-cost/cost.jsonl'] }
  for (const language of EXPECTED) {
    for (const [key, args] of Object.entries(sample)) {
      const value = strings[language][key]
      if (typeof value !== 'function') continue
      const rendered = value(...args)
      assert.equal(typeof rendered, 'string')
      assert.notEqual(rendered.trim(), '', `${language}.${key} renders text`)
      for (const arg of args) {
        if (typeof arg === 'string') assert.ok(rendered.includes(arg), `${language}.${key} keeps its argument`)
      }
    }
    for (const key of ['hostDown', 'hostDownTip', 'title', 'refresh']) {
      assert.notEqual(strings[language][key].trim(), '', `${language}.${key} is not empty`)
    }
  }
})

test('language resolution prefers plugin config, then harness locale, then browser', () => {
  assert.equal(resolveLanguage('ru', 'zh', 'en-US'), 'ru')
  assert.equal(resolveLanguage(null, 'zh-CN', 'ru-RU'), 'zh')
  assert.equal(resolveLanguage(null, null, 'ru-RU'), 'ru')
  assert.equal(resolveLanguage(null, null, 'ru'), 'ru')
  assert.equal(resolveLanguage(null, null, 'de-DE'), 'en')
  assert.equal(resolveLanguage('', '', ''), 'en')
  assert.equal(resolveLanguage(undefined, undefined, undefined), 'en')
  assert.equal(resolveLanguage('ZH_tw', null, null), 'zh')
  assert.equal(resolveLanguage('klingon', null, null), 'en')
})

test('cost formatting stays readable across magnitudes', () => {
  assert.equal(bundle.__formatUsd(0.0000123), '0.00001')
  assert.equal(bundle.__formatUsd(0.0163), '0.0163')
  assert.equal(bundle.__formatUsd(2.5), '2.500')
  assert.equal(bundle.__formatUsd(123.456), '123.46')
  assert.equal(bundle.__formatUsd(null), null)
  assert.equal(bundle.__formatUsd(NaN), null)
})
