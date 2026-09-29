/**
 * acpx invocation and ACP stream parsing.
 *
 * acpx is the ACP client: it spawns `dsh --profile acp`, speaks the protocol,
 * and (in `--format json`) mirrors the raw JSON-RPC frames on stdout, one per
 * line. `[acpx] ...` progress lines go to stderr. This module runs one acpx
 * child per operation and folds its frame stream into a small result object.
 */
import { spawn } from 'node:child_process'

/** Terminal failure surfaced to the client; carries a stable code. */
export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * Run one acpx command and resolve with { code, stdout, stderr }.
 *
 * `timeoutMs` kills the child; `maxOutputBytes` aborts a runaway response so a
 * misbehaving agent cannot exhaust the bridge's memory.
 */
export function runAcpx(argv, { acpxPath, timeoutMs, maxOutputBytes, env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(acpxPath, argv, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    let killedBy = null

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(value)
    }

    const kill = (reason) => {
      if (killedBy === null) killedBy = reason
      child.kill('SIGTERM')
      // Escalate if the process ignores the polite signal.
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 2000).unref?.()
    }

    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = () => kill('aborted')
    if (signal) {
      if (signal.aborted) return kill('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        kill('output-limit')
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })

    child.on('error', (error) => {
      finish(reject, new BridgeError('agent-spawn-failed', `cannot run acpx: ${error.message}`))
    })

    child.on('close', (code) => {
      if (killedBy === 'timeout') {
        return finish(reject, new BridgeError('timeout', `acpx exceeded ${timeoutMs} ms`))
      }
      if (killedBy === 'output-limit') {
        return finish(reject, new BridgeError('output-too-large', `acpx output exceeded ${maxOutputBytes} bytes`))
      }
      if (killedBy === 'aborted') {
        return finish(reject, new BridgeError('cancelled', 'request cancelled'))
      }
      finish(resolve, { code, stdout, stderr })
    })
  })
}

/** Parse newline-delimited JSON frames, ignoring anything that is not an object. */
export function parseFrames(stdout) {
  const frames = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object') frames.push(value)
    } catch {
      // acpx never mixes non-JSON into stdout in --format json; skip defensively.
    }
  }
  return frames
}

/**
 * Fold an ACP frame stream into the assistant's answer.
 *
 * Assistant text arrives as `session/update` notifications carrying
 * `agent_message_chunk`; the turn ends with a response whose `stopReason`
 * explains why. Tool calls are counted so the caller can report what happened
 * without leaking tool payloads.
 */
export function foldFrames(frames) {
  const text = []
  let stopReason = null
  let sessionId = null
  let toolCalls = 0
  let usage = null

  for (const frame of frames) {
    const params = frame.params
    if (frame.method === 'session/update' && params) {
      if (typeof params.sessionId === 'string') sessionId = params.sessionId
      const update = params.update
      if (!update) continue
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content
        if (content?.type === 'text' && typeof content.text === 'string') text.push(content.text)
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        toolCalls += 1
      } else if (update.sessionUpdate === 'usage_update') {
        usage = { used: update.used, size: update.size }
      }
      continue
    }
    if (frame.result && typeof frame.result === 'object' && 'stopReason' in frame.result) {
      stopReason = frame.result.stopReason
      continue
    }
    if (frame.result && typeof frame.result === 'object' && typeof frame.result.sessionId === 'string') {
      sessionId = frame.result.sessionId
    }
  }

  return { text: text.join(''), stopReason, sessionId, toolCalls, usage }
}

/**
 * Parse one acpx session row.
 *
 * Two shapes exist, both tab-separated:
 *   ACP list :  <id>\t<name>\t<cwd>\t-\t-
 *   --local  :  <id> [closed]\t<name>\t<cwd>\t<iso timestamp>
 *
 * `sessions new` also prints a two-column line when creating a session
 * displaced an older one: <id>\t(replaced <id>). That line still carries a
 * usable id, so a missing cwd is tolerated.
 *
 * The id may carry a suffix such as ` [closed]`; that suffix is not part of it.
 */
export function parseSessionRow(line) {
  const trimmed = line.trim()
  if (trimmed === '') return null
  const parts = trimmed.split('\t')
  if (parts.length < 2) return null

  let id = parts[0].trim()
  let closed = false
  if (id.endsWith('[closed]')) {
    closed = true
    id = id.slice(0, -'[closed]'.length).trim()
  }
  // A trailing "(replaced ...)" note belongs to acpx's output, not the id.
  const noteAt = id.indexOf(' (')
  if (noteAt !== -1) id = id.slice(0, noteAt).trim()
  if (id === '') return null

  const name = (parts[1] ?? '').trim()
  return {
    sessionId: id,
    name: name === '-' || name === '' ? null : name,
    cwd: parts[2] ? parts[2].trim() || null : null,
    closed,
    lastUsedAt: parts[3] && parts[3] !== '-' ? parts[3].trim() : null,
  }
}

/** Build the argv that creates a session. */
export function newSessionArgv({ agentCommand, cwd, name }) {
  const argv = ['--cwd', cwd, '--agent', agentCommand, 'sessions', 'new']
  if (name) argv.push('--name', name)
  return argv
}

/**
 * Build the argv for a prompt.
 *
 * `-s/--session <name>` belongs to the `prompt` subcommand, not the global
 * option set: placing it before `prompt` makes acpx reject the invocation. The
 * text is positional and must come last.
 */
export function promptArgv({ agentCommand, cwd, name, text, timeoutSeconds }) {
  const argv = [
    '--cwd', cwd,
    '--agent', agentCommand,
    '--format', 'json',
    '--json-strict',
    '--timeout', String(timeoutSeconds),
    'prompt',
  ]
  if (name) argv.push('-s', name)
  argv.push(text)
  return argv
}

/**
 * Build the argv that lists sessions.
 *
 * `sessions list` accepts neither `--format` nor `--json`, so its tabular
 * output is parsed instead. `--local` reads acpx's own records; the default
 * asks the agent over ACP and reports the agent's real conversations.
 */
export function listSessionsArgv({ agentCommand, cwd, filterCwd, useAcpList }) {
  const argv = ['--cwd', cwd, '--agent', agentCommand, 'sessions', 'list']
  if (!useAcpList) argv.push('--local')
  if (filterCwd) argv.push('--filter-cwd', filterCwd)
  return argv
}

/**
 * Build the argv for an idempotent named session: reuse it, or create it.
 */
export function ensureSessionArgv({ agentCommand, cwd, name }) {
  const argv = ['--cwd', cwd, '--agent', agentCommand, 'sessions', 'ensure']
  if (name) argv.push('--name', name)
  return argv
}

/**
 * Merge two session listings into one view keyed by session id.
 *
 * The two sources are complementary and neither is sufficient alone:
 *
 *   - the ACP listing reports every conversation the agent knows, so it is the
 *     only complete picture of which workspaces exist, but it carries no names;
 *   - the local listing carries the names that are needed to *continue* a
 *     session, but only covers directories acpx has itself been invoked in.
 *
 * ACP wins on identity and cwd; the local record contributes the name and the
 * last-used timestamp (the ACP listing reports neither) and fills in a missing
 * cwd. Without the timestamp, ordering by recency would silently degrade.
 */
export function mergeSessionListings(acpRows, localRows) {
  const merged = new Map()
  for (const row of acpRows) {
    merged.set(row.sessionId, { ...row })
  }
  for (const row of localRows) {
    const existing = merged.get(row.sessionId)
    if (!existing) {
      merged.set(row.sessionId, { ...row })
      continue
    }
    if (row.name) existing.name = row.name
    if (row.lastUsedAt && !existing.lastUsedAt) existing.lastUsedAt = row.lastUsedAt
    if (!existing.cwd && row.cwd) existing.cwd = row.cwd
    // A session closed locally is closed, whatever the agent still reports.
    if (row.closed) existing.closed = true
  }
  return [...merged.values()]
}

/**
 * Group merged sessions by working directory.
 *
 * Ordering is by most recent activity, but only the sessions acpx has itself
 * recorded carry a timestamp; the agent's listing reports none. Workspaces with
 * dated activity therefore lead, and the rest keep a stable alphabetical order
 * rather than shuffling between calls.
 *
 * The per-workspace session list is capped so one busy directory (a scratch
 * `/tmp`, say) cannot bury every other workspace in the response.
 */
export function groupByWorkspace(sessions, { maxSessionsPerWorkspace = 20 } = {}) {
  const byCwd = new Map()
  for (const session of sessions) {
    const key = session.cwd ?? '(unknown)'
    if (!byCwd.has(key)) byCwd.set(key, [])
    byCwd.get(key).push(session)
  }

  const workspaces = [...byCwd.entries()].map(([path, items]) => {
    const sorted = items.slice().sort((a, b) => {
      const at = a.lastUsedAt ?? ''
      const bt = b.lastUsedAt ?? ''
      if (at !== bt) return String(bt).localeCompare(String(at))
      // No timestamps: keep a deterministic order so repeated calls agree.
      return String(a.sessionId).localeCompare(String(b.sessionId))
    })
    const dated = sorted.filter((s) => s.lastUsedAt)
    return {
      cwd: path,
      sessionCount: sorted.length,
      namedCount: sorted.filter((s) => s.name).length,
      // Recency is only meaningful when something actually carries a date.
      lastUsedAt: dated[0]?.lastUsedAt ?? null,
      sessions: sorted.slice(0, maxSessionsPerWorkspace).map((s) => ({
        sessionId: s.sessionId,
        name: s.name ?? null,
        closed: Boolean(s.closed),
        lastUsedAt: s.lastUsedAt ?? null,
      })),
    }
  })

  // Workspaces with dated activity first (newest leading); undated ones follow
  // in a stable order, flagged by a null `lastUsedAt`.
  workspaces.sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return String(b.lastUsedAt).localeCompare(String(a.lastUsedAt))
    if (a.lastUsedAt) return -1
    if (b.lastUsedAt) return 1
    return String(a.cwd).localeCompare(String(b.cwd))
  })
  return workspaces
}

/** Build the argv that prints recent turn previews for one session.
 *
 * `sessions history` takes no `--format`; its text output is returned as-is.
 */
export function historyArgv({ agentCommand, cwd, name, limit }) {
  const argv = ['--cwd', cwd, '--agent', agentCommand, 'sessions', 'history']
  argv.push('--limit', String(limit))
  if (name) argv.push(name)
  return argv
}

/** Build the argv that cooperatively cancels a session's in-flight prompt. */
export function cancelArgv({ agentCommand, cwd, name }) {
  const argv = ['--cwd', cwd, '--agent', agentCommand, 'cancel']
  if (name) argv.push('-s', name)
  return argv
}
