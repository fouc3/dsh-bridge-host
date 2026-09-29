/**
 * Ledger and outcome-classification tests.
 *
 * These cover the state that makes asynchronous dispatch possible, and the
 * classification that decides how the chat gets told about a finished task.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, TaskStatus } from '../bridge/src/ledger.mjs'
import { classifyOutcome } from '../bridge/src/outcome.mjs'

/** Create a ledger backed by a throwaway directory. */
async function tempLedger(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ledger-'))
  const ledger = await new Ledger({ path: join(dir, 'tasks.json'), ...options }).load()
  return { ledger, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('creates a running task and persists it', async () => {
  const { ledger, dir, cleanup } = await tempLedger()
  try {
    const task = await ledger.create({ streamId: 's-1', cwd: '/tmp', prompt: 'do the thing' })
    assert.equal(task.status, TaskStatus.RUNNING)
    assert.equal(task.notified, false)
    assert.match(task.taskId, /^[0-9a-f-]{36}$/)

    // A fresh ledger over the same file must see it.
    const reloaded = await new Ledger({ path: join(dir, 'tasks.json') }).load()
    assert.equal(reloaded.get(task.taskId).streamId, 's-1')
  } finally {
    await cleanup()
  }
})

test('records a terminal outcome and full reply', async () => {
  const { ledger, cleanup } = await tempLedger()
  try {
    const task = await ledger.create({ streamId: 's-1', cwd: '/tmp', prompt: 'p' })
    await ledger.finish(task.taskId, {
      status: TaskStatus.DONE,
      reply: 'the full answer',
      stopReason: 'end_turn',
    })
    const stored = ledger.get(task.taskId)
    assert.equal(stored.status, TaskStatus.DONE)
    // The complete reply is retained so follow-up questions need no new run.
    assert.equal(stored.reply, 'the full answer')
    assert.ok(stored.finishedAt > 0)
  } finally {
    await cleanup()
  }
})

test('marks notification delivery so retries stop', async () => {
  const { ledger, cleanup } = await tempLedger()
  try {
    const task = await ledger.create({ streamId: 's', cwd: '/tmp', prompt: 'p' })
    await ledger.finish(task.taskId, { status: TaskStatus.DONE, reply: 'r', stopReason: 'end_turn' })

    // Finished but unreported: it must show up as pending.
    assert.equal(ledger.pendingNotifications().length, 1)

    await ledger.markNotified(task.taskId)
    assert.equal(ledger.pendingNotifications().length, 0)
  } finally {
    await cleanup()
  }
})

test('a running task is never reported as pending', async () => {
  const { ledger, cleanup } = await tempLedger()
  try {
    await ledger.create({ streamId: 's', cwd: '/tmp', prompt: 'p' })
    assert.equal(ledger.pendingNotifications().length, 0)
  } finally {
    await cleanup()
  }
})

test('prunes finished tasks past their TTL but keeps running ones', async () => {
  const { ledger, cleanup } = await tempLedger({ ttlHours: 1 })
  try {
    const old = await ledger.create({ streamId: 's', cwd: '/tmp', prompt: 'old' })
    await ledger.finish(old.taskId, { status: TaskStatus.DONE, reply: 'r', stopReason: 'end_turn' })
    const live = await ledger.create({ streamId: 's', cwd: '/tmp', prompt: 'live' })

    // Pretend the finished one landed two hours ago.
    ledger.get(old.taskId).finishedAt = Date.now() - 2 * 3600_000
    ledger.prune()

    assert.equal(ledger.get(old.taskId), null)
    assert.ok(ledger.get(live.taskId))
  } finally {
    await cleanup()
  }
})

test('enforces the task cap without evicting running work', async () => {
  const { ledger, cleanup } = await tempLedger({ maxTasks: 3 })
  try {
    const running = await ledger.create({ streamId: 's', cwd: '/tmp', prompt: 'running' })
    for (let i = 0; i < 5; i += 1) {
      const t = await ledger.create({ streamId: 's', cwd: '/tmp', prompt: `done-${i}` })
      await ledger.finish(t.taskId, { status: TaskStatus.DONE, reply: 'r', stopReason: 'end_turn' })
      ledger.get(t.taskId).startedAt = 1000 + i
    }
    ledger.prune()
    assert.ok(ledger.tasks.size <= 3)
    assert.ok(ledger.get(running.taskId), 'a running task must survive pruning')
  } finally {
    await cleanup()
  }
})

test('writes atomically and leaves no temp files behind', async () => {
  const { ledger, dir, cleanup } = await tempLedger()
  try {
    const task = await ledger.create({ streamId: 's', cwd: '/tmp', prompt: 'p' })
    await ledger.finish(task.taskId, { status: TaskStatus.DONE, reply: 'r', stopReason: 'e' })
    // Concurrent mutations must serialize without corrupting the file.
    await Promise.all([
      ledger.markNotified(task.taskId),
      ledger.create({ streamId: 's2', cwd: '/tmp', prompt: 'p2' }),
    ])
    const raw = await readFile(join(dir, 'tasks.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.ok(Object.keys(parsed.tasks).length >= 2)

    const { readdir } = await import('node:fs/promises')
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'temp files must be renamed away')
  } finally {
    await cleanup()
  }
})

test('tolerates a missing or corrupt ledger file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ledger-bad-'))
  try {
    const missing = await new Ledger({ path: join(dir, 'nope.json') }).load()
    assert.equal(missing.tasks.size, 0)

    const { writeFile } = await import('node:fs/promises')
    const badPath = join(dir, 'bad.json')
    await writeFile(badPath, '{ this is not json')
    const corrupt = await new Ledger({ path: badPath }).load()
    assert.equal(corrupt.tasks.size, 0, 'a corrupt ledger starts empty rather than crashing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- outcome classification ---

test('classifies a normal completion as done', () => {
  const { status } = classifyOutcome({ reply: '全部做完了。', stopReason: 'end_turn' })
  assert.equal(status, TaskStatus.DONE)
})

test('classifies a thrown failure as error', () => {
  const { status } = classifyOutcome({ reply: '', stopReason: null, error: new Error('boom') })
  assert.equal(status, TaskStatus.ERROR)
})

test('classifies an unexpected stop reason as error', () => {
  const { status } = classifyOutcome({ reply: 'partial', stopReason: 'refusal' })
  assert.equal(status, TaskStatus.ERROR)
})

test('classifies an empty reply as error', () => {
  const { status } = classifyOutcome({ reply: '   ', stopReason: 'end_turn' })
  assert.equal(status, TaskStatus.ERROR)
})

test('a reply that asks the user something is still done, not a third state', () => {
  // The agent finished its turn; deciding whether that is a question or a
  // report belongs to the chat, which can see the conversation. This layer
  // must not guess from punctuation.
  const { status } = classifyOutcome({
    reply: '我找到了两个候选目录，你要用哪一个？',
    stopReason: 'end_turn',
  })
  assert.equal(status, TaskStatus.DONE)
})

test('a reply ending in punctuation-free prose is done', () => {
  const { status } = classifyOutcome({ reply: '已经处理完毕', stopReason: 'end_turn' })
  assert.equal(status, TaskStatus.DONE)
})

test('there is no question state at all', () => {
  // Guards against the state creeping back in.
  assert.deepEqual(Object.values(TaskStatus).sort(), ['done', 'error', 'running'])
})
