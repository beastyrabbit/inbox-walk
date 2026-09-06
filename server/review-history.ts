import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

export interface ReviewHistory {
  close(): void
  count(): number
  forget(emailIds: readonly string[]): void
  rememberKeptUnread(emailIds: readonly string[]): void
  retainedIds(): Set<string>
  retainedSnapshot(): Map<string, string>
  retainOnly(emailIds: ReadonlySet<string>, snapshot: ReadonlyMap<string, string>): void
}

export function reviewHistoryPath() {
  return join(process.env.DATA_DIR ?? resolve('data'), 'inbox-walk.sqlite')
}

export function createReviewHistory(databasePath = reviewHistoryPath()): ReviewHistory {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(databasePath)
  chmodSync(databasePath, 0o600)
  database.exec(`
    PRAGMA secure_delete = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kept_unread_email (
      email_id TEXT PRIMARY KEY,
      first_retained_at TEXT NOT NULL,
      last_retained_at TEXT NOT NULL,
      retain_count INTEGER NOT NULL DEFAULT 1 CHECK (retain_count > 0)
    ) STRICT;
  `)
  const legacyTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'viewed_email'")
    .get()
  if (legacyTable) {
    database.exec(`
      INSERT OR IGNORE INTO kept_unread_email (
        email_id,
        first_retained_at,
        last_retained_at,
        retain_count
      )
      SELECT email_id, first_viewed_at, last_viewed_at, view_count FROM viewed_email;
      DROP TABLE viewed_email;
    `)
  }
  // Existing databases acquire versions without rewriting retained decisions.
  const columns = database.prepare('PRAGMA table_info(kept_unread_email)').all()
  if (!columns.some((column) => column.name === 'revision')) {
    database.exec("ALTER TABLE kept_unread_email ADD COLUMN revision TEXT NOT NULL DEFAULT ''")
  }
  const record = database.prepare(`
    INSERT INTO kept_unread_email (
      email_id,
      first_retained_at,
      last_retained_at,
      retain_count,
      revision
    )
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(email_id) DO UPDATE SET
      last_retained_at = excluded.last_retained_at,
      retain_count = kept_unread_email.retain_count + 1,
      revision = excluded.revision
  `)
  const remove = database.prepare('DELETE FROM kept_unread_email WHERE email_id = ?')
  const list = database.prepare('SELECT email_id FROM kept_unread_email')
  const listVersions = database.prepare('SELECT email_id, revision FROM kept_unread_email')
  const removeVersion = database.prepare(
    'DELETE FROM kept_unread_email WHERE email_id = ? AND revision = ?',
  )
  const count = database.prepare('SELECT COUNT(*) AS count FROM kept_unread_email')

  const normalizedIds = (emailIds: readonly string[]) =>
    new Set(emailIds.map((id) => id.trim()).filter((id) => id && id.length <= 512))
  const readRetainedIds = () =>
    new Set((list.all() as Array<{ email_id: string }>).map((row) => row.email_id))
  const checkpointDeletedPages = () => {
    try {
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
        busy: number | bigint
        checkpointed: number | bigint
        log: number | bigint
      }
      if (Number(checkpoint.busy) !== 0) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'review_history_checkpoint_busy',
            checkpointed: Number(checkpoint.checkpointed),
            log: Number(checkpoint.log),
          })}\n`,
        )
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'review_history_checkpoint_failed',
          message: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      )
    }
  }

  return {
    close() {
      database.close()
    },
    count() {
      return Number((count.get() as { count: number | bigint }).count)
    },
    forget(emailIds: readonly string[]) {
      let removed = 0
      for (const emailId of normalizedIds(emailIds)) removed += Number(remove.run(emailId).changes)
      if (removed > 0) checkpointDeletedPages()
    },
    rememberKeptUnread(emailIds: readonly string[]) {
      const now = new Date().toISOString()
      for (const emailId of normalizedIds(emailIds)) record.run(emailId, now, now, randomUUID())
    },
    retainedIds() {
      return readRetainedIds()
    },
    retainedSnapshot() {
      return new Map(
        (listVersions.all() as Array<{ email_id: string; revision: string }>).map((row) => [
          row.email_id,
          row.revision,
        ]),
      )
    },
    retainOnly(emailIds: ReadonlySet<string>, snapshot: ReadonlyMap<string, string>) {
      const retained = normalizedIds([...emailIds])
      let removed = 0
      for (const [emailId, revision] of snapshot) {
        if (!retained.has(emailId)) removed += Number(removeVersion.run(emailId, revision).changes)
      }
      if (removed > 0) checkpointDeletedPages()
    },
  }
}
