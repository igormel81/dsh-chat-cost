/**
 * How the ledger is read: the incremental base, the clamp, the change-detecting
 * cache and the bounded tail read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendCostLog, costRecord, ledgerBase, readLedger, subtractUsage } from '../lib/log.js'

const zeros = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

test('subtractUsage is bucket-wise and never goes negative', () => {
  assert.deepEqual(
    subtractUsage({ uncachedInputTokens: 10, cacheReadTokens: 5, outputTokens: 3 }, { uncachedInputTokens: 4, cacheReadTokens: 9, outputTokens: 3 }),
    { uncachedInput: 6, cacheRead: 0, cacheWrite: 0, output: 0 }
  )
  assert.deepEqual(subtractUsage(undefined, undefined), zeros)
})

test('the base is the last record of each session, in file order', () => {
  const costs = [
    costRecord({ sessionId: 'a', usage: { uncachedInputTokens: 100 }, cumulativeUsd: 0.1 }),
    costRecord({ sessionId: 'b', usage: { uncachedInputTokens: 50 }, cumulativeUsd: 0.05 }),
    costRecord({ sessionId: 'a', usage: { uncachedInputTokens: 300 }, cumulativeUsd: 0.3 })
  ]
  const base = ledgerBase(costs)
  assert.equal(base.get('a').cumulativeUsd, 0.3)
  assert.equal(base.get('a').tokens.uncachedInput, 300)
  assert.equal(base.get('b').cumulativeUsd, 0.05)
})

test('an unchanged file is not parsed twice, a changed one is', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-ledger-'))
  const cache = new Map()
  await appendCostLog(project, [costRecord({ sessionId: 'a', usage: { uncachedInputTokens: 10 }, cumulativeUsd: 0.01 })], {})

  const first = await readLedger(project, { cache })
  const second = await readLedger(project, { cache })
  assert.equal(first, second, 'the very same parsed object comes back while nothing moved')

  await appendCostLog(project, [costRecord({ sessionId: 'a', usage: { uncachedInputTokens: 20 }, cumulativeUsd: 0.02, deltaTokens: { uncachedInputTokens: 10 } })], {})
  const third = await readLedger(project, { cache })
  assert.equal(third.costs.length, 2, 'an append invalidates the cache')
  assert.equal(third, first === third ? first : third)
})

test('the tail read bounds the work and says what it skipped', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-tail-'))
  const records = []
  for (let index = 0; index < 200; index += 1) {
    records.push(costRecord({ ts: `2026-09-12T00:00:${String(index % 60).padStart(2, '0')}.000Z`, sessionId: `s${index}`, usage: { uncachedInputTokens: 1000 }, cumulativeUsd: 0.001 * index }))
  }
  await appendCostLog(project, records, {})
  const path = join(project, '.dsh-cost', 'cost.jsonl')
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(path))

  const tail = await readLedger(project, { tailBytes: Math.floor(size / 4) })
  assert.equal(tail.truncated, true)
  assert.ok(tail.skippedBytes > 0)
  assert.deepEqual(tail.broken, [], 'the partial first line is dropped, not reported as broken')
  assert.ok(tail.costs.length > 0 && tail.costs.length < 200, `read ${tail.costs.length} of 200 records`)
  assert.equal(tail.costs[tail.costs.length - 1].sessionId, 's199', 'the newest records are the ones kept')

  const whole = await readLedger(project, {})
  assert.equal(whole.truncated, false)
  assert.equal(whole.costs.length, 200)
})

test('a missing ledger reads as empty rather than throwing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-empty-'))
  const ledger = await readLedger(project, { cache: new Map() })
  assert.deepEqual(ledger.costs, [])
  assert.equal(ledger.path, null)
})

test('broken lines are skipped and counted, never fatal', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-broken-'))
  await appendCostLog(project, [costRecord({ sessionId: 'a', usage: { uncachedInputTokens: 1 }, cumulativeUsd: 0.001 })], {})
  await appendFile(join(project, '.dsh-cost', 'cost.jsonl'), '{ not json\n', 'utf8')
  const ledger = await readLedger(project, {})
  assert.equal(ledger.costs.length, 1)
  assert.equal(ledger.broken.length, 1)
})

test('empty and whitespace-only files read cleanly', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-cost-blank-'))
  await writeFile(join(project, 'cost.jsonl'), '\n\n  \n', 'utf8')
  const ledger = await readLedger(project, {})
  assert.deepEqual(ledger.costs, [])
  assert.equal(ledger.broken.length, 0)
})
