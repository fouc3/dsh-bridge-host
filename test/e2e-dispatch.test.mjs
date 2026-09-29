/**
 * End-to-end async dispatch test.
 *
 * Proves the whole loop with a real agent: dispatch returns immediately, the
 * job runs in the background, and its outcome is posted to a receiver.
 *
 * Opt-in, because it costs real model tokens:
 *
 *   DSH_E2E=1 node --test test/e2e-dispatch.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../bridge/src/server.mjs'
import { createDispatch } from '../bridge/src/dispatch.mjs'
import { loadConfig } from '../bridge/src/config.mjs'
import { Ledger } from '../bridge/src/ledger.mjs'

const ENABLED = process.env.DSH_E2E === '1'
const TOKEN = 'e2e-dispatch-token-0123456789'
const CWD = process.env.DSH_E2E_CWD || '/tmp'

/** Poll until `predicate()` holds or the budget runs out. */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** A receiver standing in for the plugin's listener. */
async function receiver() {
  const events = []
  let resolveFirst
  const first = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      events.push(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      // Resolve only after the response is flushed: the bridge marks the task
      // notified after the request resolves, so resolving any earlier would
      // race that bookkeeping.
      resolveFirst(parsed)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/event`,
    events,
    first,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Minimal line-oriented client. */
function client(port) {
  const socket = connect(port, '127.0.0.1')
  socket.setEncoding('utf8')
  const queue = []
  const waiters = []
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    }
  })
  return {
    ready: new Promise((resolve) => socket.on('connect', resolve)),
    next(timeoutMs = 300_000) {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
        waiters.push((m) => {
          clearTimeout(timer)
          resolve(m)
        })
      })
    },
    send: (v) => socket.write(`${JSON.stringify(v)}\n`),
    close: () => socket.destroy(),
  }
}

let bridge
let rx
let ledger
let cleanupDir

before(async () => {
  if (!ENABLED) return
  rx = await receiver()
  cleanupDir = await mkdtemp(join(tmpdir(), 'dsh-e2e-dispatch-'))
  ledger = await new Ledger({ path: join(cleanupDir, 'tasks.json') }).load()

  const config = loadConfig({
    ...process.env,
    DSH_BRIDGE_TOKEN: TOKEN,
    DSH_BRIDGE_HOST: '127.0.0.1',
    DSH_BRIDGE_PORT: '0',
    DSH_BRIDGE_CALLBACK_URL: rx.url,
  })
  const dispatch = createDispatch(config, { ledger, log: () => {} })
  bridge = await startBridge({ ...config, port: 0 }, dispatch, { log: () => {} })
})

after(async () => {
  if (bridge) await bridge.close()
  if (rx) await rx.close()
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
})

test('dispatch returns immediately, then reports the result', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)

  const startedAt = Date.now()
  c.send({
    id: 'd1',
    op: 'dispatch',
    args: { cwd: CWD, text: '只回答两个字：收到', streamId: 'chat-e2e' },
  })
  const accepted = await c.next(60_000)
  const elapsed = Date.now() - startedAt

  assert.equal(accepted.ok, true, `dispatch failed: ${JSON.stringify(accepted.error)}`)
  assert.match(accepted.value.taskId, /^[0-9a-f-]{36}$/)

  // The claim under test: we did not wait for the agent.
  assert.ok(elapsed < 30_000, `dispatch took ${elapsed}ms`)
  assert.equal(ledger.get(accepted.value.taskId).status, 'running')

  // The report arrives on its own.
  const event = await rx.first
  assert.equal(event.taskId, accepted.value.taskId)
  assert.equal(event.streamId, 'chat-e2e')
  assert.match(event.reply, /收到/, `unexpected reply: ${JSON.stringify(event.reply)}`)
  assert.equal(event.status, 'done', `unexpected status: ${event.status}`)

  // The bridge marks the task reported only after the HTTP call resolves, so
  // poll briefly rather than assuming that ordering.
  await waitFor(() => ledger.get(accepted.value.taskId).notified === true, 10_000)
  assert.equal(ledger.get(accepted.value.taskId).notified, true)

  c.close()
})

test('a finished task is answerable from the ledger', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)

  // Dispatch our own task rather than reusing whatever else is in the ledger:
  // these suites may share a state directory when run together.
  c.send({
    id: 'own',
    op: 'dispatch',
    args: { cwd: CWD, text: '只回答两个字：收到', streamId: 'chat-ledger' },
  })
  const accepted = await c.next(60_000)
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  const taskId = accepted.value.taskId

  await waitFor(() => ledger.get(taskId)?.status === 'done', 120_000)

  c.send({ id: 's1', op: 'task_status', args: { taskId } })
  const status = await c.next(30_000)
  assert.equal(status.ok, true, JSON.stringify(status.error))
  assert.equal(status.value.status, 'done')
  // The raw text is kept, so follow-ups need no new run.
  assert.match(status.value.reply, /收到/)

  c.send({ id: 's2', op: 'task_list', args: {} })
  const list = await c.next(30_000)
  assert.ok(list.value.tasks.some((t) => t.taskId === taskId))

  c.close()
})
