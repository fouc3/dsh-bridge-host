/**
 * Session titles.
 *
 * The agent's session listing carries only an opaque id, a working directory
 * and an optional name -- nothing that says what a conversation was about. A
 * chat asked "what sessions do I have here" cannot answer from a list of
 * UUIDs, and reporting anonymous sessions as a single "all unnamed" line makes
 * dozens of real conversations look like leftovers.
 *
 * The durable session log does record a title, so it is read from there.
 * Titles live in a zstd-compressed JSONL log under the deployment's session
 * root, which is `$DSH_HOME/sessions` by default.
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import { createInterface } from 'node:readline'

/** Default session root, matching how dsh lays out its durable logs. */
export function defaultSessionRoot(env = process.env) {
  const home = env.DSH_HOME || join(env.HOME || '', '.dsh')
  return home ? join(home, 'sessions') : null
}

/**
 * dsh encodes a working directory into a directory name, keeping it readable:
 * `/tmp/work` becomes `--tmp-work--`.
 */
export function encodeCwd(cwd) {
  return `--${cwd.replace(/^\/+/, '').replace(/\//g, '-')}--`
}

/**
 * Read the newest `session/title` entry from one session's log.
 *
 * Returns null when the session has no title, which is normal for a run that
 * never produced one. Only the tail is scanned: titles are recorded early and
 * a long log would otherwise be decompressed in full for every session.
 */
export async function readSessionTitle(sessionDir, { maxBytes = 256 * 1024 } = {}) {
  let files
  try {
    files = await readdir(sessionDir)
  } catch {
    return null
  }
  // The current format is `session.v4.jsonl.zstd`; older ones are tolerated.
  const candidates = files.filter((f) => f.startsWith('session') && f.includes('jsonl')).sort().reverse()
  if (candidates.length === 0) return null

  const path = join(sessionDir, candidates[0])
  let size
  try {
    size = (await stat(path)).size
  } catch {
    return null
  }
  if (size === 0) return null

  // Titles are written near the start; decompressing only the head keeps a
  // large log from dominating this call.
  const stream = createReadStream(path, { start: 0, end: Math.min(size, 2 * 1024 * 1024) - 1 })
    .pipe(createZstdDecompress())

  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let title = null
  let bytes = 0
  try {
    for await (const line of lines) {
      bytes += line.length
      if (bytes > maxBytes) break
      if (!line.includes('session/title')) continue
      try {
        const parsed = JSON.parse(line)
        const value = parsed?.data?.title
        // Keep the latest title: a provider-generated one supersedes the
        // placeholder that was recorded before the model answered.
        if (typeof value === 'string' && value.trim() !== '') title = value.trim()
      } catch {
        // A torn or partial line is not fatal; keep scanning.
      }
    }
  } catch {
    return title
  } finally {
    lines.close()
    stream.destroy()
  }
  return title
}

/**
 * Attach titles to a list of sessions.
 *
 * Titles are only sought for sessions under the given root, and lookups run
 * with a small concurrency so a large listing does not open hundreds of files
 * at once.
 */
export async function attachTitles(sessions, { sessionRoot, concurrency = 8, maxTitles = 40 } = {}) {
  if (!sessionRoot) return sessions
  const targets = sessions.slice(0, maxTitles)
  let cursor = 0

  async function worker() {
    while (cursor < targets.length) {
      const index = cursor
      cursor += 1
      const session = targets[index]
      if (!session?.cwd || !session?.sessionId) continue
      const dir = join(sessionRoot, encodeCwd(session.cwd), session.sessionId)
      session.title = await readSessionTitle(dir)
      // A session that never produced a title is not an error; leave it null.
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return sessions
}
