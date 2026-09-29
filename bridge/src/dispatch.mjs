/**
 * Operation dispatch.
 *
 * Maps the bridge's small request vocabulary onto acpx invocations. Every op
 * returns plain JSON; failures carry a stable `code` so the plugin can react
 * without string-matching messages.
 */
import {
  BridgeError,
  cancelArgv,
  ensureSessionArgv,
  foldFrames,
  historyArgv,
  listSessionsArgv,
  newSessionArgv,
  parseFrames,
  parseSessionRow,
  groupByWorkspace,
  mergeSessionListings,
  promptArgv,
  runAcpx,
} from './acpx.mjs'
import { TaskStatus } from './ledger.mjs'
import { buildCallbackPayload, deliverCallback } from './callback.mjs'
import { classifyOutcome } from './outcome.mjs'

/** Reject anything that is not an absolute directory path. */
function requireCwd(value, fallback) {
  const cwd = value ?? fallback
  if (typeof cwd !== 'string' || cwd === '') {
    throw new BridgeError('bad-request', 'cwd must be a non-empty absolute path')
  }
  return cwd
}

function requireText(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError('bad-request', 'text must be a non-empty string')
  }
  return value
}

/** Parse acpx's tab-separated session table in either of its shapes. */
function parseSessionTable(stdout) {
  const sessions = []
  for (const line of stdout.split('\n')) {
    const row = parseSessionRow(line)
    if (row) sessions.push(row)
  }
  return sessions
}

/**
 * Create the dispatcher bound to one configuration.
 *
 * Each op receives already-validated-by-schema arguments plus a signal that
 * fires when the client disconnects, so abandoned work is torn down instead of
 * running to completion.
 */
export function createDispatch(config, deps = {}) {
  const ledger = deps.ledger ?? null
  const log = deps.log ?? (() => {})
  /** Background task runners, tracked so shutdown can wait for them. */
  const running = new Set()
  /** Guards background dispatch against the configured concurrency limit. */
  let backgroundActive = 0
  const base = {
    acpxPath: config.acpxPath,
    timeoutMs: config.requestTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  }
  const timeoutSeconds = Math.max(1, Math.floor(config.requestTimeoutMs / 1000))

  async function run(argv, signal) {
    const { code, stdout, stderr } = await runAcpx(argv, { ...base, signal })
    if (code !== 0) {
      // acpx exit code 4 means "no session in scope"; that is a caller mistake,
      // not an internal fault, so it gets its own code.
      const codeName = code === 4 ? 'no-session' : 'agent-failed'
      throw new BridgeError(codeName, `acpx exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`)
    }
    return stdout
  }

  /**
   * Run one prompt to completion and fold it into an outcome.
   *
   * Shared by the synchronous `prompt` op and the asynchronous `dispatch` path
   * so both classify identically.
   */
  async function runPrompt({ cwd, name, text, signal }) {
    const stdout = await run(
      promptArgv({
        agentCommand: config.agentCommand,
        cwd,
        name,
        text,
        timeoutSeconds,
      }),
      signal,
    )
    const folded = foldFrames(parseFrames(stdout))
    const { status, reason } = classifyOutcome({
      reply: folded.text,
      stopReason: folded.stopReason,
    })
    return {
      reply: folded.text,
      stopReason: folded.stopReason,
      sessionId: folded.sessionId,
      toolCalls: folded.toolCalls,
      usage: folded.usage,
      status,
      outcomeReason: reason,
    }
  }

  /**
   * Report a finished task back to the chat, retrying on failure.
   *
   * A closure rather than a method so the background runner can call it without
   * depending on `this`; that runner outlives the object returned below.
   */
  async function notify(taskId) {
    if (!ledger) return { ok: false, error: 'no ledger' }
    const task = ledger.get(taskId)
    if (!task || task.status === TaskStatus.RUNNING) return { ok: false, error: 'not finished' }
    const result = await deliverCallback({
      url: config.callbackUrl,
      token: config.token,
      payload: buildCallbackPayload(task),
      retries: config.callbackRetries,
      log,
    })
    if (result.ok) {
      await ledger.markNotified(taskId)
    }
    return result
  }

  return {
    async ping() {
      return { ok: true, agentCommand: config.agentCommand }
    },

    async sessionsList(args, signal) {
      const cwd = requireCwd(args.cwd, '/tmp')
      const useAcpList = args.source !== 'local'
      const stdout = await run(
        listSessionsArgv({
          agentCommand: config.agentCommand,
          cwd,
          filterCwd: args.filterCwd,
          useAcpList,
        }),
        signal,
      )
      return { source: useAcpList ? 'agent' : 'local', sessions: parseSessionTable(stdout) }
    },

    async sessionsNew(args, signal) {
      const cwd = requireCwd(args.cwd, '/tmp')
      const stdout = await run(
        newSessionArgv({ agentCommand: config.agentCommand, cwd, name: args.name }),
        signal,
      )
      // Creating a session in the same scope may displace an older one, which
      // acpx reports on the same line as a tab-separated note.
      const sessionId = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('['))
        .map((l) => l.split('\t')[0].trim())
        .filter((l) => l !== '')
        .pop()
      if (!sessionId) throw new BridgeError('agent-failed', 'acpx did not report a session id')
      return { sessionId, cwd, name: args.name ?? null }
    },

    /**
     * Idempotently obtain a named session: reuse it when it exists, create it
     * otherwise. This is what lets a caller say "continue the X conversation"
     * without knowing whether X exists yet.
     */
    async sessionsEnsure(args, signal) {
      const cwd = requireCwd(args.cwd, '/tmp')
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
      const stdout = await run(
        ensureSessionArgv({ agentCommand: config.agentCommand, cwd, name }),
        signal,
      )
      // Output is `<sessionId>\t(existing|created)`.
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('['))
        .pop()
      if (!line) throw new BridgeError('agent-failed', 'acpx did not report a session id')
      const [sessionId, note] = line.split('\t')
      return {
        sessionId: sessionId.trim(),
        created: (note ?? '').includes('created'),
        cwd,
        name,
      }
    },

    /**
     * Group known sessions by working directory.
     *
     * Queries both sources and merges them, because neither alone is enough:
     * the ACP listing is the only complete view of which workspaces exist but
     * has no names, while the local records carry the names needed to continue
     * a conversation but only cover directories acpx has been run from.
     */
    async workspaces(args) {
      const cwd = requireCwd(args.cwd, '/tmp')
      const wantAcp = args.source !== 'local'

      const localOut = await run(listSessionsArgv({ agentCommand: config.agentCommand, cwd, useAcpList: false }))
      const localRows = parseSessionTable(localOut)

      let merged = localRows
      if (wantAcp) {
        // The agent listing can fail (no session store, agent unavailable);
        // the local records still answer the question, so degrade quietly.
        try {
          const acpOut = await run(listSessionsArgv({ agentCommand: config.agentCommand, cwd, useAcpList: true }))
          merged = mergeSessionListings(parseSessionTable(acpOut), localRows)
        } catch (error) {
          log(`workspaces: agent listing unavailable (${error.message}); using local records`)
        }
      }

      const onlyNamed = args.namedOnly === true
      const filtered = onlyNamed ? merged.filter((s) => s.name) : merged
      const workspaces = groupByWorkspace(filtered, {
        maxSessionsPerWorkspace: Number.isInteger(args.maxPerWorkspace) ? args.maxPerWorkspace : 20,
      })

      return {
        workspaces,
        totalSessions: filtered.length,
        namedSessions: merged.filter((s) => s.name).length,
        source: wantAcp ? 'agent+local' : 'local',
      }
    },

    async prompt(args, signal) {
      const cwd = requireCwd(args.cwd, '/tmp')
      const text = requireText(args.text)
      const result = await runPrompt({ cwd, name: args.name, text, signal })
      // The synchronous op reports the same fields it always has.
      return {
        reply: result.reply,
        stopReason: result.stopReason,
        sessionId: result.sessionId,
        toolCalls: result.toolCalls,
        usage: result.usage,
        status: result.status,
      }
    },

    /**
     * Asynchronous dispatch: register the work and return immediately.
     *
     * The returned taskId is the handle the caller uses to ask about it later.
     * The background run deliberately does NOT use the request's AbortSignal —
     * a chat client disconnecting (or the caller hanging up right after the
     * reply, which is the normal case) must not cancel the work.
     */
    async dispatch(args) {
      if (!ledger) throw new BridgeError('internal', 'task ledger is not available')
      const cwd = requireCwd(args.cwd, '/tmp')
      const text = requireText(args.text)
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
      const streamId = typeof args.streamId === 'string' && args.streamId !== '' ? args.streamId : null
      if (!streamId) {
        throw new BridgeError('bad-request', 'streamId is required for an asynchronous dispatch')
      }
      if (backgroundActive >= config.maxConcurrency) {
        throw new BridgeError('busy', `bridge is at its concurrency limit (${config.maxConcurrency})`)
      }

      const task = await ledger.create({
        streamId,
        cwd,
        prompt: text,
        meta: { ...(args.meta ?? {}), sessionName: name },
      })
      backgroundActive += 1

      const work = (async () => {
        try {
          // Guarantee the conversation exists before prompting. A first run in
          // a directory has no session yet, and acpx refuses a prompt without
          // one; ensuring here makes "continue conversation X" work whether or
          // not X has ever been used, without surfacing that detail upward.
          const session = await run(
            ensureSessionArgv({ agentCommand: config.agentCommand, cwd, name }),
          )
          const ensuredId = session
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '' && !l.startsWith('['))
            .pop()
            ?.split('\t')[0]
            ?.trim()
          if (ensuredId) {
            await ledger.setSessionId(task.taskId, ensuredId)
          }

          const result = await runPrompt({ cwd, name, text })
          await ledger.finish(task.taskId, {
            status: result.status,
            reply: result.reply,
            stopReason: result.stopReason,
          })
          log(`task ${task.taskId} finished as ${result.status} (${result.outcomeReason})`)
        } catch (error) {
          const { status } = classifyOutcome({ reply: '', stopReason: null, error })
          await ledger.finish(task.taskId, {
            status,
            reply: `执行失败：${error.message}`,
            stopReason: null,
          })
          log(`task ${task.taskId} failed: ${error.message}`)
        } finally {
          backgroundActive -= 1
          running.delete(work)
        }
        await notify(task.taskId)
      })()

      running.add(work)
      // `dispatch` returns as soon as the task is registered; the work above
      // continues on its own.
      return { taskId: task.taskId, status: TaskStatus.RUNNING, dispatched: true, sessionName: name }
    },

    async taskStatus(args) {
      if (!ledger) throw new BridgeError('internal', 'task ledger is not available')
      const taskId = typeof args.taskId === 'string' ? args.taskId : ''
      if (taskId === '') throw new BridgeError('bad-request', 'taskId is required')
      const task = ledger.get(taskId)
      if (!task) throw new BridgeError('unknown-task', `no task ${JSON.stringify(taskId)}`)
      // The full reply is returned so the chat can answer follow-up questions
      // from stored facts without paying for another agent run.
      return {
        taskId: task.taskId,
        streamId: task.streamId,
        status: task.status,
        reply: task.reply,
        stopReason: task.stopReason,
        cwd: task.cwd,
        // Needed to send a follow-up into the very same conversation.
        sessionName: task.meta?.sessionName ?? null,
        sessionId: task.sessionId ?? null,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
      }
    },

    async taskList(args) {
      if (!ledger) throw new BridgeError('internal', 'task ledger is not available')
      const limit = Number.isInteger(args.limit) ? args.limit : 20
      return { tasks: ledger.list(limit) }
    },

    /** Report a finished task back to the chat (also used by replayPending). */
    notify,

    /** Re-deliver every task whose report never landed. Used on startup. */
    async replayPending() {
      if (!ledger) return { attempted: 0, delivered: 0 }
      const pending = ledger.pendingNotifications()
      let delivered = 0
      for (const task of pending) {
        const result = await notify(task.taskId)
        if (result.ok) delivered += 1
      }
      return { attempted: pending.length, delivered }
    },

    /** Wait for in-flight background work; used by graceful shutdown. */
    async drain() {
      await Promise.allSettled([...running])
    },

    async sessionsHistory(args, signal) {
      const cwd = requireCwd(args.cwd, '/tmp')
      const limit = Number.isInteger(args.limit) ? args.limit : 20
      const stdout = await run(
        historyArgv({ agentCommand: config.agentCommand, cwd, name: args.name, limit }),
        signal,
      )
      // `sessions history` prints human-readable text; hand it back verbatim
      // alongside a line-per-entry view the plugin can filter on.
      return { history: stdout.trim().split('\n').filter((l) => l.trim() !== '') }
    },

    async cancel(args, signal) {
      const cwd = requireCwd(args.cwd, '/tmp')
      await run(cancelArgv({ agentCommand: config.agentCommand, cwd, name: args.name }), signal)
      return { ok: true }
    },
  }
}
