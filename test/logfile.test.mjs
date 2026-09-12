import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendCostLog, costRecord, ensureGitignore, LOG_DIR, LOG_FILE } from '../lib/log.js'

test('the log is appended as JSONL and never rewritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  const first = costRecord({ ts: '2026-09-12T20:00:00.000Z', sessionId: 'root', usage: { uncachedInputTokens: 10 }, cumulativeUsd: 0.001, deltaUsd: 0.001 })
  const second = costRecord({ ts: '2026-09-12T20:01:00.000Z', sessionId: 'root', usage: { uncachedInputTokens: 20 }, cumulativeUsd: 0.002, deltaUsd: 0.001 })

  const path = await appendCostLog(dir, [first])
  assert.equal(path, join(dir, LOG_DIR, LOG_FILE))
  await appendCostLog(dir, [second])

  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).cumulativeUsd, 0.001)
  assert.equal(JSON.parse(lines[1]).cumulativeUsd, 0.002)
})

test('a project .gitignore gains the log directory once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  await writeFile(join(dir, '.gitignore'), 'node_modules\n', 'utf8')
  await ensureGitignore(dir)
  await ensureGitignore(dir)
  const text = await readFile(join(dir, '.gitignore'), 'utf8')
  assert.equal(text, 'node_modules\n.dsh-cost/\n')

  const empty = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  await ensureGitignore(empty)
  assert.equal(await readFile(join(empty, '.gitignore'), 'utf8'), '.dsh-cost/\n')
})

test('appending without records or without a directory fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  await assert.rejects(() => appendCostLog(dir, []), /no records/)
  await assert.rejects(() => appendCostLog('', [costRecord({ sessionId: 'x' })]), /projectDir is required/)
})
