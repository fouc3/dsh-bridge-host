/**
 * Bridge configuration.
 *
 * Every value comes from the environment so the daemon itself stays a static
 * artifact. The shared token is deliberately environment-only: it must never be
 * written to disk or committed.
 */

/** Default listen address in the maim-bot bridge network (see docs/deployment.md). */
export const DEFAULT_HOST = '172.24.0.1'
export const DEFAULT_PORT = 13081

/**
 * The ACP agent command acpx spawns.
 *
 * This string is acpx's session scope key: two different strings are two
 * different session stores even when they run the same binary. Keep it stable
 * across upgrades or saved conversations stop resolving.
 */
export const DEFAULT_AGENT_COMMAND = 'dsh --profile acp'

function intFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Resolve the effective configuration, failing loudly on an unusable token.
 *
 * A missing token is a hard error rather than a warning: an unauthenticated
 * bridge would expose an agent that can run arbitrary commands.
 */
export function loadConfig(env = process.env) {
  const token = env.DSH_BRIDGE_TOKEN ?? ''
  if (token.length < 16) {
    throw new Error(
      'DSH_BRIDGE_TOKEN is missing or too short (need >= 16 chars). ' +
        'Generate one with: openssl rand -hex 32',
    )
  }

  return {
    host: env.DSH_BRIDGE_HOST || DEFAULT_HOST,
    port: intFromEnv('DSH_BRIDGE_PORT', DEFAULT_PORT),
    token,
    agentCommand: env.DSH_BRIDGE_AGENT || DEFAULT_AGENT_COMMAND,
    /** Concurrent acpx child processes. */
    maxConcurrency: intFromEnv('DSH_BRIDGE_MAX_CONCURRENCY', 4),
    /** Hard ceiling for one request, passed to acpx as --timeout (seconds). */
    requestTimeoutMs: intFromEnv('DSH_BRIDGE_TIMEOUT_MS', 600_000),
    /** How long a new connection has to complete its handshake. */
    handshakeTimeoutMs: intFromEnv('DSH_BRIDGE_HANDSHAKE_TIMEOUT_MS', 5_000),
    /** Cap on captured child output, guarding against a runaway response. */
    maxOutputBytes: intFromEnv('DSH_BRIDGE_MAX_OUTPUT_BYTES', 8 * 1024 * 1024),
    /** Path to the acpx executable; defaults to the one installed beside the bridge. */
    acpxPath: env.DSH_BRIDGE_ACPX || new URL('../node_modules/.bin/acpx', import.meta.url).pathname,
    /** Where async task outcomes are reported; empty disables callback delivery. */
    callbackUrl: env.DSH_BRIDGE_CALLBACK_URL || '',
    /** Retries after the first failed callback attempt. */
    callbackRetries: intFromEnv('DSH_BRIDGE_CALLBACK_RETRIES', 3),
    /** Ledger file holding dispatched tasks; safe to delete. */
    ledgerPath: env.DSH_BRIDGE_LEDGER || undefined,
    /** Hours to retain finished tasks. */
    taskTtlHours: intFromEnv('DSH_BRIDGE_TASK_TTL_H', 72),
    /** Hard cap on retained tasks. */
    taskMax: intFromEnv('DSH_BRIDGE_TASK_MAX', 200),
  }
}
