/**
 * Cost-log records and aggregation.
 *
 * One JSONL line per session per flush: a cumulative snapshot plus the delta
 * since the previous flush, so the file is both a time series and a set of
 * totals you can sum. Records carry the tree position (root, parent, depth,
 * kind), so chats, subagents and whole sessions can be separated afterwards.
 */

import { readUsage, totalTokens } from './usage.js'

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

/** Keep the project's git status clean: make sure .dsh-cost/ is ignored. */
export async function ensureGitignore(projectDir, options = {}) {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
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
