import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReviewHistory } from './review-history.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('SQLite review history', () => {
  it('persists viewed IDs without storing message content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-history-'))
    directories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const history = createReviewHistory(databasePath)
    history.recordViewed('mail-1')
    history.recordViewed('mail-1')
    history.recordViewed('mail-2')
    expect(history.count()).toBe(2)
    expect(history.viewedIds()).toEqual(new Set(['mail-1', 'mail-2']))
    history.close()

    const reopened = createReviewHistory(databasePath)
    expect(reopened.viewedIds()).toEqual(new Set(['mail-1', 'mail-2']))
    reopened.close()
  })

  it('ignores empty or implausibly large IDs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-history-'))
    directories.push(directory)
    const history = createReviewHistory(join(directory, 'history.sqlite'))
    history.recordViewed('  ')
    history.recordViewed('x'.repeat(513))
    expect(history.count()).toBe(0)
    history.close()
  })
})
