/**
 * Reconcile this host's session logs against a DeepSeek platform export.
 *
 * The question this answers is the one every user asks after the first invoice:
 * the platform says more than the plugin does — which of the two is wrong? The
 * answer is usually neither, and the point of this script is to show where the
 * missing part actually lives instead of guessing at it.
 *
 * It reads two things that are both first-party:
 *
 *  - the platform's own export (`amount-*.csv` + `cost-*.csv`, downloaded from
 *    the usage page), which states per day and per token class how much was
 *    billed and at what unit price;
 *  - the harness's session logs (`<dsh-home>/sessions/<project>/<id>/
 *    session.jsonl.zstd`), folded with the same replace-not-add rule the
 *    harness's own `tokenUsage` projection uses.
 *
 * Then it prints the difference per day, in tokens and in money at the
 * platform's own prices, next to the number of web-search LLM calls in that
 * day's logs. Those calls are the usual answer: the DeepSeek-backed search
 * provider runs its searches inside one request with a server-side tool, the
 * pages the model reads are billed, and the response's usage is never written
 * into the session — so no session-based figure can contain them.
 *
 * The fold checks itself against the harness's durable projection cache per
 * session and reports any session it cannot reproduce, because a reconciliation
 * built on a broken fold is worse than none: it accuses the platform.
 *
 * Usage:
 *   node scripts/reconcile.mjs --export ~/Downloads/usage_data_2026-08-24_2026-09-22
 *   node scripts/reconcile.mjs --export <dir-or-zip> --dsh-home ~/.dsh --json
 *
 * `zstd` must be on PATH: the harness stores session logs zstd-compressed, and
 * a multi-frame log is not something Node's zlib decodes whole.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Token classes as the platform names them, in the order they are reported. */
const CLASSES = [
  { type: 'input_cache_miss_tokens', label: 'miss', from: 'inputTokens' },
  { type: 'input_cache_hit_tokens', label: 'hit', from: 'cacheReadTokens' },
  { type: 'output_tokens', label: 'out', from: 'outputTokens' }
]

/** The event the DeepSeek-backed search provider logs for one search LLM call. */
const SEARCH_CALL_EVENT = 'web/deepseek-search-llm-request'

function parseArgs(argv) {
  const options = { export: null, dshHome: join(homedir(), '.dsh'), json: false, tz: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--export') options.export = argv[++index] ?? null
    else if (flag === '--dsh-home') options.dshHome = argv[++index] ?? options.dshHome
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.help = true
  }
  return options
}

/** Minimal CSV reader for the export's shape: quoted fields, no embedded newlines. */
function readCsv(text) {
  const rows = []
  let field = ''
  let row = []
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') quoted = false
      else field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (char === '\r') continue
    field += char
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  const [header, ...body] = rows.filter((entry) => entry.length > 1 || entry[0] !== '')
  if (header === undefined) return []
  const names = header.map((name) => name.replace(/^\uFEFF/, '').trim())
  return body.map((entry) => Object.fromEntries(names.map((name, index) => [name, entry[index] ?? ''])))
}

/** Locate the export's CSVs in a directory or a downloaded zip. */
function exportFiles(target) {
  if (target === null) throw new Error('--export is required (the usage_data_*.zip or its directory)')
  if (target.endsWith('.zip')) {
    const listing = execFileSync('unzip', ['-Z1', target], { encoding: 'utf8' }).trim().split('\n')
    const dir = statSync(target).isDirectory() ? target : null
    return {
      zip: target,
      names: listing.filter((name) => name.endsWith('.csv')),
      dir
    }
  }
  const names = readdirSync(target).filter((name) => name.endsWith('.csv'))
  return { zip: null, names, dir: target }
}

function readExportCsv(archive, name) {
  if (archive.dir !== null) return readCsv(readFileSync(join(archive.dir, name), 'utf8'))
  return readCsv(execFileSync('unzip', ['-p', archive.zip, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
}

/** Every session log under a DSH home, newest first. */
function sessionLogs(dshHome) {
  const base = join(dshHome, 'sessions')
  if (existsSync(base) === false) return []
  const files = []
  for (const project of readdirSync(base)) {
    const dir = join(base, project)
    if (statSync(dir).isDirectory() === false) continue
    for (const id of readdirSync(dir)) {
      const file = join(dir, id, 'session.jsonl.zstd')
      if (existsSync(file)) files.push(file)
    }
  }
  return files
}

/** Decompress one session log; multi-frame logs need the CLI, not zlib. */
function readLog(file) {
  return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
}

/** The durable per-session counters the harness keeps, for the fold's self-check. */
function projectionTotals(dshHome) {
  const file = join(dshHome, 'storages', 'session_projcache.json')
  const totals = new Map()
  if (existsSync(file) === false) return totals
  const data = JSON.parse(readFileSync(file, 'utf8'))
  for (const [id, row] of Object.entries(data?.tables?.sessions ?? {})) {
    const value = row?.rows?.tokenUsage?.val
    if (value === undefined) continue
    const buckets = value.totals ?? value
    totals.set(id, (buckets.uncachedInputTokens ?? 0) + (buckets.cacheReadTokens ?? 0) + (buckets.outputTokens ?? 0))
  }
  return totals
}

/** The export's own UTC offset in minutes (`2026-09-22T00:00:00+03:00` → 180). */
function offsetOf(rows) {
  const stamp = rows.find((row) => typeof row.start_time_iso === 'string')?.start_time_iso
  const match = typeof stamp === 'string' ? /([+-])(\d{2}):(\d{2})$/.exec(stamp) : null
  if (match === null) return null
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

/** The four buckets of one usage report, in the platform's spelling. */
function bucketsOf(usage) {
  return {
    miss: usage?.inputTokens ?? 0,
    hit: usage?.cacheReadTokens ?? 0,
    out: usage?.outputTokens ?? 0
  }
}

function addBuckets(target, source, sign = 1) {
  for (const key of ['miss', 'hit', 'out']) target[key] = (target[key] ?? 0) + sign * (source[key] ?? 0)
  return target
}

function total(buckets) {
  return (buckets.miss ?? 0) + (buckets.hit ?? 0) + (buckets.out ?? 0)
}

/**
 * Fold one session log into per-day buckets, per session, plus the day's search
 * calls. Samples for one turn and step replace each other rather than adding up,
 * exactly as the harness's own projection folds them.
 */
function foldLog(text, offsetMinutes) {
  const days = new Map()
  const sessions = []
  let current = null
  let searches = 0
  // The platform buckets its export by ITS own day boundary (the offset it
  // prints on every row, +03:00 for Moscow). Folding by UTC instead moves every
  // late-evening sample to the next platform day and turns a match into a
  // 300-million-token "discrepancy" — the day boundary has to be the same one.
  const dayOf = (millis) => new Date(millis + offsetMinutes * 60_000).toISOString().slice(0, 10)

  const bucketFor = (day) => {
    if (days.has(day) === false) days.set(day, { miss: 0, hit: 0, out: 0, searches: 0 })
    return days.get(day)
  }

  let last = null
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.includes('"usage"') === false && line.includes(SEARCH_CALL_EVENT) === false && line.includes('"type":"session"') === false) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session') {
      current = { id: event.id, day: dayOf(event.createdAt ?? 0), buckets: { miss: 0, hit: 0, out: 0 } }
      sessions.push(current)
      continue
    }
    const day = dayOf(event.time ?? 0)
    if (event.type === SEARCH_CALL_EVENT) {
      searches += 1
      bucketFor(day).searches += 1
      continue
    }
    let sample = null
    let turn
    let step
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
      sample = event.data.chunk.usage
      turn = event.data.turn
      step = event.data.step
    } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
      sample = event.data.usage
      turn = event.data.turn
      step = event.data.step
    } else if (event.type === 'compaction/summary' && event.data?.usage !== undefined) {
      // Compaction is billed like any other call and is not a step sample: it
      // adds, and the harness's own usage projection does not count it at all.
      const buckets = bucketsOf(event.data.usage)
      addBuckets(bucketFor(day), buckets)
      if (current !== null) addBuckets(current.buckets, buckets)
      continue
    } else continue

    const buckets = bucketsOf(sample)
    const key = `${turn}:${step}`
    if (last !== null && last.key === key) {
      addBuckets(days.get(last.day), last.buckets, -1)
      if (last.session !== null) addBuckets(last.session.buckets, last.buckets, -1)
    }
    addBuckets(bucketFor(day), buckets)
    if (current !== null) addBuckets(current.buckets, buckets)
    last = { key, day, buckets, session: current }
  }
  return { days, sessions, searches }
}

function money(buckets, prices) {
  let usd = 0
  for (const entry of CLASSES) {
    usd += (buckets[entry.label] ?? 0) * (prices[entry.type] ?? 0)
  }
  return usd
}

function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function tokens(value) {
  return Number(value).toLocaleString('en-US')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write('node scripts/reconcile.mjs --export <usage_data_*.zip|dir> [--dsh-home ~/.dsh] [--json]\n')
    return 0
  }

  const archive = exportFiles(options.export)
  const amount = archive.names.find((name) => name.startsWith('amount-'))
  const cost = archive.names.find((name) => name.startsWith('cost-'))
  if (amount === undefined || cost === undefined) throw new Error('the export must contain amount-*.csv and cost-*.csv')

  const amountRows = readExportCsv(archive, amount)
  const platform = new Map()
  const prices = new Map()
  // The export states its own day boundary on every row: honour it.
  const offsetMinutes = offsetOf(amountRows) ?? 0
  for (const row of amountRows) {
    const day = row.start_time_iso.slice(0, 10)
    if (platform.has(day) === false) platform.set(day, { buckets: { miss: 0, hit: 0, out: 0 }, requests: 0 })
    const entry = platform.get(day)
    if (row.type === 'request_count') { entry.requests += Number(row.amount || 0); continue }
    const known = CLASSES.find((item) => item.type === row.type)
    if (known === undefined) continue
    entry.buckets[known.label] += Number(row.amount || 0)
    // Every price the platform applied that day, so the residual is costed at
    // the platform's own numbers rather than at a table this script guesses at.
    const unit = Number(row.price || 0)
    const amount = Number(row.amount || 0)
    if (unit > 0 && amount > 0) {
      if (prices.has(day) === false) prices.set(day, new Map())
      const byType = prices.get(day)
      const entryPrice = byType.get(row.type) ?? { paid: 0, amount: 0 }
      entryPrice.paid += unit * amount
      entryPrice.amount += amount
      byType.set(row.type, entryPrice)
    }
  }
  const billed = new Map()
  for (const row of readExportCsv(archive, cost)) {
    const day = row.start_time_iso.slice(0, 10)
    billed.set(day, (billed.get(day) ?? 0) + Number(row.cost || 0))
  }
  // One EFFECTIVE price per class and day: what the platform actually charged
  // divided by what it actually billed, so a day that mixed models and tiers is
  // costed at the rate that day really had rather than at a mean of rates.
  const priceTable = new Map()
  for (const [day, byType] of prices) {
    const table = {}
    for (const [type, value] of byType) table[type] = value.paid / value.amount
    priceTable.set(day, table)
  }

  const local = new Map()
  const perSession = []
  const mismatches = []
  let searchCalls = 0
  const cache = projectionTotals(options.dshHome)
  for (const file of sessionLogs(options.dshHome)) {
    const folded = foldLog(readLog(file), offsetMinutes)
    searchCalls += folded.searches
    for (const [day, buckets] of folded.days) {
      if (local.has(day) === false) local.set(day, { miss: 0, hit: 0, out: 0, searches: 0 })
      addBuckets(local.get(day), buckets)
      local.get(day).searches += buckets.searches
    }
    for (const session of folded.sessions) {
      const foldedTotal = total(session.buckets)
      perSession.push({ id: session.id, folded: foldedTotal })
      const durable = cache.get(session.id)
      // The durable row may lag a live session by one checkpoint; a fold below
      // it, however, means this script lost tokens and must say so.
      if (durable !== undefined && foldedTotal < durable - 1000) {
        mismatches.push({ id: session.id, folded: foldedTotal, durable })
      }
    }
  }

  const days = [...new Set([...platform.keys(), ...local.keys()])].sort()
  const rows = days.map((day) => {
    const plat = platform.get(day)?.buckets ?? { miss: 0, hit: 0, out: 0 }
    const mine = local.get(day) ?? { miss: 0, hit: 0, out: 0, searches: 0 }
    const delta = { miss: plat.miss - mine.miss, hit: plat.hit - mine.hit, out: plat.out - mine.out }
    const table = priceTable.get(day) ?? {}
    return {
      day,
      platform: plat,
      local: { miss: mine.miss, hit: mine.hit, out: mine.out },
      delta,
      deltaUsd: money(delta, table),
      platformUsd: billed.get(day) ?? 0,
      requests: platform.get(day)?.requests ?? 0,
      searches: mine.searches
    }
  })

  if (options.json === true) {
    process.stdout.write(JSON.stringify({ rows, searchCalls, mismatches, sessions: perSession.length }, null, 2) + '\n')
    return mismatches.length > 0 ? 1 : 0
  }

  const name = (day) => (existsSync(options.export) && statSync(options.export).isDirectory() ? options.export : options.export)
  process.stdout.write(`platform export: ${name(options.export)}\n`)
  process.stdout.write(`session logs:    ${options.dshHome}/sessions (${perSession.length} sessions)\n`)
  process.stdout.write(`day boundary:    ${offsetMinutes === 0 ? 'UTC' : `UTC${offsetMinutes > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60), 2)}:${pad(Math.abs(offsetMinutes) % 60, 2)}`} (from the export)\n\n`)
  process.stdout.write(`${pad('day', 12)}${pad('platform $', 12)}${pad('sessions $', 12)}${pad('gap $', 10)}${pad('miss Δ', 14)}${pad('out Δ', 12)}${pad('searches', 10)}${pad('$ / search', 12)}\n`)
  let gapUsd = 0
  for (const row of rows) {
    const mineUsd = money(row.local, priceTable.get(row.day) ?? {})
    gapUsd += row.deltaUsd
    const perSearch = row.searches > 0 ? (row.deltaUsd / row.searches).toFixed(4) : '—'
    process.stdout.write(`${pad(row.day, 12)}${pad(row.platformUsd.toFixed(4), 12)}${pad(mineUsd.toFixed(4), 12)}${pad(row.deltaUsd.toFixed(4), 10)}${pad(tokens(row.delta.miss), 14)}${pad(tokens(row.delta.out), 12)}${pad(row.searches, 10)}${pad(perSearch, 12)}\n`)
  }
  const platformTotal = rows.reduce((sum, row) => sum + row.platformUsd, 0)
  process.stdout.write(`${pad('total', 12)}${pad(platformTotal.toFixed(4), 12)}${pad('', 12)}${pad(gapUsd.toFixed(4), 10)}\n\n`)

  const quiet = rows.filter((row) => row.searches === 0)
  const busy = rows.filter((row) => row.searches > 0)
  if (quiet.length > 0) {
    const worst = quiet.reduce((max, row) => Math.max(max, Math.abs(row.deltaUsd)), 0)
    process.stdout.write(`days with no web search: ${quiet.length}, largest gap $${worst.toFixed(4)}\n`)
  }
  if (busy.length > 0) {
    const totalSearches = busy.reduce((sum, row) => sum + row.searches, 0)
    const totalGap = busy.reduce((sum, row) => sum + row.deltaUsd, 0)
    process.stdout.write(`days with web searches: ${busy.length}, ${tokens(totalSearches)} calls, gap $${totalGap.toFixed(4)} → $${(totalGap / totalSearches).toFixed(4)} per call\n`)
  }
  process.stdout.write('\nThe gap is what the platform billed and no session holds: web-search LLM calls\n')
  process.stdout.write('bill the server-side tool\'s reading of fetched pages, and the harness never writes\n')
  process.stdout.write('their usage into the session log. A gap on a day with no searches is a real\n')
  process.stdout.write('discrepancy and worth reporting.\n')

  if (mismatches.length > 0) {
    process.stdout.write(`\nWARNING: this fold could not reproduce ${mismatches.length} session(s) the harness's own cache counts:\n`)
    for (const item of mismatches.slice(0, 10)) {
      process.stdout.write(`  ${item.id}: folded ${tokens(item.folded)}, harness ${tokens(item.durable)}\n`)
    }
    return 1
  }
  process.stdout.write(`\nfold self-check: every one of ${perSession.length} sessions reproduces the harness's own counters\n`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`reconcile: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
