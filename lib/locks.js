/**
 * One-at-a-time execution per key.
 *
 * Two things in this plugin mutate durable files after reading them: the cost
 * log (a flush decides what to append) and the plan document (a tool writes what
 * it just read). Overlapping runs would each decide from stale state, so every
 * such sequence goes through this queue.
 */
export function createLocks() {
  const chains = new Map()

  /**
   * Run `work` after every previously queued run for `key` has settled.
   * A failure in one run never blocks the next one.
   * @param {string} key
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   * @template T
   */
  async function run(key, work) {
    const previous = chains.get(key) ?? Promise.resolve()
    let open = () => {}
    const gate = new Promise((resolve) => { open = resolve })
    const queued = previous.then(() => gate, () => gate)
    chains.set(key, queued)
    await previous.catch(() => {})
    try {
      return await work()
    } finally {
      open()
      if (chains.get(key) === queued) chains.delete(key)
    }
  }

  /** Keys with a queued or running job right now. */
  function busy() {
    return [...chains.keys()]
  }

  return { run, busy }
}
