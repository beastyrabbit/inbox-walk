import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReviewHistory } from './review-history.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('SQLite review history', () => {
  it('persists only deliberately retained unread IDs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-history-'))
    directories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const history = createReviewHistory(databasePath)
    history.rememberKeptUnread(['mail-1', 'mail-1', 'mail-2'])
    expect(history.count()).toBe(2)
    expect(history.retainedIds()).toEqual(new Set(['mail-1', 'mail-2']))
    history.forget(['mail-2'])
    history.close()

    const reopened = createReviewHistory(databasePath)
    expect(reopened.retainedIds()).toEqual(new Set(['mail-1']))
    reopened.close()
  })

  it('ignores empty or implausibly large IDs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-history-'))
    directories.push(directory)
    const history = createReviewHistory(join(directory, 'history.sqlite'))
    history.rememberKeptUnread(['  ', 'x'.repeat(513)])
    expect(history.count()).toBe(0)
    history.close()
  })

  it('migrates legacy viewed candidates and can retain only messages that are still unread', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-history-'))
    directories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE viewed_email (
        email_id TEXT PRIMARY KEY,
        first_viewed_at TEXT NOT NULL,
        last_viewed_at TEXT NOT NULL,
        view_count INTEGER NOT NULL
      );
      INSERT INTO viewed_email VALUES
        ('still-unread', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 1),
        ('now-read', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 2);
    `)
    legacy.close()

    const history = createReviewHistory(databasePath)
    expect(history.retainedIds()).toEqual(new Set(['still-unread', 'now-read']))
    history.retainOnly(new Set(['still-unread']))
    expect(history.retainedIds()).toEqual(new Set(['still-unread']))
    history.close()
  })
})
