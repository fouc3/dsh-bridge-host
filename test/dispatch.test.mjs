/**
 * Asynchronous dispatch tests.
 *
 * The two claims that matter here:
 *   1. `dispatch` returns before the agent finishes.
 *   2. the outcome is reported back exactly once, with retries on failure.
 *
 * Both are driven with a stub prompt runner, so no agent or model is involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, TaskStatus } from '../bridge/src/ledger.mjs'
import { deliverCallback, buildCallbackPayload } from '../bridge/src/callback.mjs'

const TOKEN = 'dispatch-test-token-0123456789'

/** Minimal dispatch harness with an injectable prompt runner. */
async function harness({ promptImpl, callbackUrl = '' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dispatch-'))
  const ledger = await new Ledger({ path: join(dir, 'tasks.json') }).load()
  const calls = []

  // Re-implement the async path over the real ledger so the test exercises the
  // same state transitions the bridge uses.
  async function dispatch({ streamId, cwd = '/tmp', prompt }) {
    const task = await ledger.create({ streamId, cwd, prompt })
    const work = (async () => {
      const result = await promptImpl({ cwd, prompt })
      await ledger.finish(task.taskId, result)
      if (callbackUrl) {
        const res = await deliverCallback({
          url: callbackUrl,
          token: TOKEN,
          payload: buildCallbackPayload(ledger.get(task.taskId)),
          baseDelayMs: 5,
        })
        calls.push({ taskId: task.taskId, delivered: res.ok })
        if (res.ok) await ledger.markNotified(task.taskId)
      }
    })()
    return { taskId: task.taskId, work }
  }

  return {
    ledger,
    dispatch,
    calls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test('dispatch returns before the work finishes', async () => {
  let released
  const gate = new Promise((resolve) => {
    released = resolve
  })
  const h = await harness({
    promptImpl: async () => {
      await gate
      return { status: TaskStatus.DONE, reply: 'late answer', stopReason: 'end_turn' }
    },
  })
  try {
    const startedAt = Date.now()
    const { taskId } = await h.dispatch({ streamId: 'chat-1', prompt: 'long job' })
    const elapsed = Date.now() - startedAt

    // The whole point: we get a handle almost immediately.
    assert.ok(elapsed < 500, `dispatch took ${elapsed}ms; it must not await the agent`)
    assert.equal(h.ledger.get(taskId).status, TaskStatus.RUNNING)
    assert.equal(h.ledger.get(taskId).reply, null)

    released()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.ledger.get(taskId).status, TaskStatus.DONE)
    assert.equal(h.ledger.get(taskId).reply, 'late answer')
  } finally {
    await h.cleanup()
  }
})

test('the stored reply is available for follow-up questions', async () => {
  const h = await harness({
    promptImpl: async () => ({
      status: TaskStatus.DONE,
      reply: '详细结果：一共 3 个文件受影响，分别是 a、b、c。',
      stopReason: 'end_turn',
    }),
  })
  try {
    const { taskId, work } = await h.dispatch({ streamId: 'chat-1', prompt: 'check files' })
    await work
    const stored = h.ledger.get(taskId)
    // The full text is retained, not a summary.
    assert.match(stored.reply, /a、b、c/)
  } finally {
    await h.cleanup()
  }
})

test('a reply that asks something is stored as done, with the full text kept', async () => {
  const h = await harness({
    promptImpl: async () => ({
      status: TaskStatus.DONE,
      reply: '有两个候选目录，你要用哪个？',
      stopReason: 'end_turn',
    }),
  })
  try {
    const { taskId, work } = await h.dispatch({ streamId: 'chat-1', prompt: 'find dirs' })
    await work
    const task = h.ledger.get(taskId)
    assert.equal(task.status, TaskStatus.DONE)
    // The question text reaches the chat verbatim; it decides what to do with it.
    assert.match(task.reply, /你要用哪个/)
  } finally {
    await h.cleanup()
  }
})

test('an error outcome is stored with its message', async () => {
  const h = await harness({
    promptImpl: async () => ({
      status: TaskStatus.ERROR,
      reply: '执行失败：boom',
      stopReason: null,
    }),
  })
  try {
    const { taskId, work } = await h.dispatch({ streamId: 'chat-1', prompt: 'explode' })
    await work
    assert.equal(h.ledger.get(taskId).status, TaskStatus.ERROR)
    assert.match(h.ledger.get(taskId).reply, /boom/)
  } finally {
    await h.cleanup()
  }
})

test('a failed callback leaves the task pending for replay', async () => {
  // Port 1 is never listening, so delivery fails fast.
  const h = await harness({
    promptImpl: async () => ({ status: TaskStatus.DONE, reply: 'r', stopReason: 'end_turn' }),
    callbackUrl: 'http://127.0.0.1:1/event',
  })
  try {
    const { taskId, work } = await h.dispatch({ streamId: 'chat-1', prompt: 'p' })
    await work
    const task = h.ledger.get(taskId)
    assert.equal(task.status, TaskStatus.DONE, 'the result is kept even when reporting fails')
    assert.equal(task.notified, false)
    assert.equal(h.ledger.pendingNotifications().length, 1)
  } finally {
    await h.cleanup()
  }
})

// --- callback delivery in isolation ---

/** Start a throwaway HTTP endpoint; returns its url and received payloads. */
async function fakeReceiver({ failTimes = 0 } = {}) {
  const received = []
  let seen = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen += 1
      received.push({ body, auth: req.headers.authorization })
      if (seen <= failTimes) {
        // A genuine failure status, so the retry path is actually exercised.
        res.writeHead(500)
        res.end('nope')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/event`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const sampleTask = {
  taskId: 'task-1',
  streamId: 'chat-9',
  status: 'done',
  reply: 'done now',
  stopReason: 'end_turn',
  cwd: '/tmp',
  startedAt: 1,
  finishedAt: 2,
}

test('delivers a callback with a bearer credential', async () => {
  const rx = await fakeReceiver()
  try {
    const result = await deliverCallback({ url: rx.url, token: TOKEN, payload: sampleTask })
    assert.equal(result.ok, true)
    assert.equal(rx.received.length, 1)
    assert.equal(rx.received[0].auth, `Bearer ${TOKEN}`)
    const body = JSON.parse(rx.received[0].body)
    assert.equal(body.taskId, 'task-1')
    assert.equal(body.streamId, 'chat-9')
    assert.equal(body.reply, 'done now')
  } finally {
    await rx.close()
  }
})

test('retries after a failure and eventually succeeds', async () => {
  const rx = await fakeReceiver({ failTimes: 2 })
  try {
    const result = await deliverCallback({
      url: rx.url,
      token: TOKEN,
      payload: sampleTask,
      retries: 3,
      baseDelayMs: 5,
    })
    assert.equal(result.ok, true)
    assert.equal(rx.received.length, 3, 'two failures then one success')
    assert.equal(result.attempts, 3)
  } finally {
    await rx.close()
  }
})

test('gives up after the retry budget and reports failure', async () => {
  const rx = await fakeReceiver({ failTimes: 99 })
  try {
    const result = await deliverCallback({
      url: rx.url,
      token: TOKEN,
      payload: sampleTask,
      retries: 2,
      baseDelayMs: 5,
    })
    assert.equal(result.ok, false)
    assert.equal(rx.received.length, 3, 'one attempt plus two retries')
  } finally {
    await rx.close()
  }
})

test('skips delivery when no callback url is configured', async () => {
  const result = await deliverCallback({ url: '', token: TOKEN, payload: sampleTask })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
})

test('a timeout is reported as a failure, not an exception', async () => {
  // A receiver that never responds, to exercise the abort path.
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await deliverCallback({
      url: `http://127.0.0.1:${port}/event`,
      token: TOKEN,
      payload: sampleTask,
      retries: 0,
      timeoutMs: 150,
    })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /timed out/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('does not send the prompt back by default', () => {
  const payload = buildCallbackPayload({ ...sampleTask, prompt: 'secret instructions' })
  assert.equal('prompt' in payload, false)
  const withPrompt = buildCallbackPayload({ ...sampleTask, prompt: 'x' }, { includePrompt: true })
  assert.equal(withPrompt.prompt, 'x')
})
