import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocks } from '../lib/locks.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('work for one key runs one at a time, in submission order', async () => {
  const locks = createLocks()
  const order = []
  const work = (name) => async () => {
    order.push(`start:${name}`)
    await tick()
    order.push(`end:${name}`)
    return name
  }
  const results = await Promise.all([
    locks.run('a', work('1')),
    locks.run('a', work('2')),
    locks.run('a', work('3'))
  ])
  assert.deepEqual(results, ['1', '2', '3'])
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'])
})

test('different keys do not wait for each other', async () => {
  const locks = createLocks()
  const order = []
  await Promise.all([
    locks.run('a', async () => { order.push('a:start'); await tick(); order.push('a:end') }),
    locks.run('b', async () => { order.push('b:start'); await tick(); order.push('b:end') })
  ])
  assert.deepEqual(order.slice(0, 2).sort(), ['a:start', 'b:start'], 'both start before either ends')
})

test('a failing run does not block the next one, and keys are released', async () => {
  const locks = createLocks()
  await assert.rejects(() => locks.run('a', async () => { throw new Error('boom') }), /boom/)
  assert.equal(await locks.run('a', async () => 'after'), 'after')
  assert.deepEqual(locks.busy(), [], 'a finished key leaves nothing behind')
})

test('a rejected queued run still releases its key', async () => {
  const locks = createLocks()
  const first = locks.run('k', async () => { throw new Error('first') })
  const second = locks.run('k', async () => 'second')
  await assert.rejects(() => first, /first/)
  assert.equal(await second, 'second')
  assert.deepEqual(locks.busy(), [])
})
