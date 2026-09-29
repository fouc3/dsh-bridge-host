/**
 * Frame-folding tests. Uses recorded ACP frames from a real
 * `dsh --profile acp` turn so the parser is checked against actual wire data.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldFrames, parseFrames, parseSessionRow } from '../bridge/src/acpx.mjs'

/** A trimmed transcript captured from a real acpx -> dsh run. */
const TRANSCRIPT = [
  '{"jsonrpc":"2.0","id":1,"method":"session/resume","params":{"sessionId":"5796d97f"}}',
  '{"jsonrpc":"2.0","id":1,"result":{"configOptions":[]}}',
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"5796d97f","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"连接"}}}}',
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"5796d97f","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"成功"}}}}',
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"5796d97f","update":{"sessionUpdate":"tool_call","toolCallId":"t1"}}}',
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"5796d97f","update":{"sessionUpdate":"usage_update","used":9834,"size":1000000}}}',
  '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
].join('\n')

test('joins assistant chunks across multiple notifications', () => {
  const folded = foldFrames(parseFrames(TRANSCRIPT))
  assert.equal(folded.text, '连接成功')
  assert.equal(folded.stopReason, 'end_turn')
  assert.equal(folded.sessionId, '5796d97f')
})

test('counts tool calls and surfaces usage', () => {
  const folded = foldFrames(parseFrames(TRANSCRIPT))
  assert.equal(folded.toolCalls, 1)
  assert.deepEqual(folded.usage, { used: 9834, size: 1000000 })
})

test('ignores non-JSON noise and blank lines', () => {
  const noisy = `[acpx] agent starting\n\n${TRANSCRIPT}\n[acpx] done\n`
  const folded = foldFrames(parseFrames(noisy))
  assert.equal(folded.text, '连接成功')
})

test('returns empty text when the agent answers nothing', () => {
  const folded = foldFrames(parseFrames('{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'))
  assert.equal(folded.text, '')
  assert.equal(folded.stopReason, 'end_turn')
})

test('tolerates chunk content that is not text', () => {
  const frames = parseFrames(
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"image"}}}}',
  )
  assert.equal(foldFrames(frames).text, '')
})

// --- session row parsing (formats captured from a real acpx run) ---

test('parses an ACP list row', () => {
  const row = parseSessionRow('3a0e014f-6fb6-4bfc-9805-9bc6386524a2\t-\t/tmp\t-\t-')
  assert.equal(row.sessionId, '3a0e014f-6fb6-4bfc-9805-9bc6386524a2')
  assert.equal(row.name, null)
  assert.equal(row.cwd, '/tmp')
  assert.equal(row.closed, false)
})

test('parses a --local row with a timestamp', () => {
  const row = parseSessionRow('5796d97f-603d-46cc-85f8-57154f99bbb7\t-\t/tmp\t2026-09-29T14:27:34.377Z')
  assert.equal(row.sessionId, '5796d97f-603d-46cc-85f8-57154f99bbb7')
  assert.equal(row.lastUsedAt, '2026-09-29T14:27:34.377Z')
})

test('strips the [closed] marker so the id stays usable', () => {
  const row = parseSessionRow('5796d97f-603d-46cc-85f8-57154f99bbb7 [closed]\t-\t/tmp\t2026-09-29T14:27:34.377Z')
  assert.equal(row.sessionId, '5796d97f-603d-46cc-85f8-57154f99bbb7')
  assert.equal(row.closed, true)
})

test('strips the "(replaced ...)" note from a new-session line', () => {
  const row = parseSessionRow('1879dc13-9ec9-4519-b64a-56f3fcd7c047\t(replaced 3a0e014f-6fb6-4bfc-9805-9bc6386524a2)')
  assert.equal(row.sessionId, '1879dc13-9ec9-4519-b64a-56f3fcd7c047')
})

test('ignores blank and malformed rows', () => {
  assert.equal(parseSessionRow(''), null)
  assert.equal(parseSessionRow('   '), null)
  assert.equal(parseSessionRow('just-one-column'), null)
})
