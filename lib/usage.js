/**
 * The four provider usage buckets, in one place.
 *
 * Buckets arrive in three wrappers and two spellings, and both axes have bitten:
 *
 *  - the raw provider names a session log or projection carries
 *    (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
 *    `outputTokens`) or the normalized names the plugin passes around
 *    internally (`uncachedInput`, `cacheRead`, `cacheWrite`, `output`);
 *  - flat, or wrapped: the `tokenUsage` session projection is
 *    `{ totals, last: { turn, step, buckets } | null }`, a per-step value is
 *    `{ buckets }`, and the projection cache stores `{ ver, seq, val }`.
 *
 * Reading tolerantly in one helper is what keeps a shape mismatch from silently
 * pricing zero — the failure mode this module exists to prevent, and one it has
 * already caused once by reading through the `totals` wrapper.
 */

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The object that actually carries the buckets.
 *
 * `totals` wins over `buckets` when both are present: a projection state holds
 * the session total in `totals` and the last step in `last.buckets`, and the
 * total is the one that is cumulative.
 */
function unwrap(usage) {
  let current = usage
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== 'object') return null
    if (current.totals !== null && typeof current.totals === 'object') { current = current.totals; continue }
    if (current.buckets !== null && typeof current.buckets === 'object') { current = current.buckets; continue }
    if (current.val !== null && typeof current.val === 'object') { current = current.val; continue }
    return current
  }
  return current
}

/** Read one bucket, accepting either the raw or the normalized key. */
function pick(usage, raw, normalized) {
  if (usage === null || typeof usage !== 'object') return 0
  const value = usage[raw] !== undefined ? usage[raw] : usage[normalized]
  return number(value)
}

/** Normalize any accepted usage shape to the four buckets. */
export function readUsage(usage) {
  const source = unwrap(usage)
  return {
    uncachedInput: pick(source, 'uncachedInputTokens', 'uncachedInput'),
    cacheRead: pick(source, 'cacheReadTokens', 'cacheRead'),
    cacheWrite: pick(source, 'cacheWriteTokens', 'cacheWrite'),
    output: pick(source, 'outputTokens', 'output')
  }
}

export function totalTokens(buckets) {
  return buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output
}
