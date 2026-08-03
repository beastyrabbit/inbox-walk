import { chmodSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

export interface ReviewHistory {
  close(): void
  count(): number
  recordViewed(emailId: string): void
  viewedIds(): Set<string>
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
    CREATE TABLE IF NOT EXISTS viewed_email (
      email_id TEXT PRIMARY KEY,
      first_viewed_at TEXT NOT NULL,
      last_viewed_at TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 1 CHECK (view_count > 0)
    ) STRICT;
  `)
  const record = database.prepare(`
    INSERT INTO viewed_email (email_id, first_viewed_at, last_viewed_at, view_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(email_id) DO UPDATE SET
      last_viewed_at = excluded.last_viewed_at,
      view_count = viewed_email.view_count + 1
  `)
  const list = database.prepare('SELECT email_id FROM viewed_email')
  const count = database.prepare('SELECT COUNT(*) AS count FROM viewed_email')

  return {
    close() {
      database.close()
    },
    count() {
      return Number((count.get() as { count: number | bigint }).count)
    },
    recordViewed(emailId: string) {
      const normalized = emailId.trim()
      if (!normalized || normalized.length > 512) return
      const now = new Date().toISOString()
      record.run(normalized, now, now)
    },
    viewedIds() {
      return new Set((list.all() as Array<{ email_id: string }>).map((row) => row.email_id))
    },
  }
}
