/**
 * Auth unit tests: no network, no agent. Covers the rejection paths that keep
 * an unauthenticated caller away from a command-running agent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyHandshake, MAX_HANDSHAKE_BYTES } from '../bridge/src/auth.mjs'

const TOKEN = 'correct-horse-battery-staple-0123456789'

test('accepts the correct token', () => {
  assert.deepEqual(verifyHandshake(JSON.stringify({ token: TOKEN }), TOKEN), { ok: true })
})

test('rejects a wrong token', () => {
  const verdict = verifyHandshake(JSON.stringify({ token: 'wrong-token-value-here' }), TOKEN)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'handshake-token-mismatch')
})

test('rejects a token that is a prefix of the real one', () => {
  // Guards against an implementation that compares only the shorter length.
  const verdict = verifyHandshake(JSON.stringify({ token: TOKEN.slice(0, 10) }), TOKEN)
  assert.equal(verdict.ok, false)
})

test('rejects a missing token field', () => {
  assert.equal(verifyHandshake(JSON.stringify({ hello: 'world' }), TOKEN).ok, false)
  assert.equal(verifyHandshake(JSON.stringify({ token: 123 }), TOKEN).ok, false)
})

test('rejects non-JSON and non-object handshakes', () => {
  assert.equal(verifyHandshake('not json at all', TOKEN).reason, 'handshake-not-json')
  assert.equal(verifyHandshake('["array"]', TOKEN).reason, 'handshake-not-object')
  assert.equal(verifyHandshake('null', TOKEN).reason, 'handshake-not-object')
})

test('rejects an oversized handshake line', () => {
  const huge = JSON.stringify({ token: TOKEN, pad: 'x'.repeat(MAX_HANDSHAKE_BYTES + 10) })
  assert.equal(verifyHandshake(huge, TOKEN).reason, 'handshake-too-large')
})
