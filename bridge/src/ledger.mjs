/**
 * Task ledger.
 *
 * Records every dispatched job so the bridge can (a) answer later questions
 * about it and (b) report its completion afterwards. This is the bridge's only
 * durable state; deleting the file is always safe.
 *
 * Writes are atomic (temp file + rename) and serialized through one promise
 * chain, because concurrent dispatches would otherwise interleave writes.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Task lifecycle states.
 *
 * There is no separate "waiting on the user" state by design: an agent that
 * pauses to ask something has finished its turn like any other, and the chat
 * decides from the returned text whether to report or to ask back.
 */
export const TaskStatus = {
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
}

/** Default ledger location; overridable so tests never touch a real home dir. */
export function defaultLedgerPath() {
  const dir = process.env.DSH_BRIDGE_STATE || join(homedir(), '.dsh-bridge')
  return join(dir, 'tasks.json')
}

export class Ledger {
  /**
   * @param {object} options
   * @param {string} options.path       ledger file
   * @param {number} options.ttlHours   drop finished tasks older than this
   * @param {number} options.maxTasks   hard cap on retained tasks
   */
  constructor({ path, ttlHours = 72, maxTasks = 200 }) {
    this.path = path
    this.ttlHours = ttlHours
    this.maxTasks = maxTasks
    /** @type {Map<string, object>} */
    this.tasks = new Map()
    /** Serializes writes so concurrent dispatches cannot interleave. */
    this.writeChain = Promise.resolve()
    this.loaded = false
  }

  /** Read the ledger from disk; a missing or corrupt file starts empty. */
  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object') {
        for (const [id, task] of Object.entries(parsed.tasks)) {
          if (task && typeof task === 'object') this.tasks.set(id, task)
        }
      }
    } catch (error) {
      // A missing ledger is normal; a corrupt one is worth knowing about but
      // must never stop the bridge from starting.
      if (error.code !== 'ENOENT') {
        process.emitWarning(`dsh-bridge: could not read ledger at ${this.path}: ${error.message}`)
      }
    }
    this.loaded = true
    this.prune()
    return this
  }

  /** Persist atomically, waiting for any in-flight write first. */
  async save() {
    const snapshot = JSON.stringify({ version: 1, tasks: Object.fromEntries(this.tasks) }, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, this.path)
    })
    return this.writeChain
  }

  /** Drop tasks that are finished and past their TTL, then enforce the cap. */
  prune(now = Date.now()) {
    const cutoff = now - this.ttlHours * 3600_000
    for (const [id, task] of this.tasks) {
      const finished = task.status !== TaskStatus.RUNNING
      if (finished && typeof task.finishedAt === 'number' && task.finishedAt < cutoff) {
        this.tasks.delete(id)
      }
    }
    if (this.tasks.size > this.maxTasks) {
      // Oldest finished first; never evict a running task.
      const finished = [...this.tasks.entries()]
        .filter(([, t]) => t.status !== TaskStatus.RUNNING)
        .sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0))
      let excess = this.tasks.size - this.maxTasks
      for (const [id] of finished) {
        if (excess <= 0) break
        this.tasks.delete(id)
        excess -= 1
      }
    }
  }

  /**
   * Register a newly dispatched task.
   *
   * @returns {object} the stored record
   */
  async create({ streamId, cwd, prompt, meta = {} }) {
    const taskId = randomUUID()
    const task = {
      taskId,
      streamId,
      cwd,
      prompt,
      meta,
      status: TaskStatus.RUNNING,
      startedAt: Date.now(),
      finishedAt: null,
      reply: null,
      stopReason: null,
      notified: false,
    }
    this.tasks.set(taskId, task)
    await this.save()
    return task
  }

  get(taskId) {
    return this.tasks.get(taskId) ?? null
  }

  /** Remember which agent session the task runs in, once it is known. */
  async setSessionId(taskId, sessionId) {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.sessionId = sessionId
    await this.save()
    return task
  }

  /** Record a terminal outcome and persist it. */
  async finish(taskId, { status, reply, stopReason }) {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.status = status
    task.reply = reply ?? null
    task.stopReason = stopReason ?? null
    task.finishedAt = Date.now()
    await this.save()
    return task
  }

  /** Mark a task's notification as delivered, so retries stop. */
  async markNotified(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.notified = true
    await this.save()
    return task
  }

  /** Tasks that finished but were never successfully reported. */
  pendingNotifications() {
    return [...this.tasks.values()].filter(
      (task) => task.status !== TaskStatus.RUNNING && task.notified === false,
    )
  }

  /** All tasks, newest first, for the list operation. */
  list(limit = 20) {
    return [...this.tasks.values()]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, limit)
      .map((task) => ({
        taskId: task.taskId,
        streamId: task.streamId,
        status: task.status,
        cwd: task.cwd,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        notified: task.notified,
      }))
  }
}
