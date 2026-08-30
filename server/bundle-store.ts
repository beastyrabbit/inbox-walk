import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { type BundleExample, hashLearningSignal } from './bundles.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

export type BundleLabel = 'merge' | 'split'

const REVIEW_CONFIRMED_REASON = 'Vom Nutzer im Review bestätigt.'

export interface BundleRelationshipLabel {
  anchorSignals: string[]
  candidateSignals: string[]
  label: BundleLabel
  reason: string
}

export interface BundleStore {
  close(): void
  examples(): BundleExample[]
  record(label: BundleRelationshipLabel): void
}

function normalizedSignals(signals: readonly unknown[]) {
  return [
    ...new Set(
      signals
        .filter((signal): signal is string => typeof signal === 'string' && Boolean(signal.trim()))
        .map(hashLearningSignal),
    ),
  ].slice(0, 100)
}

function parseSignals(value: string) {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new TypeError('Stored bundle signals must be an array.')
  return normalizedSignals(parsed)
}

export function createBundleStore(
  dataDir = process.env.DATA_DIR ?? path.resolve('data'),
): BundleStore {
  const inMemory = dataDir === ':memory:'
  if (!inMemory) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const databasePath = inMemory ? ':memory:' : path.join(dataDir, 'bundle-learning.sqlite')
  const database = new DatabaseSync(databasePath)
  if (!inMemory) fs.chmodSync(databasePath, 0o600)
  database.exec(`
    PRAGMA secure_delete = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS relationship_labels (
      id INTEGER PRIMARY KEY,
      anchor_signals TEXT NOT NULL,
      candidate_signals TEXT NOT NULL,
      label TEXT NOT NULL CHECK (label IN ('merge', 'split')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const insert = database.prepare(`
    INSERT INTO relationship_labels(anchor_signals, candidate_signals, label, reason)
    VALUES (?, ?, ?, ?)
  `)
  const prune = database.prepare(`
    DELETE FROM relationship_labels
    WHERE id NOT IN (SELECT id FROM relationship_labels ORDER BY id DESC LIMIT 1000)
  `)
  const selectForMigration = database.prepare(`
    SELECT id, anchor_signals, candidate_signals, label, reason, created_at
    FROM relationship_labels
    ORDER BY id DESC
  `)
  const deleteAll = database.prepare('DELETE FROM relationship_labels')
  const insertMigrated = database.prepare(`
    INSERT INTO relationship_labels(
      id, anchor_signals, candidate_signals, label, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  const checkpointDeletedPages = () => {
    if (inMemory) return
    try {
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
        busy: number | bigint
        checkpointed: number | bigint
        log: number | bigint
      }
      if (Number(checkpoint.busy) !== 0) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'bundle_store_checkpoint_busy',
            checkpointed: Number(checkpoint.checkpointed),
            log: Number(checkpoint.log),
          })}\n`,
        )
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'bundle_store_checkpoint_failed',
          message: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      )
    }
  }
  const migrateStoredLabels = () => {
    const rows = selectForMigration.all() as Array<{
      anchor_signals: string
      candidate_signals: string
      created_at: string
      id: number | bigint
      label: BundleLabel
      reason: string
    }>
    let changed = rows.length > 1_000
    const migrated = rows.slice(0, 1_000).flatMap((row) => {
      try {
        const anchorSignals = JSON.stringify(parseSignals(row.anchor_signals))
        const candidateSignals = JSON.stringify(parseSignals(row.candidate_signals))
        changed ||=
          anchorSignals !== row.anchor_signals ||
          candidateSignals !== row.candidate_signals ||
          row.reason !== REVIEW_CONFIRMED_REASON
        return [{ ...row, anchorSignals, candidateSignals }]
      } catch {
        changed = true
        return []
      }
    })
    if (!changed) return
    database.exec('BEGIN IMMEDIATE')
    try {
      deleteAll.run()
      for (const row of migrated) {
        insertMigrated.run(
          row.id,
          row.anchorSignals,
          row.candidateSignals,
          row.label,
          REVIEW_CONFIRMED_REASON,
          row.created_at,
        )
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    if (!inMemory) database.exec('VACUUM')
    checkpointDeletedPages()
  }
  migrateStoredLabels()
  const select = database.prepare(`
    SELECT anchor_signals, candidate_signals, label, reason
    FROM relationship_labels
    ORDER BY id DESC
    LIMIT 100
  `)
  return {
    close: () => database.close(),
    examples: () =>
      (
        select.all() as Array<{
          anchor_signals: string
          candidate_signals: string
          label: BundleLabel
          reason: string
        }>
      ).map((row) => ({
        anchorSignals: JSON.parse(row.anchor_signals) as string[],
        candidateSignals: JSON.parse(row.candidate_signals) as string[],
        correct: row.label === 'merge',
        reason: row.reason,
      })),
    record: (label) => {
      insert.run(
        JSON.stringify(normalizedSignals(label.anchorSignals)),
        JSON.stringify(normalizedSignals(label.candidateSignals)),
        label.label,
        REVIEW_CONFIRMED_REASON,
      )
      if (Number(prune.run().changes) > 0) checkpointDeletedPages()
    },
  }
}
