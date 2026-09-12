/**
 * The widget as it renders: the shipped client bundle is loaded with a stub
 * module loader, a hook store that behaves like React's, and a fake fetch that
 * answers the Host route. This covers what the user actually sees — the readout,
 * the tooltip lines for budget, plan and scenarios — and the language switching.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/** Load the bundle the way a browser would, and hand back its plugin contract. */
function loadBundle({ navigatorLanguage = 'en-US', fetchImpl = async () => { throw new Error('no host') }, localeService = undefined, pluginConfig = undefined } = {}) {
  let entry = null
  const requires = []
  const window = {
    __ModuleLoader__: { load: (value) => { entry = value } },
    navigator: { language: navigatorLanguage },
    fetch: fetchImpl,
    setInterval: () => 0,
    clearInterval: () => {}
  }
  // `document` is a free identifier in the bundle, so it is injected the same way.
  const styles = []
  const document = {
    createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
    head: { appendChild: (node) => styles.push(node) }
  }
  new Function('window', 'document', source)(window, document)

  // A hook store that survives re-renders, keyed by call order, like React's.
  const store = []
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (store[index] === undefined) store[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        store[index] = typeof next === 'function' ? next(store[index]) : next
      }
      return [store[index], setter]
    },
    useEffect: (callback) => {
      const index = cursor
      cursor += 1
      if (store.done === undefined) store.done = new Set()
      if (store.done.has(index) === false) {
        store.done.add(index)
        callback()
      }
    }
  }
  const loaded = entry.factory((specifier) => {
    requires.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })

  const slot = { render: null, register: null }
  const base = {
    get(name) {
      if (name === 'slots') {
        return {
          inject: (_name, callback) => { callback() },
          register: (spec, render) => { slot.register = spec; slot.render = render }
        }
      }
      if (name === 'locale') return localeService
      if (name === 'connection') return { api: { sessions: { models: async () => ({ result: { ok: true, value: { current: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }) } } }
      return undefined
    },
    effect: () => () => {}
  }

  // The Client half runs the same Cordis as the Host: a property the plugin did
  // not inject throws. Reading config from here is what broke the shell in
  // 0.5.1 while the Host half was already fixed, so the stub refuses it too.
  const ctx = new Proxy(base, {
    get(target, property) {
      if (property === 'config') throw new Error('cannot get property "config" without inject')
      return Reflect.get(target, property)
    }
  })

  loaded.apply(ctx, pluginConfig)

  /**
   * Render with fresh hooks, the way React would: the slot hands back an ELEMENT
   * whose type is the component, and React is what invokes that component.
   */
  const render = (props) => {
    const element = slot.render(props)
    if (element === null || element === undefined) return null
    if (typeof element.type !== 'function') return element
    cursor = 0
    return element.type(element.props)
  }
  return { loaded, slot, render, requires, store, styles }
}

const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }

/** A Host summary shaped exactly like the real route's answer. */
const summary = {
  ok: true,
  rootSessionId: 'root',
  workspace: '/tmp/project',
  logPath: '/tmp/project/.dsh-cost/cost.jsonl',
  language: null,
  self: { sessionId: 'root' },
  sessions: [{ sessionId: 'root', model: 'deepseek-flash', usd: 0.15 }],
  totals: { usd: 0.165, chatUsd: 0.15, subagentUsd: 0.015, subagentCount: 1, unpricedSessions: [] },
  budget: { usd: 25, spentUsd: 0.165, remainingUsd: 24.835, projection: 'ok', usdPerHour: 0.4 },
  unlabeledUsd: 1.23,
  plan: {
    goal: 'beta',
    units: [
      { label: 'research', title: 'Market research', route: { model: 'deepseek-flash' }, p50Usd: 2.1, p90Usd: 4.2, status: 'planned', actualUsd: 1.84 },
      { label: 'synthesis', title: 'Write-up', route: { model: 'kimi-k3' }, p50Usd: 5.5, p90Usd: 11, status: 'planned', actualUsd: null }
    ],
    deferredCount: 1,
    scenarios: [
      { name: 'economy', p50Usd: 0.26, providers: ['google', 'openai'] },
      { name: 'balanced', p50Usd: 5.93, providers: ['moonshot'] },
      { name: 'quality', p50Usd: 7.42, providers: ['moonshot'] }
    ],
    savingsUsd: 7.16,
    opportunities: [{ label: 'synthesis', from: { model: 'kimi-k3' }, to: { model: 'gemini-2.5-flash-lite' }, usd: 5.67 }]
  }
}

const respondWith = (body) => async () => ({ ok: true, json: async () => body })

test('the bundle requires nothing beyond the shell-seeded React', () => {
  const { requires, loaded } = loadBundle()
  assert.deepEqual([...new Set(requires)], ['react'])
  assert.deepEqual(loaded.inject, ['connection'])
})

test('the widget registers itself into the composer dock under its own id', () => {
  const { slot, styles } = loadBundle()
  assert.equal(slot.register.name, 'conversation.composer.dock')
  assert.equal(slot.register.id, 'dsh-chat-cost')
  assert.equal(slot.register.order, 100)
  assert.equal(styles.length, 1, 'its own stylesheet is injected once')
  assert.equal(styles[0].dataset.plugin, 'dsh-chat-cost')
  assert.match(styles[0].textContent, /\.dsh-chat-cost/)
})

test('it renders nothing instead of crashing when the projection is absent', () => {
  const { render } = loadBundle()
  assert.equal(render({ sessionId: 'root', useProjection: () => undefined }), null)
  assert.equal(render({ useProjection: () => undefined }), null)
})

test('the readout carries the tree total and the budget, and the tooltip names the plan', async () => {
  const { render } = loadBundle({ fetchImpl: respondWith(summary) })
  const first = render({ sessionId: 'root', useProjection: () => usage })
  await new Promise((resolve) => setImmediate(resolve))
  const second = render({ sessionId: 'root', useProjection: () => usage })

  const node = second ?? first
  assert.ok(node !== null, 'the widget renders once the summary arrives')
  assert.equal(node.type, 'span')
  assert.match(node.children.join(''), /≈ \$0\.1650/, 'the tree total is the headline')
  assert.match(node.children.join(''), /\/ \$25\.000/, 'and the budget is beside it')

  const tip = node.props.title
  assert.match(tip, /session tree total: \$0\.1650/)
  assert.match(tip, /subagents \(1\): \$0\.0150/)
  assert.match(tip, /this chat: \$0\.1500/)
  assert.match(tip, /budget: \$0\.1650 of \$25\.000/)
  assert.match(tip, /plan: 2 unit\(s\)/)
  assert.match(tip, /Market research \(deepseek-flash\): \$2\.100 planned, \$1\.840 actual/)
  assert.match(tip, /1 unit\(s\) did not fit the budget/)
  assert.match(tip, /scenarios: economy \$0\.2600 · balanced \$5\.930 · quality \$7\.420/)
  assert.match(tip, /cheapest adequate routing saves \$7\.160/)
  assert.match(tip, /cost log: \/tmp\/project\/\.dsh-cost\/cost\.jsonl/)
  assert.match(tip, /\$1\.230 is not attributed to any plan unit/, 'unclaimed spend is called out')
  assert.match(tip, /\u00b7 synthesis \(kimi-k3 \u2192 gemini-2\.5-flash-lite\): \$5\.670 planned/, 'route objects print as model names, never as [object Object]')
})

test('an over-budget projection is stated in the tooltip', async () => {
  const over = { ...summary, budget: { usd: 10, spentUsd: 12.5, remainingUsd: -2.5, projection: 'over', usdPerHour: 3 } }
  const { render } = loadBundle({ fetchImpl: respondWith(over) })
  render({ sessionId: 'root', useProjection: () => usage })
  await new Promise((resolve) => setImmediate(resolve))
  const node = render({ sessionId: 'root', useProjection: () => usage })
  assert.match(node.props.title, /over budget by \$2\.500/)
})

test('the interface speaks English, Chinese or Russian with equal content', async () => {
  const chinese = loadBundle({ navigatorLanguage: 'zh-CN', fetchImpl: respondWith(summary) })
  chinese.render({ sessionId: 'root', useProjection: () => usage })
  await new Promise((resolve) => setImmediate(resolve))
  const zhNode = chinese.render({ sessionId: 'root', useProjection: () => usage })
  assert.match(zhNode.props.title, /token 费用估算/)
  assert.match(zhNode.props.title, /预算：/)
  assert.match(zhNode.props.title, /方案：/)
  assert.match(zhNode.props.title, /\$1\.230 未归入任何计划单元/)

  const russian = loadBundle({ navigatorLanguage: 'ru-RU', fetchImpl: respondWith(summary) })
  russian.render({ sessionId: 'root', useProjection: () => usage })
  await new Promise((resolve) => setImmediate(resolve))
  const ruNode = russian.render({ sessionId: 'root', useProjection: () => usage })
  assert.match(ruNode.props.title, /Стоимость токенов/)
  assert.match(ruNode.props.title, /бюджет:/)
  assert.match(ruNode.props.title, /сценарии:/)
  assert.match(ruNode.props.title, /\$1\.230 не отнесено ни к одному пункту плана/)
})

test('a Host that does not answer degrades to tokens and says so', async () => {
  const { render } = loadBundle({ fetchImpl: async () => { throw new Error('offline') } })
  render({ sessionId: 'root', useProjection: () => usage })
  await new Promise((resolve) => setImmediate(resolve))
  const node = render({ sessionId: 'root', useProjection: () => usage })
  assert.equal(node.props.className, 'dsh-chat-cost dsh-chat-cost--muted')
  assert.match(node.props.title, /did not answer/)
  assert.match(node.props.title, /tokens — input 1\.0M/)
})

test('the widget language arrives through the loader argument', async () => {
  // The browser would prefer English here; the config the loader passes must win.
  const { render } = loadBundle({ pluginConfig: { language: 'ru' }, navigatorLanguage: 'en-US', fetchImpl: respondWith(summary) })
  const first = render({ sessionId: 'root', useProjection: () => usage })
  await new Promise((resolve) => setImmediate(resolve))
  const node = render({ sessionId: 'root', useProjection: () => usage }) ?? first
  assert.ok(node !== null, 'the widget renders once the summary arrives')
  assert.match(node.props.title, /Стоимость токенов/, 'the config wins over the browser language')
})
