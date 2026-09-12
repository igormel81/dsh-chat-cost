/**
 * The four provider usage buckets, in one place.
 *
 * Two shapes reach this module: the raw provider field names that a session log
 * or a projection state carries (`uncachedInputTokens`, `cacheReadTokens`,
 * `cacheWriteTokens`, `outputTokens`) and the normalized names the plugin passes
 * around internally (`uncachedInput`, `cacheRead`, `cacheWrite`, `output`).
 * Reading tolerantly in one helper is what keeps a shape mismatch from silently
 * pricing zero — the failure mode this module exists to prevent.
 */

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Read one bucket, accepting either the raw or the normalized key. */
function pick(usage, raw, normalized) {
  if (usage === null || typeof usage !== 'object') return 0
  const value = usage[raw] !== undefined ? usage[raw] : usage[normalized]
  return number(value)
}

/** Normalize any accepted usage shape to the four buckets. */
export function readUsage(usage) {
  return {
    uncachedInput: pick(usage, 'uncachedInputTokens', 'uncachedInput'),
    cacheRead: pick(usage, 'cacheReadTokens', 'cacheRead'),
    cacheWrite: pick(usage, 'cacheWriteTokens', 'cacheWrite'),
    output: pick(usage, 'outputTokens', 'output')
  }
}

export function totalTokens(buckets) {
  return buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output
}
