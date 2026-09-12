/**
 * Per-turn token usage, folded from a session's own events.
 *
 * The session projection keeps one cumulative total and the last step, which is
 * enough for a session figure but says nothing about a single answer. The events
 * do: every request reports usage, once as an early sample on the streaming
 * chunk and once, finally, on the assistant message.
 *
 * The fold below mirrors the harness's own `tokenUsage` projection, because a
 * second opinion about what a token is would be worse than no number at all:
 * a repeated sample for the same turn replaces that turn's earlier value for the
 * same step instead of adding to it, which is safe under the session-log
 * invariant that a step's samples are adjacent.
 */
import { totalTokens } from './usage.js'

const ZERO = () => ({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** The four buckets, in the names a provider usage record uses. */
function bucketsFrom(usage) {
  return {
    uncachedInput: number(usage?.inputTokens),
    cacheRead: number(usage?.cacheReadTokens),
    cacheWrite: number(usage?.cacheWriteTokens),
    output: number(usage?.outputTokens)
  }
}

const sameBuckets = (left, right) => left.uncachedInput === right.uncachedInput
  && left.cacheRead === right.cacheRead
  && left.cacheWrite === right.cacheWrite
  && left.output === right.output

/** Total minus a replaced sample plus its successor. */
function replace(total, previous, next) {
  return {
    uncachedInput: total.uncachedInput - (previous?.uncachedInput ?? 0) + next.uncachedInput,
    cacheRead: total.cacheRead - (previous?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: total.cacheWrite - (previous?.cacheWrite ?? 0) + next.cacheWrite,
    output: total.output - (previous?.output ?? 0) + next.output
  }
}

/** The usage a chunk or a finalized message reports, if it reports any. */
function sampleOf(event) {
  if (event?.type === 'assistant/chunk' && event?.data?.chunk?.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.chunk.usage }
  }
  if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.usage }
  }
  return null
}

/**
 * Token usage per turn, oldest first.
 *
 * @param {Array<object>} events session events in log order
 * @param {{ limit?: number }} [options] how many of the newest turns to keep
 * @returns {Array<{ turn: number, tokens: number, buckets: object, model: { provider: string|null, model: string|null }|null }>}
 */
export function turnUsage(events, options = {}) {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50
  if (Array.isArray(events) === false) return []

  const turns = new Map()
  let current = null

  for (const event of events) {
    if (event?.type === 'request/header') {
      const config = event?.data?.header?.config
      if (config !== null && typeof config === 'object') {
        current = {
          provider: typeof config.provider === 'string' ? config.provider : null,
          model: typeof config.model === 'string' ? config.model : null
        }
      }
      continue
    }

    const sample = sampleOf(event)
    if (sample === null || typeof sample.turn !== 'number') continue

    const buckets = bucketsFrom(sample.usage)
    const entry = turns.get(sample.turn) ?? { turn: sample.turn, buckets: ZERO(), step: null, last: null, model: null }
    // Usage for one step is reported more than once; the later report is the
    // final one and replaces its own earlier value rather than adding to it.
    const previous = entry.step === sample.step ? entry.last : null
    if (previous !== null && sameBuckets(previous, buckets)) continue

    entry.buckets = replace(entry.buckets, previous, buckets)
    entry.step = sample.step
    entry.last = buckets
    if (entry.model === null) entry.model = current
    turns.set(sample.turn, entry)
  }

  return [...turns.values()]
    .sort((left, right) => left.turn - right.turn)
    .slice(-limit)
    .map((entry) => ({ turn: entry.turn, buckets: entry.buckets, tokens: totalTokens(entry.buckets), model: entry.model }))
}
