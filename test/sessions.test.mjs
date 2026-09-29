/**
 * Named-session tests.
 *
 * Covers the two things that make "continue an earlier conversation" work:
 * a caller can name a session, and the bridge can report which workspaces and
 * sessions exist so that name can be discovered.
 *
 * The argv shapes are asserted directly because acpx is strict about where
 * `-s/--session` may appear: putting it in the global position makes the whole
 * invocation fail, which is exactly the bug these tests exist to prevent.
 */
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  ensureSessionArgv,
  promptArgv,
  listSessionsArgv,
  mergeSessionListings,
  groupByWorkspace,
  parseSessionRow,
} from '../bridge/src/acpx.mjs'

const COMMON = { agentCommand: 'dsh --profile acp', cwd: '/tmp/work' }

test('prompt places the session name after the prompt subcommand', () => {
  const argv = promptArgv({ ...COMMON, name: 'alpha', text: 'hello', timeoutSeconds: 60 })
  const subcommandAt = argv.indexOf('prompt')
  const sessionAt = argv.indexOf('-s')
  assert.ok(subcommandAt !== -1, 'the prompt subcommand must be present')
  assert.ok(sessionAt > subcommandAt, `-s must follow the subcommand, got ${JSON.stringify(argv)}`)
  assert.equal(argv[sessionAt + 1], 'alpha')
  // The prompt text is positional and must be last.
  assert.equal(argv.at(-1), 'hello')
})

test('prompt omits the session flag when unnamed', () => {
  const argv = promptArgv({ ...COMMON, text: 'hello', timeoutSeconds: 60 })
  assert.equal(argv.includes('-s'), false)
  assert.equal(argv.at(-1), 'hello')
})

test('ensure asks for an idempotent named session', () => {
  const argv = ensureSessionArgv({ ...COMMON, name: 'alpha' })
  assert.deepEqual(argv.slice(0, 4), ['--cwd', '/tmp/work', '--agent', 'dsh --profile acp'])
  assert.ok(argv.includes('ensure'))
  assert.equal(argv[argv.indexOf('--name') + 1], 'alpha')
})

test('ensure works without a name too', () => {
  const argv = ensureSessionArgv({ ...COMMON })
  assert.equal(argv.includes('--name'), false)
  assert.ok(argv.includes('ensure'))
})

test('the local listing is what carries names', () => {
  const argv = listSessionsArgv({ ...COMMON, useAcpList: false })
  assert.ok(argv.includes('--local'), 'names live in the local records')
})

test('sessions list can still be asked over ACP', () => {
  const argv = listSessionsArgv({ ...COMMON, useAcpList: true })
  assert.equal(argv.includes('--local'), false)
})

// --- grouping and row parsing ---

test('session rows expose the name needed to continue them', () => {
  const row = parseSessionRow('abc-123\talpha\t/tmp/work\t2026-09-29T17:54:50.576Z')
  assert.equal(row.sessionId, 'abc-123')
  assert.equal(row.name, 'alpha')
  assert.equal(row.cwd, '/tmp/work')
})

test('an unnamed session reports a null name rather than a dash', () => {
  const row = parseSessionRow('abc-123\t-\t/tmp/work\t-')
  assert.equal(row.name, null)
})

test('closed sessions remain discoverable', () => {
  const row = parseSessionRow('abc-123 [closed]\talpha\t/tmp/work\t2026-09-29T17:54:50.576Z')
  assert.equal(row.sessionId, 'abc-123')
  assert.equal(row.closed, true)
  assert.equal(row.name, 'alpha')
})

test('the ensure reply parses into id and created/existing', () => {
  for (const [line, expectedCreated] of [
    ['6016843e-0cca\t(created)', true],
    ['6016843e-0cca\t(existing)', false],
  ]) {
    const [id, note] = line.split('\t')
    assert.equal(id.trim(), '6016843e-0cca')
    assert.equal(note.includes('created'), expectedCreated)
  }
})

// --- merging and grouping (the workspace view) ---

test('a name from the local record is attached to the ACP row', () => {
  const acp = [{ sessionId: 's1', name: null, cwd: '/tmp/work', closed: false, lastUsedAt: null }]
  const local = [{ sessionId: 's1', name: 'alpha', cwd: '/tmp/work', closed: false, lastUsedAt: '2026-01-01' }]
  const [merged] = mergeSessionListings(acp, local)
  // The ACP row carries identity; the local row contributes the name, which is
  // the only thing that can be used to continue the session.
  assert.equal(merged.sessionId, 's1')
  assert.equal(merged.name, 'alpha')
})

test('ACP-only sessions survive the merge', () => {
  const acp = [
    { sessionId: 's1', name: null, cwd: '/a', closed: false, lastUsedAt: null },
    { sessionId: 's2', name: null, cwd: '/b', closed: false, lastUsedAt: null },
  ]
  const merged = mergeSessionListings(acp, [])
  assert.equal(merged.length, 2, 'sessions only the agent knows must still be listed')
})

test('locally-known sessions are kept even if the agent forgot them', () => {
  const local = [{ sessionId: 'old', name: 'legacy', cwd: '/c', closed: true, lastUsedAt: '2026-01-01' }]
  const merged = mergeSessionListings([], local)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].name, 'legacy')
})

test('an ACP name is never overwritten by a nameless local row', () => {
  const acp = [{ sessionId: 's1', name: 'keep-me', cwd: '/a', closed: false, lastUsedAt: null }]
  const local = [{ sessionId: 's1', name: null, cwd: '/a', closed: false, lastUsedAt: null }]
  const [merged] = mergeSessionListings(acp, local)
  assert.equal(merged.name, 'keep-me')
})

test('a missing cwd is filled in from the local record', () => {
  const acp = [{ sessionId: 's1', name: null, cwd: null, closed: false, lastUsedAt: null }]
  const local = [{ sessionId: 's1', name: null, cwd: '/found', closed: false, lastUsedAt: null }]
  const [merged] = mergeSessionListings(acp, local)
  assert.equal(merged.cwd, '/found')
})

test('sessions are grouped by cwd with recency ordering', () => {
  const sessions = [
    { sessionId: 'a1', name: null, cwd: '/x', closed: false, lastUsedAt: '2026-01-01' },
    { sessionId: 'a2', name: null, cwd: '/y', closed: false, lastUsedAt: '2026-06-01' },
    { sessionId: 'a3', name: 'named', cwd: '/x', closed: false, lastUsedAt: '2026-03-01' },
  ]
  const groups = groupByWorkspace(sessions)
  assert.equal(groups.length, 2)
  // /y was used most recently, so it leads.
  assert.equal(groups[0].cwd, '/y')
  const x = groups.find((g) => g.cwd === '/x')
  assert.equal(x.sessionCount, 2)
  assert.equal(x.namedCount, 1, 'named sessions are counted so callers can spot continuable ones')
  // Within a workspace, newest first.
  assert.equal(x.sessions[0].sessionId, 'a3')
})

test('one busy directory cannot bury the rest', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    sessionId: `s${i}`,
    name: null,
    cwd: '/tmp',
    closed: false,
    lastUsedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
  }))
  const groups = groupByWorkspace(many, { maxSessionsPerWorkspace: 5 })
  assert.equal(groups[0].sessionCount, 50, 'the true count is reported')
  assert.equal(groups[0].sessions.length, 5, 'but the listing is capped')
})

test('sessions with no cwd are grouped rather than dropped', () => {
  const groups = groupByWorkspace([
    { sessionId: 's1', name: null, cwd: null, closed: false, lastUsedAt: null },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].cwd, '(unknown)')
})

test('a workspace with recent activity leads', () => {
  const groups = groupByWorkspace([
    { sessionId: 'a', name: null, cwd: '/old', closed: false, lastUsedAt: '2026-01-01' },
    { sessionId: 'b', name: null, cwd: '/new', closed: false, lastUsedAt: '2026-09-01' },
    { sessionId: 'c', name: null, cwd: '/never', closed: false, lastUsedAt: null },
  ])
  assert.equal(groups[0].cwd, '/new')
  assert.equal(groups[1].cwd, '/old')
  // A workspace with no dates reported must sort last, not first.
  assert.equal(groups[2].cwd, '/never')
  assert.equal(groups[2].lastUsedAt, null, 'undated workspaces say so rather than faking a date')
})

test('undated workspaces order deterministically', () => {
  const build = () =>
    groupByWorkspace([
      { sessionId: 'z', name: null, cwd: '/zeta', closed: false, lastUsedAt: null },
      { sessionId: 'a', name: null, cwd: '/alpha', closed: false, lastUsedAt: null },
    ]).map((w) => w.cwd)
  // Two calls must agree, or a caller sees the list reshuffle for no reason.
  assert.deepEqual(build(), build())
  assert.deepEqual(build(), ['/alpha', '/zeta'])
})

test('the timestamp is taken from the local record when ACP omits it', () => {
  const acp = [{ sessionId: 's1', name: null, cwd: '/a', closed: false, lastUsedAt: null }]
  const local = [{ sessionId: 's1', name: null, cwd: '/a', closed: false, lastUsedAt: '2026-05-05' }]
  const [merged] = mergeSessionListings(acp, local)
  // Without this, ordering by recency silently degrades to nothing.
  assert.equal(merged.lastUsedAt, '2026-05-05')
})

// --- working-directory validation ---

import { createDispatch } from '../bridge/src/dispatch.mjs'
import { loadConfig } from '../bridge/src/config.mjs'
import { Ledger } from '../bridge/src/ledger.mjs'

/** A dispatcher that never actually runs an agent (all cases reject first). */
function validator() {
  const config = loadConfig({ ...process.env, DSH_BRIDGE_TOKEN: 'validation-token-0123456789' })
  return createDispatch(config, { ledger: null, log: () => {} })
}

test('a non-existent directory is rejected by name, not by a spawn error', async () => {
  const d = validator()
  // Without this check acpx fails with "Failed to spawn agent command", which
  // reads like a broken install and sends callers chasing PATH.
  await assert.rejects(
    () => d.sessionsList({ cwd: '/no/such/directory/xyz' }),
    (error) => error.code === 'bad-cwd' && error.message.includes('/no/such/directory/xyz'),
  )
})

test('a relative directory is rejected as a request error', async () => {
  const d = validator()
  await assert.rejects(
    () => d.sessionsList({ cwd: 'TMP' }),
    (error) => error.code === 'bad-request' && error.message.includes('absolute'),
  )
})

test('a file is not accepted as a working directory', async () => {
  const d = validator()
  await assert.rejects(
    () => d.sessionsList({ cwd: '/etc/hostname' }),
    (error) => error.code === 'bad-cwd' && error.message.includes('not a directory'),
  )
})

test('the same validation guards dispatch and prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cwd-guard-'))
  const ledger = await new Ledger({ path: join(dir, 'tasks.json') }).load()
  const config = loadConfig({ ...process.env, DSH_BRIDGE_TOKEN: 'validation-token-0123456789' })
  const d = createDispatch(config, { ledger, log: () => {} })
  try {
    // A caller passing a bad directory must be told before any work is queued.
    await assert.rejects(() => d.prompt({ cwd: 'nope', text: 'hi' }), /absolute|does not exist/)
    await assert.rejects(
      () => d.dispatch({ cwd: '/no/such/dir', text: 'hi', streamId: 's' }),
      (error) => error.code === 'bad-cwd',
    )
    // Nothing may have been recorded, since neither call should have queued.
    assert.equal(ledger.tasks.size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
