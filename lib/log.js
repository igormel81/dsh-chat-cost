/**
 * Cost-log records and aggregation.
 *
 * One JSONL line per session per flush: a cumulative snapshot plus the delta
 * since the previous flush, so the file is both a time series and a set of
 * totals you can sum. Records carry the tree position (root, parent, depth,
 * kind), so chats, subagents and whole sessions can be separated afterwards.
 */

import { readUsage, totalTokens } from './usage.js'

/** Bucket-wise difference, clamped at zero: usage folds are monotone. */
export function subtractUsage(cumulative, recorded) {
  const a = readUsage(cumulative)
  const b = readUsage(recorded)
  return {
    uncachedInput: Math.max(0, a.uncachedInput - b.uncachedInput),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    output: Math.max(0, a.output - b.output)
  }
}

/**
 * Latest recorded figure per session from the ledger, in file order.
 *
 * This is the base every live figure is built on: the log already priced each
 * interval at the tariff in effect when it arrived, so re-pricing a session's
 * whole history at today's tariff would be wrong by up to the peak multiplier.
 * @returns {Map<string, { tokens: object, cumulativeUsd: number }>}
 */
export function ledgerBase(costs) {
  const base = new Map()
  for (const record of costs) {
    if (typeof record?.sessionId !== 'string') continue
    const tokens = readUsage(record.tokens)
    const cumulativeUsd = typeof record.cumulativeUsd === 'number' ? record.cumulativeUsd : 0
    // The tariff travels with the interval it priced: a session with nothing new
    // to charge is described by the record, not by the clock reading the file.
    const tier = typeof record.tier === 'string' ? record.tier : null
    const pricingSource = typeof record.pricingSource === 'string' ? record.pricingSource : null
    base.set(record.sessionId, { tokens, cumulativeUsd, tier, pricingSource })
  }
  return base
}

/** Directory created inside a session's project folder. */
export const LOG_DIR = '.dsh-cost'
/** Append-only log file inside LOG_DIR. */
export const LOG_FILE = 'cost.jsonl'

/** Normalize provider usage buckets; missing fields count as zero. */
export function tokens(usage) {
  return readUsage(usage)
}

export { totalTokens }

/**
 * Build one log record.
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string|null} input.parentSessionId
 * @param {string} input.rootSessionId
 * @param {number} input.depth
 * @param {'chat'|'subagent'} input.kind
 * @param {string} [input.title]
 * @param {string} [input.workspace]
 * @param {string} [input.provider]
 * @param {string} [input.model]
 * @param {'official'|'catalog'|'none'} [input.pricingSource]
 * @param {number|string} [input.tier]
 * @param {object} input.usage  provider usage buckets
 * @param {number|null} input.cumulativeUsd
 * @param {number|null} input.deltaUsd
 * @param {string} [input.plugin] plugin version stamp
 */
export function costRecord(input) {
  const buckets = tokens(input.usage)
  const deltaBuckets = input.deltaTokens === undefined ? null : tokens(input.deltaTokens)
  return {
    ts: input.ts ?? new Date().toISOString(),
    plugin: input.plugin ?? 'dsh-chat-cost',
    rootSessionId: input.rootSessionId ?? input.sessionId,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId ?? null,
    depth: typeof input.depth === 'number' ? input.depth : 0,
    kind: input.kind ?? (input.parentSessionId ? 'subagent' : 'chat'),
    title: input.title ?? null,
    workspace: input.workspace ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    pricingSource: input.pricingSource ?? 'none',
    tier: input.tier ?? null,
    tokens: buckets,
    totalTokens: totalTokens(buckets),
    ...(deltaBuckets === null ? {} : { deltaTokens: deltaBuckets, deltaTotalTokens: totalTokens(deltaBuckets) }),
    cumulativeUsd: typeof input.cumulativeUsd === 'number' ? input.cumulativeUsd : null,
    deltaUsd: typeof input.deltaUsd === 'number' ? input.deltaUsd : null
  }
}

/**
 * Aggregate priced sessions into the shape the client renders.
 * @param {Array<{sessionId: string, parentSessionId: string|null, depth: number, title?: string,
 *   provider?: string, model?: string, usage: object, usd: number|null, pricingSource?: string}>} sessions
 */
export function summarizeTree(sessions) {
  const list = sessions.map((entry) => {
    const buckets = tokens(entry.usage)
    return {
      sessionId: entry.sessionId,
      parentSessionId: entry.parentSessionId ?? null,
      depth: typeof entry.depth === 'number' ? entry.depth : 0,
      kind: entry.parentSessionId ? 'subagent' : 'chat',
      title: entry.title ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      pricingSource: entry.pricingSource ?? 'none',
      tier: entry.tier ?? null,
      live: entry.live !== false,
      tokens: buckets,
      totalTokens: totalTokens(buckets),
      usd: typeof entry.usd === 'number' ? entry.usd : null
    }
  })

  const priced = list.filter((entry) => entry.usd !== null)
  const sum = (items) => items.reduce((acc, entry) => acc + entry.usd, 0)
  const unpricedSessions = list.filter((entry) => entry.usd === null).map((entry) => entry.sessionId)

  return {
    sessions: list,
    self: list.find((entry) => entry.parentSessionId === null) ?? null,
    subagents: list.filter((entry) => entry.parentSessionId !== null),
    totals: {
      usd: priced.length > 0 ? sum(priced) : null,
      chatUsd: sum(priced.filter((entry) => entry.parentSessionId === null)) || null,
      subagentUsd: sum(priced.filter((entry) => entry.parentSessionId !== null)) || null,
      sessions: list.length,
      subagentCount: list.filter((entry) => entry.parentSessionId !== null).length,
      unpricedSessions
    }
  }
}

/**
 * Append records to <projectDir>/.dsh-cost/cost.jsonl, creating the directory
 * on first write. One JSON object per line, so the file stays greppable and
 * `tail -f`-able. Failures are the caller's to report: a plugin that cannot
 * write its log must not break the conversation.
 *
 * @param {string} projectDir session workspace root
 * @param {Array<object>} records records built by {@link costRecord}
 * @param {{ dir?: string }} [options] directory name override
 * @returns {Promise<string>} the log file path
 */
export async function appendCostLog(projectDir, records, options = {}) {
  const { mkdir, appendFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  if (typeof projectDir !== 'string' || projectDir === '') throw new Error('appendCostLog: projectDir is required')
  if (!Array.isArray(records) || records.length === 0) throw new Error('appendCostLog: no records')
  const dir = join(projectDir, typeof options.dir === 'string' && options.dir !== '' ? options.dir : LOG_DIR)
  await mkdir(dir, { recursive: true })
  const file = join(dir, LOG_FILE)
  const payload = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await appendFile(file, payload, 'utf8')
  return file
}

/**
 * True when the directory is the root of a git work tree (`.git` is a directory
 * in a normal clone and a file in a worktree or submodule).
 */
export async function isGitWorkTree(projectDir) {
  const { stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    await stat(join(projectDir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Keep the project's git status clean: make sure the log directory is ignored.
 * Returns null for a directory that is not a git work tree — dropping a
 * `.gitignore` into a plain folder would be clutter nobody asked for.
 */
export async function ensureGitignore(projectDir, options = {}) {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  if (await isGitWorkTree(projectDir) === false) return null
  const file = join(projectDir, '.gitignore')
  const name = typeof options.dir === 'string' && options.dir !== '' ? options.dir : LOG_DIR
  const entry = `${name}/`
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split('\n').map((line) => line.trim())
  if (lines.includes(entry) || lines.includes(name)) return file
  const prefix = text === '' || text.endsWith('\n') ? text : text + '\n'
  await writeFile(file, prefix + entry + '\n', 'utf8')
  return file
}

/** Bucket label for spend that happened before any mark opened a unit. */
export const UNLABELED_LABEL = '_unlabeled'

/** Record type of a unit boundary written by the cost_mark tool. */
export const MARK_TYPE = 'mark'

/**
 * One unit boundary: spend after this point belongs to `label` until the next
 * mark. Marks live in the same JSONL file as the cost records, so the ledger and
 * the plan share one timeline and one file to inspect.
 */
export function markRecord(input) {
  return {
    type: MARK_TYPE,
    ts: input.ts ?? new Date().toISOString(),
    plugin: input.plugin ?? 'dsh-chat-cost',
    rootSessionId: input.rootSessionId ?? input.sessionId ?? null,
    sessionId: input.sessionId ?? null,
    label: input.label,
    title: input.title ?? null,
    note: input.note ?? null
  }
}

/**
 * Split a log text into ordered entries plus the derived cost and mark lists.
 *
 * `entries` preserves FILE order, which is the only reliable ordering: a burst
 * of records can share one millisecond, so timestamps cannot decide whether a
 * mark opened its bucket before or after a record written in the same tick.
 */
export function parseLog(text) {
  const entries = []
  const costs = []
  const marks = []
  const broken = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let value = null
    try {
      value = JSON.parse(trimmed)
    } catch {
      broken.push(trimmed.slice(0, 120))
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (value.type === MARK_TYPE) {
      marks.push(value)
      entries.push({ kind: 'mark', value })
    } else if (typeof value.sessionId === 'string') {
      costs.push(value)
      entries.push({ kind: 'cost', value })
    }
  }
  return { entries, costs, marks, broken }
}

/**
 * Attribute spend to plan units: every cost delta lands in the bucket of the
 * mark that precedes it in the log, per session.
 *
 * Order comes from the log itself (see {@link parseLog}), never from timestamps.
 * Accepts either the ordered `entries` from `parseLog` or the legacy
 * `(costs, marks)` pair, which is re-merged in array order.
 * @returns {Array<{ label: string, usd: number, records: number, sessions: string[], tokens: object, firstTs: string|null, lastTs: string|null }>}
 */
export function actualsByLabel(entriesOrCosts, legacyMarks = null) {
  // Ordered entries are `{ kind: 'cost'|'mark', value }` envelopes. A cost
  // record also carries a `kind` field ('chat'|'subagent'), so the envelope must
  // be recognised by both its discriminant and its payload slot.
  const isEnvelope = (item) => item !== null && typeof item === 'object'
    && (item.kind === 'cost' || item.kind === 'mark')
    && Object.prototype.hasOwnProperty.call(item, 'value')
  const entries = Array.isArray(entriesOrCosts) && entriesOrCosts.length > 0 && isEnvelope(entriesOrCosts[0])
    ? entriesOrCosts
    : [
        ...(Array.isArray(entriesOrCosts) ? entriesOrCosts : []).map((value) => ({ kind: 'cost', value })),
        ...(Array.isArray(legacyMarks) ? legacyMarks : []).map((value) => ({ kind: 'mark', value }))
      ]

  const sessions = new Set()
  for (const entry of entries) {
    if (entry.kind === 'cost' && typeof entry.value?.sessionId === 'string') sessions.add(entry.value.sessionId)
  }

  const buckets = new Map()
  for (const sessionId of sessions) {
    let label = UNLABELED_LABEL
    for (const entry of entries) {
      const value = entry.value
      if (value?.sessionId !== sessionId) continue
      if (entry.kind === 'mark') {
        label = typeof value.label === 'string' && value.label !== '' ? value.label : label
        continue
      }
      const record = value
      if (buckets.has(label) === false) {
        buckets.set(label, { label, usd: 0, records: 0, sessions: new Set(), tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, firstTs: null, lastTs: null })
      }
      const bucket = buckets.get(label)
      const delta = typeof record.deltaUsd === 'number' ? record.deltaUsd : 0
      bucket.usd += delta
      bucket.records += 1
      bucket.sessions.add(sessionId)
      // Records carry both the cumulative snapshot and the interval's own
      // buckets; summing snapshots would inflate the totals.
      const contribution = record.deltaTokens ?? record.tokens
      for (const key of Object.keys(bucket.tokens)) bucket.tokens[key] += Number(contribution?.[key] ?? 0)
      if (bucket.firstTs === null || String(record.ts) < bucket.firstTs) bucket.firstTs = record.ts
      if (bucket.lastTs === null || String(record.ts) > bucket.lastTs) bucket.lastTs = record.ts
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, sessions: [...bucket.sessions] }))
    .sort((a, b) => b.usd - a.usd)
}

/** Dated spend samples for the burn-rate calculation. */
export function spendSamples(costs, { sessionId = null } = {}) {
  return costs
    .filter((record) => sessionId === null || record.sessionId === sessionId)
    .map((record) => ({ ts: record.ts, usd: typeof record.deltaUsd === 'number' ? record.deltaUsd : 0 }))
}

/** Append mark records to the same log the cost records use. */
export async function appendMarks(projectDir, marks, options = {}) {
  return appendCostLog(projectDir, marks, options)
}

/**
 * Read a project's cost log, tolerating a missing or partly broken file.
 *
 * `tailBytes` bounds the read: a long-lived project's ledger grows without
 * limit, and the widget polls this route, so the summary reads only the tail
 * (the truncated flag says so) while the tools read the whole file.
 *
 * `cache` is a Map keyed by path; an entry is reused while the file's size and
 * mtime are unchanged, which is what keeps a 30-second poll from re-parsing a
 * ledger that did not move.
 */
export async function readLedger(projectDir, options = {}) {
  const { open, readFile, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const name = typeof options.dir === 'string' && options.dir !== '' ? options.dir : LOG_DIR
  const path = join(projectDir, name, LOG_FILE)
  const tailBytes = typeof options.tailBytes === 'number' && Number.isFinite(options.tailBytes) && options.tailBytes > 0 ? options.tailBytes : null

  let info = null
  try {
    info = await stat(path)
  } catch {
    const empty = { entries: [], costs: [], marks: [], broken: [], path: null, truncated: false, skippedBytes: 0 }
    options.cache?.set(path, { key: 'missing', value: empty })
    return empty
  }

  const key = `${info.size}:${info.mtimeMs}:${tailBytes ?? 'all'}`
  const cached = options.cache?.get(path)
  if (cached !== undefined && cached.key === key) return cached.value

  let text = ''
  let truncated = false
  let skippedBytes = 0
  try {
    if (tailBytes !== null && info.size > tailBytes) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(tailBytes)
        const { bytesRead } = await handle.read(buffer, 0, tailBytes, info.size - tailBytes)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
      // The first line of a tail is usually a fragment; drop it.
      const firstBreak = text.indexOf('\n')
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
      truncated = true
      skippedBytes = Math.max(0, info.size - tailBytes)
    } else {
      text = await readFile(path, 'utf8')
    }
  } catch {
    const empty = { entries: [], costs: [], marks: [], broken: [], path, truncated: false, skippedBytes: 0 }
    return empty
  }

  const parsed = parseLog(text)
  const value = { ...parsed, path, truncated, skippedBytes }
  options.cache?.set(path, { key, value })
  return value
}
