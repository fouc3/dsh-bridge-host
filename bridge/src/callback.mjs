/**
 * Callback delivery.
 *
 * When a dispatched task reaches a terminal state, the bridge reports it back
 * to the MaiBot plugin's listener so the bot can speak in its own voice. The
 * bridge never reports on its own behalf: it only delivers facts.
 *
 * Delivery is retried with exponential backoff. A task that exhausts retries
 * stays in the ledger with `notified: false`, so it is visible to
 * `task_list` and retried on the next bridge start rather than being lost.
 */

/** Statuses that are worth reporting back to the chat. */
export const NOTIFIABLE = new Set(['done', 'error'])

/**
 * POST one task outcome to the plugin.
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function postOnce(url, token, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      // Read a bounded slice so a chatty error page cannot balloon the log.
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      return { ok: false, status: response.status, error: detail }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    const reason = error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deliver a task outcome, retrying with exponential backoff.
 *
 * @param {object} options
 * @param {string} options.url        plugin endpoint
 * @param {string} options.token      shared token, sent as a Bearer credential
 * @param {object} options.payload    the task facts
 * @param {number} [options.retries]  retry count *after* the first attempt
 * @param {number} [options.baseDelayMs]
 * @param {(msg: string) => void} [options.log]
 */
export async function deliverCallback({
  url,
  token,
  payload,
  retries = 3,
  baseDelayMs = 1000,
  timeoutMs = 10_000,
  log = () => {},
  sleepFn = sleep,
}) {
  if (!url) {
    // No callback configured: the task still lives in the ledger, so it is
    // recoverable through task_status/task_list instead of being lost.
    return { ok: false, skipped: true, error: 'no callback url configured' }
  }

  let last = { ok: false, error: 'not attempted' }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await postOnce(url, token, payload, timeoutMs)
    if (last.ok) {
      log(`callback delivered for ${payload.taskId} (attempt ${attempt + 1})`)
      return { ...last, attempts: attempt + 1 }
    }
    log(`callback attempt ${attempt + 1} failed for ${payload.taskId}: ${last.error}`)
    if (attempt < retries) {
      // 1s, 4s, 16s: fast enough to land while the user is still looking.
      await sleepFn(baseDelayMs * 4 ** attempt)
    }
  }
  return { ...last, attempts: retries + 1 }
}

/** Shape the facts the plugin needs; never includes the raw prompt by default. */
export function buildCallbackPayload(task, { includePrompt = false } = {}) {
  const payload = {
    taskId: task.taskId,
    streamId: task.streamId,
    status: task.status,
    reply: task.reply,
    stopReason: task.stopReason,
    cwd: task.cwd,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  }
  if (includePrompt) payload.prompt = task.prompt
  return payload
}
