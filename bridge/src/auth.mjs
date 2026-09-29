/**
 * Handshake authentication.
 *
 * The client must send exactly one newline-delimited JSON line before any
 * request is served. Comparison is constant-time so a wrong token cannot be
 * discovered by timing.
 */
import { timingSafeEqual } from 'node:crypto'

const MAX_HANDSHAKE_BYTES = 4096

/** Constant-time string comparison over UTF-8 bytes. */
function safeEqual(a, b) {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Validate one handshake line.
 *
 * @param {string} line raw line without its trailing newline
 * @param {string} expectedToken the configured shared token
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyHandshake(line, expectedToken) {
  if (line.length > MAX_HANDSHAKE_BYTES) {
    return { ok: false, reason: 'handshake-too-large' }
  }
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'handshake-not-json' }
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, reason: 'handshake-not-object' }
  }
  if (typeof message.token !== 'string') {
    return { ok: false, reason: 'handshake-token-missing' }
  }
  if (!safeEqual(message.token, expectedToken)) {
    return { ok: false, reason: 'handshake-token-mismatch' }
  }
  return { ok: true }
}

export { MAX_HANDSHAKE_BYTES }
