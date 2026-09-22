/**
 * The reconciliation tool, against a synthetic export and a synthetic DSH home.
 *
 * A tool like this is only worth having if it fails when it should: one test
 * proves it finds the difference between the platform's bill and the session
 * logs, and another proves it refuses to trust a fold that contradicts the
 * harness's own counters instead of reporting that contradiction as the
 * platform's fault.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'reconcile.mjs')

/** One day, one project, one session: 1M cache-miss in, 500k out, 3M cache read. */
const DAY = '2026-09-22'
const TIME = Date.parse('2026-09-22T09:00:00+03:00')

function dshHome({ usage = { inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 3000000 }, searches = 0, durableShows = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reconcile-home-'))
  const dir = join(home, 'sessions', '--Users-someone-project--', 'session-abc')
  mkdirSync(dir, { recursive: true })
  const events = [
    { type: 'session', version: 1, id: 'session-abc', createdAt: TIME, cwd: '/tmp/project' },
    { type: 'request/header', seq: 0, time: TIME, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { type: 'step/start', seq: 1, time: TIME, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', seq: 2, time: TIME, data: { turn: 1, step: 1, chunk: { type: 'usage', usage } } },
    { type: 'assistant/message', seq: 3, time: TIME, data: { turn: 1, step: 1, usage } },
    { type: 'step/end', seq: 4, time: TIME, data: { turn: 1, step: 1 } }
  ]
  for (let index = 0; index < searches; index += 1) {
    events.push({ type: 'web/deepseek-search-llm-request', seq: 5 + index, time: TIME, data: { endpoint: 'https://api.deepseek.com/anthropic/v1/messages' } })
  }
  const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')))

  // What the harness's own cache claims for this session: the fold's source of
  // truth, so a test can hand it a number the log does not support.
  const durableMiss = durableShows === null ? usage.inputTokens : durableShows - usage.outputTokens - (usage.cacheReadTokens ?? 0)
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: {
      sessions: {
        'session-abc': {
          rows: {
            tokenUsage: {
              ver: 1,
              seq: 3,
              val: {
                totals: {
                  uncachedInputTokens: durableMiss,
                  outputTokens: usage.outputTokens,
                  cacheReadTokens: usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: 0
                },
                last: null
              }
            }
          }
        }
      }
    }
  }))
  return home
}

function exportDir({ miss, hit, out, requests, searchesBilled }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reconcile-export-'))
  const stamp = `${DAY}T00:00:00+03:00`
  const end = '2026-09-23T00:00:00+03:00'
  const amount = [
    'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
    `u,${stamp},${end},deepseek-flash,Harness,sk-x,input_cache_miss_tokens,0.0000003,${miss}`,
    `u,${stamp},${end},deepseek-flash,Harness,sk-x,input_cache_hit_tokens,0.000000006,${hit}`,
    `u,${stamp},${end},deepseek-flash,Harness,sk-x,output_tokens,0.0000012,${out}`,
    `u,${stamp},${end},deepseek-flash,Harness,sk-x,request_count,,${requests}`
  ].join('\n') + '\n'
  const cost = [
    'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
    `u,${stamp},${end},deepseek-flash,Paid,${(miss * 0.0000003 + hit * 0.000000006 + out * 0.0000012).toFixed(10)},USD`
  ].join('\n') + '\n'
  writeFileSync(join(dir, 'amount-2026-09-22_2026-09-22.csv'), amount)
  writeFileSync(join(dir, 'cost-2026-09-22_2026-09-22.csv'), cost)
  return { dir, billed: miss * 0.0000003 + hit * 0.000000006 + out * 0.0000012 }
}

function run(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

test('the tool prices the gap at the platform\'s own rates and correlates it with searches', () => {
  const home = dshHome({ searches: 4 })
  // The platform billed the session's tokens plus four search calls' worth.
  const exported = exportDir({ miss: 1000000 + 4000000, hit: 3000000, out: 500000 + 40000, requests: 5, searchesBilled: 4 })

  const result = run(['--export', exported.dir, '--dsh-home', home, '--json'])
  assert.equal(result.code, 0, `expected a clean reconciliation:\n${result.stdout}`)
  const report = JSON.parse(result.stdout)

  assert.equal(report.mismatches.length, 0, 'the fold reproduces the harness counters')
  assert.equal(report.rows.length, 1)
  const row = report.rows[0]
  assert.equal(row.day, DAY)
  assert.equal(row.searches, 4, 'the search calls are counted from the session log')
  assert.equal(row.local.miss, 1000000)
  assert.equal(row.delta.miss, 4000000, 'and the tokens nobody recorded are named')
  // Priced at the platform's own per-day unit prices: 4M miss and 40k out.
  const expected = 4000000 * 0.0000003 + 40000 * 0.0000012
  assert.ok(Math.abs(row.deltaUsd - expected) < 1e-9, `gap priced at the export's rates: ${row.deltaUsd}`)
  assert.ok(Math.abs(row.platformUsd - exported.billed) < 1e-9)
})

test('a day whose searches are absent reconciles, so a gap means something', () => {
  const home = dshHome()
  const exported = exportDir({ miss: 1000000, hit: 3000000, out: 500000, requests: 1, searchesBilled: 0 })
  const result = run(['--export', exported.dir, '--dsh-home', home, '--json'])
  const report = JSON.parse(result.stdout)

  assert.equal(report.rows[0].delta.miss, 0)
  assert.equal(report.rows[0].deltaUsd, 0)
  assert.match(run(['--export', exported.dir, '--dsh-home', home]).stdout, /days with no web search: 1, largest gap \$0\.0000/)
})

test('a fold that contradicts the harness counters is reported, not blamed on the platform', () => {
  // The durable cache claims ten million tokens the log does not contain: the
  // tool must fail loudly rather than call the difference a platform error.
  const home = dshHome({ durableShows: 10000000 })
  const exported = exportDir({ miss: 1000000, hit: 3000000, out: 500000, requests: 1, searchesBilled: 0 })
  const result = run(['--export', exported.dir, '--dsh-home', home, '--json'])

  assert.equal(result.code, 1, 'a broken fold is an error, not an answer')
  const report = JSON.parse(result.stdout)
  assert.equal(report.mismatches.length, 1)
  assert.equal(report.mismatches[0].id, 'session-abc')
  assert.equal(report.mismatches[0].durable, 10000000)
})

test('a missing export is refused with a usable message', () => {
  const result = run(['--dsh-home', dshHome()])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--export is required/)
})
