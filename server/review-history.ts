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
  retainOnly(emailIds: ReadonlySet<string>): void
}

export function reviewHistoryPath() {
  return join(process.env.DATA_DIR ?? resolve('data'), 'inbox-walk.sqlite')
}

export function createReviewHistory(databasePath = reviewHistoryPath()): ReviewHistory {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(databasePath)
  chmodSync(databasePath, 0o600)
  database.exec(`
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
  const record = database.prepare(`
    INSERT INTO kept_unread_email (
      email_id,
      first_retained_at,
      last_retained_at,
      retain_count
    )
    VALUES (?, ?, ?, 1)
    ON CONFLICT(email_id) DO UPDATE SET
      last_retained_at = excluded.last_retained_at,
      retain_count = kept_unread_email.retain_count + 1
  `)
  const remove = database.prepare('DELETE FROM kept_unread_email WHERE email_id = ?')
  const list = database.prepare('SELECT email_id FROM kept_unread_email')
  const count = database.prepare('SELECT COUNT(*) AS count FROM kept_unread_email')

  const normalizedIds = (emailIds: readonly string[]) =>
    new Set(emailIds.map((id) => id.trim()).filter((id) => id && id.length <= 512))
  const readRetainedIds = () =>
    new Set((list.all() as Array<{ email_id: string }>).map((row) => row.email_id))

  return {
    close() {
      database.close()
    },
    count() {
      return Number((count.get() as { count: number | bigint }).count)
    },
    forget(emailIds: readonly string[]) {
      for (const emailId of normalizedIds(emailIds)) remove.run(emailId)
    },
    rememberKeptUnread(emailIds: readonly string[]) {
      const now = new Date().toISOString()
      for (const emailId of normalizedIds(emailIds)) record.run(emailId, now, now)
    },
    retainedIds() {
      return readRetainedIds()
    },
    retainOnly(emailIds: ReadonlySet<string>) {
      const retained = normalizedIds([...emailIds])
      for (const emailId of readRetainedIds()) {
        if (!retained.has(emailId)) remove.run(emailId)
      }
    },
  }
}
