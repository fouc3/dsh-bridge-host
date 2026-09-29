/**
 * Outcome classification.
 *
 * A dispatched job ends in exactly one of two ways:
 *
 *   - `done`  — the agent stopped and left text behind. Whether that text is a
 *               finished answer or a question for the user is *not* decided
 *               here: the chat reads the full text and knows from context which
 *               one it is. Guessing from punctuation here would be strictly
 *               worse, because this layer cannot see the conversation.
 *   - `error` — no usable answer exists (the run threw, returned nothing, or
 *               stopped abnormally). The chat needs to be told this is a
 *               failure rather than a result, since there is nothing to read.
 *
 * Deliberately no third state: an agent that pauses to ask something has still
 * finished its turn, so it is indistinguishable from completion at this layer.
 */
import { TaskStatus } from './ledger.mjs'

/** ACP stop reasons that mean the turn ended normally. */
const NORMAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence'])

/**
 * Classify one finished prompt.
 *
 * @param {object} result
 * @param {string} result.reply       accumulated assistant text
 * @param {string} result.stopReason  ACP stop reason, if any
 * @param {Error|null} [result.error] thrown failure, if any
 * @returns {{status: string, reason: string}} status plus why it was chosen
 */
export function classifyOutcome({ reply, stopReason, error = null }) {
  if (error) {
    return { status: TaskStatus.ERROR, reason: `threw: ${error.message}` }
  }
  if (stopReason && !NORMAL_STOP_REASONS.has(stopReason)) {
    // Truncation or refusal: surface as a failure so the user learns about it
    // instead of assuming the work succeeded.
    return { status: TaskStatus.ERROR, reason: `unexpected stopReason=${stopReason}` }
  }
  const text = typeof reply === 'string' ? reply.trim() : ''
  if (text === '') {
    return { status: TaskStatus.ERROR, reason: 'agent produced no text' }
  }
  return { status: TaskStatus.DONE, reason: stopReason ? `stopReason=${stopReason}` : 'completed' }
}
