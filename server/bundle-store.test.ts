import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBundleStore } from './bundle-store.ts'
import { hashLearningSignal } from './bundles.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('SQLite bundle learning store', () => {
  it('supports an in-memory database without applying file permissions', () => {
    const store = createBundleStore(':memory:')
    store.record({
      anchorSignals: ['anchor'],
      candidateSignals: ['candidate'],
      label: 'merge',
      reason: 'In-memory example',
    })

    expect(store.examples()).toEqual([
      {
        anchorSignals: [hashLearningSignal('anchor')],
        candidateSignals: [hashLearningSignal('candidate')],
        correct: true,
        reason: 'Vom Nutzer im Review bestätigt.',
      },
    ])
    store.close()
  })

  it('restricts the database file to its owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-bundles-'))
    directories.push(directory)
    const store = createBundleStore(directory)

    expect(statSync(join(directory, 'bundle-learning.sqlite')).mode & 0o777).toBe(0o600)
    store.close()
  })

  it('hashes signals and replaces free-form reasons at the persistence boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-bundles-'))
    directories.push(directory)
    const databasePath = join(directory, 'bundle-learning.sqlite')
    const privateSignal = 'provider:Dr. Sensitive Person'
    const privateReason = 'Free-form private reason'
    const store = createBundleStore(directory)
    store.record({
      anchorSignals: [privateSignal, hashLearningSignal(privateSignal), '  '],
      candidateSignals: ['order:Private-123'],
      label: 'split',
      reason: privateReason,
    })
    expect(store.examples()).toEqual([
      {
        anchorSignals: [hashLearningSignal(privateSignal)],
        candidateSignals: [hashLearningSignal('order:Private-123')],
        correct: false,
        reason: 'Vom Nutzer im Review bestätigt.',
      },
    ])
    store.close()

    const databaseBytes = readFileSync(databasePath)
    expect(databaseBytes.includes(Buffer.from(privateSignal))).toBe(false)
    expect(databaseBytes.includes(Buffer.from(privateReason))).toBe(false)
  })

  it('migrates retained legacy signals and securely prunes old plaintext rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-bundles-'))
    directories.push(directory)
    const databasePath = join(directory, 'bundle-learning.sqlite')
    const forgottenSignal = `provider:forgotten-${'sensitive-marker-'.repeat(20)}`
    const retainedSignal = 'provider:Dr. Retained Person'
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE relationship_labels (
        id INTEGER PRIMARY KEY,
        anchor_signals TEXT NOT NULL,
        candidate_signals TEXT NOT NULL,
        label TEXT NOT NULL CHECK (label IN ('merge', 'split')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    const insert = legacy.prepare(`
      INSERT INTO relationship_labels(anchor_signals, candidate_signals, label, reason)
      VALUES (?, ?, 'merge', ?)
    `)
    legacy.exec('BEGIN')
    insert.run(
      JSON.stringify([forgottenSignal]),
      JSON.stringify(['thread:forgotten']),
      'old reason',
    )
    for (let index = 0; index < 1_000; index += 1) {
      insert.run(
        JSON.stringify([index === 999 ? retainedSignal : `provider:retained-${index}`]),
        JSON.stringify([`thread:retained-${index}`]),
        `legacy reason ${index}`,
      )
    }
    legacy.exec('COMMIT')
    legacy.close()

    const store = createBundleStore(directory)
    expect(store.examples()[0]).toEqual({
      anchorSignals: [hashLearningSignal(retainedSignal)],
      candidateSignals: [hashLearningSignal('thread:retained-999')],
      correct: true,
      reason: 'Vom Nutzer im Review bestätigt.',
    })
    store.close()

    const databaseBytes = readFileSync(databasePath)
    expect(databaseBytes.includes(Buffer.from(forgottenSignal))).toBe(false)
    expect(databaseBytes.includes(Buffer.from(retainedSignal))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('legacy reason'))).toBe(false)
  })
})
