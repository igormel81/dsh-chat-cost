import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendCostLog, costRecord, ensureGitignore, isGitWorkTree, LOG_DIR, LOG_FILE } from '../lib/log.js'

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
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.gitignore'), 'node_modules\n', 'utf8')
  await ensureGitignore(dir)
  await ensureGitignore(dir)
  const text = await readFile(join(dir, '.gitignore'), 'utf8')
  assert.equal(text, 'node_modules\n.dsh-cost/\n')

  const empty = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  await mkdir(join(empty, '.git'), { recursive: true })
  await ensureGitignore(empty)
  assert.equal(await readFile(join(empty, '.gitignore'), 'utf8'), '.dsh-cost/\n')
})

test('a plain folder is left alone instead of receiving a stray .gitignore', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  assert.equal(await isGitWorkTree(plain), false)
  assert.equal(await ensureGitignore(plain), null)
  await assert.rejects(() => readFile(join(plain, '.gitignore'), 'utf8'))

  // A worktree or submodule marks `.git` as a FILE, and must still be recognised.
  const worktree = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n', 'utf8')
  assert.equal(await isGitWorkTree(worktree), true)
  await ensureGitignore(worktree)
  assert.equal(await readFile(join(worktree, '.gitignore'), 'utf8'), '.dsh-cost/\n')
})

test('appending without records or without a directory fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-'))
  await assert.rejects(() => appendCostLog(dir, []), /no records/)
  await assert.rejects(() => appendCostLog('', [costRecord({ sessionId: 'x' })]), /projectDir is required/)
})
