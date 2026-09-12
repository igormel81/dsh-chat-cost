/**
 * Per-turn usage folding: the shape of the events, and what a repeated sample
 * means.
 *
 * A session projection answers "what has this chat cost"; an answer in the
 * transcript needs "what did this turn cost", and the only place that lives is
 * the event log. These cases pin the harness's own rule — the last sample for a
 * turn and step replaces the earlier ones, it does not add to them — because a
 * fold that got it wrong would quietly double the price of every turn that
 * streamed before it finished.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnUsage } from '../lib/turns.js'

const header = (provider, model) => ({ type: 'request/header', data: { header: { config: { provider, model } } } })
const chunk = (turn, step, usage) => ({ type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } })
const message = (turn, step, usage) => ({ type: 'assistant/message', data: { turn, step, usage } })

test('a streamed sample is replaced by the final one for the same step', () => {
  const turns = turnUsage([
    header('deepseek-official', 'deepseek-flash'),
    chunk(1, 1, { inputTokens: 100, outputTokens: 10 }),
    message(1, 1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500 })
  ])
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].buckets, { uncachedInput: 100, cacheRead: 500, cacheWrite: 0, output: 20 })
  assert.equal(turns[0].tokens, 620, 'the early sample is not counted twice')
})

test('separate steps of one turn add up', () => {
  const turns = turnUsage([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 100, outputTokens: 10 }),
    message(1, 2, { inputTokens: 200, outputTokens: 20 }),
    message(1, 3, { inputTokens: 300, outputTokens: 30 })
  ])
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].buckets, { uncachedInput: 600, cacheRead: 0, cacheWrite: 0, output: 60 })
})

test('turns are kept apart and carry the model that was in effect', () => {
  const turns = turnUsage([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 100, outputTokens: 10 }),
    header('moonshot', 'kimi-k3'),
    message(2, 1, { inputTokens: 50, outputTokens: 5 })
  ])
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2])
  assert.equal(turns[0].model.model, 'deepseek-flash')
  assert.equal(turns[1].model.model, 'kimi-k3', 'a model switch mid-session is attributed to the turn that used it')
})

test('cache buckets survive, and an empty log yields nothing', () => {
  const turns = turnUsage([
    header('anthropic', 'claude-haiku-4'),
    message(3, 1, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4000, cacheWriteTokens: 700 })
  ])
  assert.deepEqual(turns[0].buckets, { uncachedInput: 10, cacheRead: 4000, cacheWrite: 700, output: 2 })
  assert.deepEqual(turnUsage([]), [])
  assert.deepEqual(turnUsage(null), [])
  assert.deepEqual(turnUsage([{ type: 'turn/end', data: { turn: 1 } }]), [], 'events without usage say nothing')
})

test('the newest turns are kept when a session has more than the limit', () => {
  const events = [header('deepseek-official', 'deepseek-flash')]
  for (let turn = 1; turn <= 9; turn += 1) events.push(message(turn, 1, { inputTokens: turn, outputTokens: 0 }))
  const turns = turnUsage(events, { limit: 3 })
  assert.deepEqual(turns.map((turn) => turn.turn), [7, 8, 9])
})
