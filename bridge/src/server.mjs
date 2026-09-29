/**
 * TCP server: one authenticated, newline-delimited JSON connection per client.
 *
 * Wire format
 *   1. client -> {"token":"<shared>"}\n        (must be the first line)
 *   2. server -> {"ok":true}\n                  (or {"ok":false,"reason":...} + close)
 *   3. client -> {"id":"<any>","op":"<name>","args":{...}}\n   (repeatable)
 *   4. server -> {"id":"<same>","ok":true,"value":{...}}\n
 *
 * A connection is closed on a failed handshake, an oversized line, or a
 * protocol violation. Requests are served concurrently up to maxConcurrency;
 * the excess is rejected rather than queued, so a busy bridge fails fast and
 * visibly instead of silently backing up.
 */
import { createServer } from 'node:net'
import { verifyHandshake } from './auth.mjs'
import { BridgeError } from './acpx.mjs'

const MAX_LINE_BYTES = 1 * 1024 * 1024

/** Operations reachable over the wire, with a minimal argument check each. */
const OPS = {
  ping: { handler: 'ping', args: () => ({}) },
  sessions_list: { handler: 'sessionsList', args: (a) => a ?? {} },
  sessions_new: { handler: 'sessionsNew', args: (a) => a ?? {} },
  sessions_ensure: { handler: 'sessionsEnsure', args: (a) => a ?? {} },
  workspaces: { handler: 'workspaces', args: (a) => a ?? {} },
  prompt: { handler: 'prompt', args: (a) => a ?? {} },
  sessions_history: { handler: 'sessionsHistory', args: (a) => a ?? {} },
  cancel: { handler: 'cancel', args: (a) => a ?? {} },
  // Asynchronous dispatch and its lookups.
  dispatch: { handler: 'dispatch', args: (a) => a ?? {} },
  task_status: { handler: 'taskStatus', args: (a) => a ?? {} },
  task_list: { handler: 'taskList', args: (a) => a ?? {} },
  task_replay: { handler: 'replayPending', args: () => ({}) },
}

function send(socket, value) {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(value)}\n`)
}

/**
 * Start the bridge.
 *
 * @returns {Promise<{server: import('node:net').Server, port: number, close: () => Promise<void>}>}
 */
export function startBridge(config, dispatch, { log = () => {} } = {}) {
  let active = 0
  /** Live connections, so shutdown can end them instead of waiting forever. */
  const connections = new Set()

  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    connections.add(socket)

    let buffer = ''
    let authed = false
    let closed = false
    const inflight = new Set()

    const handshakeTimer = setTimeout(() => {
      if (!authed) {
        log('handshake timeout')
        socket.destroy()
      }
    }, config.handshakeTimeoutMs)

    const teardown = () => {
      if (closed) return
      closed = true
      clearTimeout(handshakeTimer)
      connections.delete(socket)
      // Abandoning the socket cancels whatever it was waiting on.
      for (const controller of inflight) controller.abort()
      inflight.clear()
    }

    socket.on('close', teardown)
    socket.on('error', teardown)

    const runRequest = async (message) => {
      const id = message.id ?? null
      const spec = OPS[message.op]
      if (!spec) {
        send(socket, { id, ok: false, error: { code: 'unknown-op', message: `unknown op ${JSON.stringify(message.op)}` } })
        return
      }
      if (active >= config.maxConcurrency) {
        send(socket, { id, ok: false, error: { code: 'busy', message: `bridge is at its concurrency limit (${config.maxConcurrency})` } })
        return
      }

      active += 1
      const controller = new AbortController()
      inflight.add(controller)
      const startedAt = Date.now()
      try {
        const args = spec.args(message.args)
        const value = await dispatch[spec.handler](args, controller.signal)
        send(socket, { id, ok: true, value })
        log(`${message.op} ok in ${Date.now() - startedAt}ms`)
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : 'internal'
        send(socket, { id, ok: false, error: { code, message: error.message } })
        log(`${message.op} failed (${code}) in ${Date.now() - startedAt}ms`)
      } finally {
        active -= 1
        inflight.delete(controller)
      }
    }

    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        log('line too large')
        socket.destroy()
        return
      }
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue

        if (!authed) {
          const verdict = verifyHandshake(line, config.token)
          if (!verdict.ok) {
            // Deliberately vague outward, precise in the log.
            log(`handshake rejected: ${verdict.reason}`)
            send(socket, { ok: false, error: { code: 'unauthorized' } })
            socket.end()
            return
          }
          authed = true
          clearTimeout(handshakeTimer)
          send(socket, { ok: true })
          continue
        }

        let message
        try {
          message = JSON.parse(line)
        } catch {
          send(socket, { id: null, ok: false, error: { code: 'bad-json', message: 'request line is not JSON' } })
          continue
        }
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
          send(socket, { id: null, ok: false, error: { code: 'bad-request', message: 'request must be a JSON object' } })
          continue
        }
        void runRequest(message)
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(config.port, config.host, () => {
      const address = server.address()
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            // `server.close()` only stops accepting; live connections would keep
            // the callback pending forever, so end them explicitly first.
            for (const socket of connections) socket.destroy()
            connections.clear()
            server.close((error) => (error ? fail(error) : done()))
          }),
      })
    })
  })
}
