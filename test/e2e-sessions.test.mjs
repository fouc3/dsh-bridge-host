/**
 * Named-session end-to-end test.
 *
 * Proves the point of naming: two names are two separate conversations that
 * remember different things, while reusing one name continues that same
 * conversation across separate dispatches.
 *
 * Opt-in, because it costs real model tokens:
 *
 *   DSH_E2E=1 node --test test/e2e-sessions.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../bridge/src/server.mjs'
import { createDispatch } from '../bridge/src/dispatch.mjs'
import { loadConfig } from '../bridge/src/config.mjs'
import { Ledger } from '../bridge/src/ledger.mjs'

const ENABLED = process.env.DSH_E2E === '1'
const TOKEN = 'e2e-sessions-token-0123456789'

let bridge
let ledger
let cwd
let stateDir
let rx

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

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** Dispatch and wait for the report; returns the stored task. */
async function runToCompletion(c, { task, sessionName, streamId = 'chat' }) {
  c.send({
    id: `d-${Math.random().toString(16).slice(2)}`,
    op: 'dispatch',
    args: { cwd, text: task, streamId, name: sessionName },
  })
  const accepted = await c.next(60_000)
  assert.equal(accepted.ok, true, `dispatch failed: ${JSON.stringify(accepted.error)}`)
  const taskId = accepted.value.taskId
  const done = await waitFor(() => ledger.get(taskId)?.status !== 'running', 240_000)
  assert.ok(done, `task ${taskId} never settled`)
  return ledger.get(taskId)
}

before(async () => {
  if (!ENABLED) return
  cwd = await mkdtemp(join(tmpdir(), 'dsh-e2e-sessions-'))
  stateDir = await mkdtemp(join(tmpdir(), 'dsh-e2e-sessions-state-'))
  ledger = await new Ledger({ path: join(stateDir, 'tasks.json') }).load()

  // Swallow the callbacks; this suite reads outcomes from the ledger.
  rx = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => rx.listen(0, '127.0.0.1', resolve))

  const config = loadConfig({
    ...process.env,
    DSH_BRIDGE_TOKEN: TOKEN,
    DSH_BRIDGE_HOST: '127.0.0.1',
    DSH_BRIDGE_PORT: '0',
    DSH_BRIDGE_LEDGER: join(stateDir, 'tasks.json'),
    DSH_BRIDGE_CALLBACK_URL: `http://127.0.0.1:${rx.address().port}/event`,
  })
  const dispatch = createDispatch(config, { ledger, log: () => {} })
  bridge = await startBridge({ ...config, port: 0 }, dispatch, { log: () => {} })
})

after(async () => {
  if (bridge) await bridge.close()
  if (rx) await new Promise((resolve) => rx.close(resolve))
  if (cwd) await rm(cwd, { recursive: true, force: true })
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
})

test('a named session is created on first use', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)

  const task = await runToCompletion(c, { task: '只回答两个字：收到', sessionName: 'alpha' })
  assert.equal(task.status, 'done', `unexpected status: ${task.status} / ${task.reply}`)
  assert.equal(task.meta.sessionName, 'alpha')
  // The bridge records which agent session the task actually ran in.
  assert.match(String(task.sessionId), /[0-9a-f-]{36}/)

  c.close()
})

test('the same name continues the same conversation', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)

  await runToCompletion(c, {
    task: '请记住暗号：紫色河马7788。只回复"记住了"。',
    sessionName: 'alpha',
  })
  const recalled = await runToCompletion(c, {
    task: '刚才让你记的暗号是什么？只回答暗号本身。',
    sessionName: 'alpha',
  })
  assert.match(recalled.reply, /紫色河马7788/, `the second turn lost the context: ${recalled.reply}`)

  c.close()
})

test('a different name is a different conversation', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)

  const other = await runToCompletion(c, {
    task: '暗号是什么？如果你不知道就只回答"不知道"。',
    sessionName: 'beta',
  })
  // Isolation is the whole point of naming: beta must not see alpha's memory.
  assert.doesNotMatch(other.reply, /紫色河马7788/, `beta leaked alpha's context: ${other.reply}`)

  c.close()
})

test('workspaces groups sessions by directory and exposes their names', { skip: !ENABLED }, async () => {
  const c = client(bridge.port)
  await c.ready
  c.send({ token: TOKEN })
  await c.next(10_000)

  c.send({ id: 'w', op: 'workspaces', args: { cwd } })
  const reply = await c.next(60_000)
  assert.equal(reply.ok, true, JSON.stringify(reply.error))

  const mine = reply.value.workspaces.find((w) => w.cwd === cwd)
  assert.ok(mine, `expected a workspace entry for ${cwd}, got ${JSON.stringify(reply.value.workspaces.map((w) => w.cwd))}`)

  const names = mine.sessions.map((s) => s.name).filter(Boolean)
  assert.ok(names.includes('alpha'), `expected alpha among ${JSON.stringify(names)}`)
  assert.ok(names.includes('beta'), `expected beta among ${JSON.stringify(names)}`)

  c.close()
})
