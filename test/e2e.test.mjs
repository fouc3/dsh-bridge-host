/**
 * End-to-end test against the real agent.
 *
 * Unlike the other suites this spawns `dsh --profile acp` through acpx, so it
 * needs the agent installed and it costs real model tokens. It is opt-in:
 *
 *   DSH_E2E=1 node --test test/e2e.test.mjs
 *
 * The bridge listens on loopback with an ephemeral port; nothing is exposed.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../bridge/src/server.mjs'
import { createDispatch } from '../bridge/src/dispatch.mjs'
import { loadConfig } from '../bridge/src/config.mjs'

const ENABLED = process.env.DSH_E2E === '1'
const TOKEN = 'e2e-token-0123456789abcdef'

/** Working directory the agent sessions are scoped to. */
const CWD = process.env.DSH_E2E_CWD || '/tmp'

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
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const message = JSON.parse(line)
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
        const timer = setTimeout(() => reject(new Error('timed out waiting for a bridge line')), timeoutMs)
        waiters.push((message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    close: () => socket.destroy(),
  }
}

let bridge
let config
let stateDir

before(async () => {
  if (!ENABLED) return
  // Keep test state out of the operator's real ledger directory.
  stateDir = await mkdtemp(join(tmpdir(), 'dsh-e2e-state-'))
  config = loadConfig({
    ...process.env,
    DSH_BRIDGE_TOKEN: TOKEN,
    DSH_BRIDGE_HOST: '127.0.0.1',
    DSH_BRIDGE_PORT: '0',
    DSH_BRIDGE_LEDGER: join(stateDir, 'tasks.json'),
  })
  const dispatch = createDispatch(config)
  bridge = await startBridge({ ...config, port: 0 }, dispatch, { log: () => {} })
})

after(async () => {
  if (bridge) await bridge.close()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
})

test('rejects a bad token even against the real agent', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: 'definitely-not-the-token' })
  const reply = await c.next(10_000)
  assert.equal(reply.ok, false)
  assert.equal(reply.error.code, 'unauthorized')
  c.close()
})

test('creates a session, prompts it, and receives the reply', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  assert.deepEqual(await c.next(10_000), { ok: true })

  // 1. Create a session in CWD.
  c.send({ id: 'new', op: 'sessions_new', args: { cwd: CWD } })
  const created = await c.next(120_000)
  assert.equal(created.ok, true, `sessions_new failed: ${JSON.stringify(created.error)}`)
  assert.match(created.value.sessionId, /^[0-9a-f-]{36}$/)

  // 2. Ask the agent something with an unambiguous answer.
  c.send({ id: 'ask', op: 'prompt', args: { cwd: CWD, text: '只回答四个字：连接成功' } })
  const answered = await c.next(300_000)
  assert.equal(answered.ok, true, `prompt failed: ${JSON.stringify(answered.error)}`)
  assert.match(answered.value.reply, /连接成功/, `unexpected reply: ${JSON.stringify(answered.value.reply)}`)
  assert.equal(answered.value.stopReason, 'end_turn')

  // 3. A second prompt must resume the same conversation, not start a new one.
  c.send({ id: 'again', op: 'prompt', args: { cwd: CWD, text: '再回答两个字：收到' } })
  const second = await c.next(300_000)
  assert.equal(second.ok, true, `second prompt failed: ${JSON.stringify(second.error)}`)
  assert.match(second.value.reply, /收到/, `unexpected second reply: ${JSON.stringify(second.value.reply)}`)

  c.close()
})

test('lists sessions it just created', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)
  c.send({ id: 'list', op: 'sessions_list', args: { cwd: CWD } })
  const listed = await c.next(60_000)
  assert.equal(listed.ok, true, `sessions_list failed: ${JSON.stringify(listed.error)}`)
  assert.ok(Array.isArray(listed.value.sessions))
  assert.ok(listed.value.sessions.length >= 1, 'expected at least one saved session')
  c.close()
})
