import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { BundleExample } from './bundles.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

export type BundleLabel = 'merge' | 'split'

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

export function createBundleStore(
  dataDir = process.env.DATA_DIR ?? path.resolve('data'),
): BundleStore {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(path.join(dataDir, 'bundle-learning.sqlite'))
  database.exec(`
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
        JSON.stringify([...new Set(label.anchorSignals)].slice(0, 100)),
        JSON.stringify([...new Set(label.candidateSignals)].slice(0, 100)),
        label.label,
        label.reason.slice(0, 2_000),
      )
      prune.run()
    },
  }
}
