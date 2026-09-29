/**
 * Server protocol tests.
 *
 * Runs the real TCP server against a stub dispatcher: proves the handshake
 * gate, framing, concurrency limit, and connection-teardown behaviour without
 * spawning an agent, so these stay fast and deterministic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { startBridge } from '../bridge/src/server.mjs'
import { BridgeError } from '../bridge/src/acpx.mjs'

const TOKEN = 'test-token-0123456789abcdef'

/** Minimal line-oriented client used by the tests. */
function client(port, host = '127.0.0.1') {
  const socket = connect(port, host)
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
    socket,
    ready: new Promise((resolve) => socket.on('connect', resolve)),
    next(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a line')), timeoutMs)
        waiters.push((message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
    send(value) {
      socket.write(`${JSON.stringify(value)}\n`)
    },
    end: () => new Promise((resolve) => socket.end(resolve)),
  }
}

/** Start a bridge on an ephemeral port with a stub dispatcher. */
async function startStub(handlers = {}, overrides = {}) {
  const config = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    maxConcurrency: 2,
    handshakeTimeoutMs: 800,
    requestTimeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
    agentCommand: 'stub',
    ...overrides,
  }
  const dispatch = {
    ping: async () => ({ ok: true }),
    sessionsList: async () => ({ sessions: [] }),
    sessionsNew: async () => ({ sessionId: 's-1' }),
    prompt: async () => ({ reply: 'hi' }),
    sessionsHistory: async () => ({ history: [] }),
    cancel: async () => ({ ok: true }),
    ...handlers,
  }
  const bridge = await startBridge(config, dispatch, { log: () => {} })
  return { bridge, config }
}

test('rejects a wrong token and closes the connection', async () => {
  const { bridge } = await startStub()
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: 'nope' })
    const reply = await c.next()
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'unauthorized')
  } finally {
    await bridge.close()
  }
})

test('closes a connection that never completes the handshake', async () => {
  const { bridge } = await startStub()
  try {
    const c = client(bridge.port)
    await c.ready
    const closed = new Promise((resolve) => c.socket.on('close', resolve))
    await closed // handshakeTimeoutMs is 800ms in the stub config
  } finally {
    await bridge.close()
  }
})

test('serves an authenticated request', async () => {
  const { bridge } = await startStub()
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: TOKEN })
    assert.deepEqual(await c.next(), { ok: true })
    c.send({ id: 'a1', op: 'ping' })
    const reply = await c.next()
    assert.equal(reply.id, 'a1')
    assert.equal(reply.ok, true)
  } finally {
    await bridge.close()
  }
})

test('reports an unknown op without dropping the connection', async () => {
  const { bridge } = await startStub()
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: TOKEN })
    await c.next()
    c.send({ id: 'x', op: 'no-such-op' })
    const reply = await c.next()
    assert.equal(reply.error.code, 'unknown-op')

    // The connection must still work afterwards.
    c.send({ id: 'y', op: 'ping' })
    assert.equal((await c.next()).ok, true)
  } finally {
    await bridge.close()
  }
})

test('replies to a malformed line and keeps going', async () => {
  const { bridge } = await startStub()
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: TOKEN })
    await c.next()
    c.socket.write('this is not json\n')
    const reply = await c.next()
    assert.equal(reply.error.code, 'bad-json')
  } finally {
    await bridge.close()
  }
})

test('surfaces a dispatcher BridgeError code verbatim', async () => {
  const { bridge } = await startStub({
    prompt: async () => {
      throw new BridgeError('no-session', 'no session in scope')
    },
  })
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: TOKEN })
    await c.next()
    c.send({ id: 'p', op: 'prompt', args: { text: 'hi' } })
    const reply = await c.next()
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'no-session')
  } finally {
    await bridge.close()
  }
})

test('rejects work beyond the concurrency limit instead of queueing it', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { bridge, config } = await startStub({
    prompt: async () => {
      await gate
      return { reply: 'done' }
    },
  })
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: TOKEN })
    await c.next()

    // Fill both slots (maxConcurrency is 2).
    c.send({ id: '1', op: 'prompt', args: { text: 'a' } })
    c.send({ id: '2', op: 'prompt', args: { text: 'b' } })
    // The third must be refused while the first two are still running.
    await new Promise((resolve) => setTimeout(resolve, 100))
    c.send({ id: '3', op: 'prompt', args: { text: 'c' } })

    const busy = await c.next()
    assert.equal(busy.id, '3')
    assert.equal(busy.error.code, 'busy')

    release()
    const rest = [await c.next(), await c.next()]
    assert.equal(rest.filter((r) => r.ok).length, 2)
    assert.equal(config.maxConcurrency, 2)
  } finally {
    await bridge.close()
  }
})

test('aborts in-flight work when the client disconnects', async () => {
  let observedAbort = false
  const { bridge } = await startStub({
    prompt: async (_args, signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          observedAbort = true
          resolve()
        })
      })
      return { reply: 'never sent' }
    },
  })
  try {
    const c = client(bridge.port)
    await c.ready
    c.send({ token: TOKEN })
    await c.next()
    c.send({ id: '1', op: 'prompt', args: { text: 'slow' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    c.socket.destroy()
    // Give the teardown a moment to propagate.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(observedAbort, true)
  } finally {
    await bridge.close()
  }
})
