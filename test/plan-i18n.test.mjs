/**
 * The generated plan document is a document people read, so it follows the
 * plugin's language: the widget's three languages must reach the file too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPlanMarkdown, writePlan } from '../lib/plan.js'

const PLAN = {
  goal: 'ship the beta',
  budgetUsd: 25,
  reserveUsd: 5,
  spendableUsd: 20,
  units: [
    { label: 'research', title: 'Market research', route: { model: 'deepseek-flash' }, p50Usd: 2.1, p90Usd: 4.2, status: 'planned' },
    { label: 'synthesis', title: 'Write-up', route: { model: 'kimi-k3' }, p50Usd: 5.5, p90Usd: 11, status: 'planned' }
  ],
  totals: { p50Usd: 7.6, p90Usd: 15.2, deferredCount: 1 },
  scenarios: [{ name: 'economy', totals: { p50Usd: 0.26, p90Usd: 0.52, fitsBudget: true }, providers: ['google'] }],
  recommendation: { savingsUsd: 7.16, opportunities: [{ label: 'synthesis', from: { model: 'kimi-k3' }, to: { model: 'gemini-2.5-flash-lite' }, usd: 5.67 }] },
  deferred: [{ label: 'extra', title: 'Extra work', p90Usd: 9, cheapestP90Usd: 7 }]
}

const CONTEXT = { actuals: [{ label: 'research', usd: 1.84 }], burn: { usdPerHour: 0.4, samples: 3, hoursToLimit: 12.5 } }

test('every language has its own title and column set', () => {
  const en = renderPlanMarkdown(PLAN, { ...CONTEXT, language: 'en' })
  const zh = renderPlanMarkdown(PLAN, { ...CONTEXT, language: 'zh' })
  const ru = renderPlanMarkdown(PLAN, { ...CONTEXT, language: 'ru' })

  assert.match(en, /^# Cost plan: ship the beta/m)
  assert.match(zh, /^# 费用计划: ship the beta/m)
  assert.match(ru, /^# План расходов: ship the beta/m)

  assert.match(en, /\| Unit \| Route \| Expected \| Worst case \| Actual \| Status \|/)
  assert.match(zh, /\| 单元 \| 路由 \| 预期 \| 最坏 \| 实际 \| 状态 \|/)
  assert.match(ru, /\| Пункт \| Маршрут \| Ожидание \| Худший случай \| Факт \| Статус \|/)

  // Nothing English leaks into the translated documents.
  for (const [language, text] of [['zh', zh], ['ru', ru]]) {
    for (const word of ['Cost plan', 'Budget:', 'Worst case', 'Scenarios', 'Deferred (']) {
      assert.equal(text.includes(word), false, `${language} must not contain "${word}"`)
    }
  }
})

test('the numbers and the actuals survive translation', () => {
  for (const language of ['en', 'zh', 'ru']) {
    const text = renderPlanMarkdown(PLAN, { ...CONTEXT, language })
    assert.match(text, /\$25\.000/, `${language} shows the budget`)
    assert.match(text, /\$1\.840/, `${language} shows the measured actual`)
    assert.match(text, /Market research/, `${language} keeps the unit title`)
    assert.match(text, /gemini-2\.5-flash-lite/, `${language} keeps the recommended model`)
    assert.match(text, /deepseek-flash/, `${language} keeps the route`)
    assert.match(text, /12\.5/, `${language} keeps the burn projection`)
    assert.match(text, /bootstrap/, `${language} keeps the estimate-basis note`)
  }
})

test('an unknown or missing language falls back to English', () => {
  const fallback = renderPlanMarkdown(PLAN, CONTEXT)
  assert.match(fallback, /^# Cost plan/m)
  assert.match(renderPlanMarkdown(PLAN, { ...CONTEXT, language: 'klingon' }), /^# Cost plan/m)
})

test('writePlan writes the document in the requested language', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-planlang-'))
  const paths = await writePlan(project, PLAN, { context: { ...CONTEXT, language: 'ru' } })
  const markdown = await readFile(paths.markdown, 'utf8')
  assert.match(markdown, /^# План расходов/m)
  assert.match(markdown, /## Сценарии/)
  assert.match(markdown, /## Отложено/)
  const stored = JSON.parse(await readFile(paths.plan, 'utf8'))
  assert.equal(stored.kind, 'dsh-chat-cost-plan')
  assert.equal(stored.units.length, 2)
})

test('a minimal plan renders without a budget, scenario or deferral section', () => {
  const text = renderPlanMarkdown({ units: [], totals: { p50Usd: 0, p90Usd: 0, deferredCount: 0 } }, { language: 'ru' })
  assert.match(text, /Бюджет: не задан/)
  assert.equal(text.includes('## Сценарии'), false)
  assert.equal(text.includes('## Отложено'), false)
})
