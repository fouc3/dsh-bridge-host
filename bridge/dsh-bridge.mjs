#!/usr/bin/env node
/**
 * dsh-bridge entry point.
 *
 * Starts the token-gated relay that lets a container reach DeepSeek Harness
 * over ACP. Configuration is environment-only; see src/config.mjs.
 */
import { loadConfig } from './src/config.mjs'
import { createDispatch } from './src/dispatch.mjs'
import { startBridge } from './src/server.mjs'
import { Ledger, defaultLedgerPath } from './src/ledger.mjs'

/** Timestamped line logger; never logs payload contents. */
function log(message) {
  process.stdout.write(`${new Date().toISOString()} dsh-bridge: ${message}\n`)
}

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    process.stderr.write(`dsh-bridge: ${error.message}\n`)
    process.exit(2)
  }

  const ledger = await new Ledger({
    path: config.ledgerPath || defaultLedgerPath(),
    ttlHours: config.taskTtlHours,
    maxTasks: config.taskMax,
  }).load()
  log(`ledger: ${ledger.path} (${ledger.tasks.size} tasks)`)

  const dispatch = createDispatch(config, { ledger, log })
  const bridge = await startBridge(config, dispatch, { log })

  log(`listening on ${config.host}:${bridge.port}`)
  log(`agent command: ${config.agentCommand}`)
  log(`concurrency ${config.maxConcurrency}, request timeout ${config.requestTimeoutMs}ms`)
  log(config.callbackUrl ? `callbacks -> ${config.callbackUrl}` : 'callbacks disabled (no DSH_BRIDGE_CALLBACK_URL)')

  // A report that never landed (bridge down, plugin down) is retried now, so a
  // restart is enough to repair a missed notification.
  if (config.callbackUrl) {
    dispatch
      .replayPending()
      .then(({ attempted, delivered }) => {
        if (attempted > 0) log(`replayed ${delivered}/${attempted} pending callbacks`)
      })
      .catch((error) => log(`callback replay failed: ${error.message}`))
  }

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`received ${signal}, draining background tasks`)
    await bridge.close()
    // Let in-flight dispatches finish and report, so a restart does not orphan
    // work the user is still waiting on.
    await dispatch.drain().catch(() => {})
    log('shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

await main()
