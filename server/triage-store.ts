import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import {
  type BundleKind,
  type ReplyEditorState,
  type ReviewEmailSummary,
  TRIAGE_MEMORY_MAX_LENGTH,
  type TriageBucket,
  type TriageMemory,
  type TriageMessage,
  type TriageMessageStatus,
} from '../src/shared.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const BUCKET_KINDS = new Set<BundleKind>([
  'conversation',
  'development_workstream',
  'incident',
  'order_delivery',
  'standalone',
])
const HANDLED_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const MAX_EVENTS = 5_000
const MAX_PROPOSALS = 50

export interface TriageBucketMetadata {
  currentState: string
  kind: BundleKind
  linkEvidence: string[]
  summary: string
  title: string
}

export type TriageBucketPatch = Partial<TriageBucketMetadata>

/** A bucket with every member, including handled ones, for sorting context. */
export interface TriageBucketRecord extends TriageBucketMetadata {
  activityAt: string
  bucketId: string
  members: TriageMessage[]
  open: boolean
}

export interface TriageRunState {
  lastPollAt: string | null
  lastPollError: string | null
  lastSortAt: string | null
  lastSortError: string | null
}

export class TriageStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'UNKNOWN_BUCKET' | 'UNKNOWN_EMAIL' | 'INVALID_BUCKET' | 'EMAIL_NOT_SORTABLE',
  ) {
    super(message)
    this.name = 'TriageStoreError'
  }
}

export interface TriageStore {
  acceptProposal(id: string): TriageMemory | null
  addProposal(note: string): void
  addToBucket(bucketId: string, emailIds: readonly string[], patch?: TriageBucketPatch): void
  bucket(bucketId: string): TriageBucketRecord | null
  /** Buckets that are open or had activity since the cutoff, newest first. */
  buckets(activeSince: string, limit: number): TriageBucketRecord[]
  close(): void
  createBucket(metadata: TriageBucketMetadata, emailIds: readonly string[]): string
  /** Adds new unread messages and re-queues handled ones that are unread again. */
  enqueue(summaries: readonly ReviewEmailSummary[]): number
  logEvent(kind: string, detail: Record<string, unknown>): void
  markDone(emailIds: readonly string[]): void
  /** Messages that left the unread set without an action in this app. */
  markGone(emailIds: readonly string[]): void
  memory(): TriageMemory
  mergeBuckets(sourceBucketId: string, targetBucketId: string): void
  message(emailId: string): TriageMessage | null
  park(emailIds: readonly string[]): void
  parked(): TriageMessage[]
  prune(now?: number): void
  /** Counts queued messages that still retry automatically and those that stopped. */
  queueCounts(maxAttempts: number): { failed: number; queued: number }
  /** Queued messages below the retry limit, oldest first. */
  queued(limit: number, maxAttempts: number): TriageMessage[]
  recordAttempt(emailIds: readonly string[], error: string): void
  recordPoll(at: string, error: string | null): void
  recordSort(at: string, error: string | null): void
  rejectProposal(id: string): void
  replyEditor(emailId: string): ReplyEditorState | null
  resetAttempts(emailIds: readonly string[]): void
  runState(): TriageRunState
  saveReplyEditor(emailId: string, editor: ReplyEditorState): void
  setMemoryNotes(notes: string): TriageMemory
  todo(): TriageBucket[]
  tokens(): { csrfToken: string; imageToken: string }
  /** Removes every message, bucket, editor and proposal; keeps tokens and notes. */
  reset(): void
  /** Every message still expected to be unread: queued, sorted and parked. */
  trackedIds(): Map<string, TriageMessageStatus>
  unpark(emailIds: readonly string[]): void
  updateBucket(bucketId: string, patch: TriageBucketPatch): void
}

/** A poll that started before an action finished must not re-queue its message. */
const REQUEUE_GRACE_MS = 2 * 60_000

interface MessageRow {
  updated_at: string
  attempts: number | bigint
  bucket_id: string | null
  email_id: string
  last_error: string | null
  status: TriageMessageStatus
  summary_json: string
}

interface BucketRow {
  activity_at: string
  bucket_id: string
  current_state: string
  kind: BundleKind
  link_evidence_json: string
  status: 'open' | 'closed'
  summary: string
  title: string
}

export function triageStorePath() {
  return join(process.env.DATA_DIR ?? resolve('data'), 'inbox-walk.sqlite')
}

function bounded(value: unknown, maximum: number, label: string) {
  if (typeof value !== 'string')
    throw new TriageStoreError(`${label} must be text.`, 'INVALID_BUCKET')
  const trimmed = value.trim()
  if (!trimmed) throw new TriageStoreError(`${label} must not be empty.`, 'INVALID_BUCKET')
  return trimmed.slice(0, maximum)
}

function cleanMetadata(metadata: TriageBucketMetadata): TriageBucketMetadata {
  if (!BUCKET_KINDS.has(metadata.kind)) {
    throw new TriageStoreError('Bucket kind is invalid.', 'INVALID_BUCKET')
  }
  return {
    currentState: bounded(metadata.currentState, 500, 'Bucket state'),
    kind: metadata.kind,
    linkEvidence: cleanEvidence(metadata.linkEvidence),
    summary: bounded(metadata.summary, 4_000, 'Bucket summary'),
    title: bounded(metadata.title, 500, 'Bucket title'),
  }
}

function cleanEvidence(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 500))
    .slice(0, 50)
}

function toMessage(row: MessageRow): TriageMessage {
  return {
    attempts: Number(row.attempts),
    bucketId: row.bucket_id,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    status: row.status,
    summary: JSON.parse(row.summary_json) as ReviewEmailSummary,
  }
}

function byReceivedAt(left: TriageMessage, right: TriageMessage) {
  return Date.parse(left.summary.receivedAt) - Date.parse(right.summary.receivedAt)
}

export function createTriageStore(databasePath = triageStorePath()): TriageStore {
  const inMemory = databasePath === ':memory:'
  if (!inMemory) mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(databasePath)
  if (!inMemory) chmodSync(databasePath, 0o600)
  database.exec(`
    PRAGMA secure_delete = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS triage_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      csrf_token TEXT NOT NULL,
      image_token TEXT NOT NULL,
      memory_notes TEXT NOT NULL DEFAULT '',
      last_poll_at TEXT,
      last_poll_error TEXT,
      last_sort_at TEXT,
      last_sort_error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS triage_bucket (
      bucket_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_state TEXT NOT NULL,
      summary TEXT NOT NULL,
      link_evidence_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      created_at TEXT NOT NULL,
      activity_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS triage_message (
      email_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'sorted', 'parked', 'done', 'gone')),
      bucket_id TEXT REFERENCES triage_bucket(bucket_id) ON DELETE SET NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS triage_message_status ON triage_message(status, received_at);
    CREATE INDEX IF NOT EXISTS triage_message_bucket ON triage_message(bucket_id);
    CREATE TABLE IF NOT EXISTS triage_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS triage_memory_proposal (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS triage_reply_editor (
      email_id TEXT PRIMARY KEY,
      editor_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    -- Review rounds and the kept-unread history were replaced by the todo.
    DROP TABLE IF EXISTS review_round_bundle_decision;
    DROP TABLE IF EXISTS review_round_finalization;
    DROP TABLE IF EXISTS review_round_user_state;
    DROP TABLE IF EXISTS review_bundle_run;
    DROP TABLE IF EXISTS review_round_message;
    DROP TABLE IF EXISTS review_round;
    DROP TABLE IF EXISTS inbox_walk_round_store_schema;
    DROP TABLE IF EXISTS kept_unread_email;
  `)
  database
    .prepare(
      'INSERT OR IGNORE INTO triage_state (singleton, csrf_token, image_token) VALUES (1, ?, ?)',
    )
    .run(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'))

  const selectState = database.prepare('SELECT * FROM triage_state WHERE singleton = 1')
  const selectMessage = database.prepare('SELECT * FROM triage_message WHERE email_id = ?')
  const selectTracked = database.prepare(
    "SELECT email_id, status FROM triage_message WHERE status IN ('queued', 'sorted', 'parked')",
  )
  const selectQueued = database.prepare(`
    SELECT * FROM triage_message
    WHERE status = 'queued' AND attempts < ?
    ORDER BY received_at, email_id
    LIMIT ?
  `)
  const countQueued = database.prepare(`
    SELECT
      SUM(CASE WHEN attempts < ? THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS failed
    FROM triage_message WHERE status = 'queued'
  `)
  const selectAllQueued = database.prepare(
    "SELECT * FROM triage_message WHERE status = 'queued' ORDER BY received_at DESC, email_id",
  )
  const selectParked = database.prepare(
    "SELECT * FROM triage_message WHERE status = 'parked' ORDER BY received_at DESC, email_id",
  )
  const selectMembers = database.prepare(
    'SELECT * FROM triage_message WHERE bucket_id = ? ORDER BY received_at, email_id',
  )
  const selectBucket = database.prepare('SELECT * FROM triage_bucket WHERE bucket_id = ?')
  const selectActiveBuckets = database.prepare(`
    SELECT * FROM triage_bucket
    WHERE status = 'open' OR activity_at >= ?
    ORDER BY activity_at DESC, bucket_id
    LIMIT ?
  `)
  const selectOpenBuckets = database.prepare(
    "SELECT * FROM triage_bucket WHERE status = 'open' ORDER BY activity_at DESC, bucket_id",
  )
  const insertMessage = database.prepare(`
    INSERT INTO triage_message (
      email_id, thread_id, summary_json, received_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `)
  const requeueMessage = database.prepare(`
    UPDATE triage_message
    SET status = 'queued', bucket_id = NULL, attempts = 0, last_error = NULL,
        summary_json = ?, received_at = ?, updated_at = ?
    WHERE email_id = ?
  `)
  const updateStatus = database.prepare(
    'UPDATE triage_message SET status = ?, updated_at = ? WHERE email_id = ?',
  )
  const assignBucket = database.prepare(`
    UPDATE triage_message
    SET bucket_id = ?, status = 'sorted', attempts = 0, last_error = NULL, updated_at = ?
    WHERE email_id = ?
  `)
  const moveMembers = database.prepare(
    'UPDATE triage_message SET bucket_id = ?, updated_at = ? WHERE bucket_id = ?',
  )
  const updateAttempt = database.prepare(`
    UPDATE triage_message
    SET attempts = attempts + 1, last_error = ?, updated_at = ?
    WHERE email_id = ? AND status = 'queued'
  `)
  const clearAttempts = database.prepare(`
    UPDATE triage_message SET attempts = 0, last_error = NULL, updated_at = ?
    WHERE email_id = ? AND status = 'queued'
  `)
  const insertBucket = database.prepare(`
    INSERT INTO triage_bucket (
      bucket_id, title, kind, current_state, summary, link_evidence_json, status,
      created_at, activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `)
  const updateBucketRow = database.prepare(`
    UPDATE triage_bucket
    SET title = ?, kind = ?, current_state = ?, summary = ?, link_evidence_json = ?
    WHERE bucket_id = ?
  `)
  const touchBucket = database.prepare(
    'UPDATE triage_bucket SET activity_at = ? WHERE bucket_id = ?',
  )
  const setBucketStatus = database.prepare(
    'UPDATE triage_bucket SET status = ? WHERE bucket_id = ?',
  )
  const countOpenMembers = database.prepare(
    "SELECT COUNT(*) AS count FROM triage_message WHERE bucket_id = ? AND status = 'sorted'",
  )
  const insertEvent = database.prepare(
    'INSERT INTO triage_event (created_at, kind, detail_json) VALUES (?, ?, ?)',
  )
  const pruneEvents = database.prepare(`
    DELETE FROM triage_event
    WHERE id NOT IN (SELECT id FROM triage_event ORDER BY id DESC LIMIT ${MAX_EVENTS})
  `)
  const selectProposals = database.prepare(
    'SELECT id, note, created_at FROM triage_memory_proposal ORDER BY created_at, id',
  )
  const selectProposal = database.prepare('SELECT note FROM triage_memory_proposal WHERE id = ?')
  const insertProposal = database.prepare(
    'INSERT INTO triage_memory_proposal (id, note, created_at) VALUES (?, ?, ?)',
  )
  const deleteProposal = database.prepare('DELETE FROM triage_memory_proposal WHERE id = ?')
  const pruneProposals = database.prepare(`
    DELETE FROM triage_memory_proposal
    WHERE id NOT IN (
      SELECT id FROM triage_memory_proposal ORDER BY created_at DESC, id LIMIT ${MAX_PROPOSALS}
    )
  `)
  const updateNotes = database.prepare(
    'UPDATE triage_state SET memory_notes = ? WHERE singleton = 1',
  )
  const updatePoll = database.prepare(
    'UPDATE triage_state SET last_poll_at = ?, last_poll_error = ? WHERE singleton = 1',
  )
  const updateSort = database.prepare(
    'UPDATE triage_state SET last_sort_at = ?, last_sort_error = ? WHERE singleton = 1',
  )
  const selectEditor = database.prepare(
    'SELECT editor_json FROM triage_reply_editor WHERE email_id = ?',
  )
  const upsertEditor = database.prepare(`
    INSERT INTO triage_reply_editor (email_id, editor_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(email_id) DO UPDATE SET
      editor_json = excluded.editor_json, updated_at = excluded.updated_at
  `)
  const deleteHandledMessages = database.prepare(
    "DELETE FROM triage_message WHERE status IN ('done', 'gone') AND updated_at < ?",
  )
  const deleteOrphanEditors = database.prepare(
    'DELETE FROM triage_reply_editor WHERE email_id NOT IN (SELECT email_id FROM triage_message)',
  )
  const deleteEmptyBuckets = database.prepare(`
    DELETE FROM triage_bucket
    WHERE status = 'closed'
      AND bucket_id NOT IN (SELECT bucket_id FROM triage_message WHERE bucket_id IS NOT NULL)
  `)

  function transaction<T>(work: () => T): T {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function refreshBucket(bucketId: string | null) {
    if (!bucketId) return
    const open = Number((countOpenMembers.get(bucketId) as { count: number | bigint }).count) > 0
    setBucketStatus.run(open ? 'open' : 'closed', bucketId)
  }

  function requireBucket(bucketId: string) {
    const row = selectBucket.get(bucketId) as BucketRow | undefined
    if (!row) throw new TriageStoreError(`Unknown bucket: ${bucketId}`, 'UNKNOWN_BUCKET')
    return row
  }

  function sortableRows(emailIds: readonly string[]) {
    const unique = [...new Set(emailIds)]
    if (unique.length === 0) {
      throw new TriageStoreError('At least one email ID is required.', 'UNKNOWN_EMAIL')
    }
    return unique.map((emailId) => {
      const row = selectMessage.get(emailId) as MessageRow | undefined
      if (!row) throw new TriageStoreError(`Unknown email: ${emailId}`, 'UNKNOWN_EMAIL')
      if (row.status !== 'queued' && row.status !== 'sorted') {
        throw new TriageStoreError(
          `Email ${emailId} is ${row.status} and cannot be sorted.`,
          'EMAIL_NOT_SORTABLE',
        )
      }
      return row
    })
  }

  function assign(bucketId: string, rows: readonly MessageRow[], now: string) {
    const previous = new Set<string>()
    for (const row of rows) {
      if (row.bucket_id && row.bucket_id !== bucketId) previous.add(row.bucket_id)
      assignBucket.run(bucketId, now, row.email_id)
    }
    touchBucket.run(now, bucketId)
    refreshBucket(bucketId)
    for (const id of previous) refreshBucket(id)
  }

  function applyPatch(row: BucketRow, patch: TriageBucketPatch) {
    const next = cleanMetadata({
      currentState: patch.currentState ?? row.current_state,
      kind: patch.kind ?? row.kind,
      linkEvidence: patch.linkEvidence ?? (JSON.parse(row.link_evidence_json) as string[]),
      summary: patch.summary ?? row.summary,
      title: patch.title ?? row.title,
    })
    updateBucketRow.run(
      next.title,
      next.kind,
      next.currentState,
      next.summary,
      JSON.stringify(next.linkEvidence),
      row.bucket_id,
    )
  }

  function record(row: BucketRow): TriageBucketRecord {
    return {
      activityAt: row.activity_at,
      bucketId: row.bucket_id,
      currentState: row.current_state,
      kind: row.kind,
      linkEvidence: JSON.parse(row.link_evidence_json) as string[],
      members: (selectMembers.all(row.bucket_id) as unknown as MessageRow[]).map(toMessage),
      open: row.status === 'open',
      summary: row.summary,
      title: row.title,
    }
  }

  function setStatus(emailIds: readonly string[], status: TriageMessageStatus) {
    const now = new Date().toISOString()
    transaction(() => {
      const buckets = new Set<string>()
      for (const emailId of new Set(emailIds)) {
        const row = selectMessage.get(emailId) as MessageRow | undefined
        if (!row) continue
        updateStatus.run(status, now, emailId)
        if (row.bucket_id) buckets.add(row.bucket_id)
      }
      for (const bucketId of buckets) refreshBucket(bucketId)
    })
  }

  function memory(): TriageMemory {
    const state = selectState.get() as { memory_notes: string }
    return {
      notes: state.memory_notes,
      proposals: (
        selectProposals.all() as Array<{ created_at: string; id: string; note: string }>
      ).map((row) => ({ createdAt: row.created_at, id: row.id, note: row.note })),
    }
  }

  return {
    acceptProposal(id) {
      return transaction(() => {
        const proposal = selectProposal.get(id) as { note: string } | undefined
        if (!proposal) return null
        const current = (selectState.get() as { memory_notes: string }).memory_notes.trimEnd()
        const separator = current ? '\n' : ''
        const next = `${current}${separator}${proposal.note}`.slice(0, TRIAGE_MEMORY_MAX_LENGTH)
        updateNotes.run(next)
        deleteProposal.run(id)
        return memory()
      })
    },
    addProposal(note) {
      const clean = note.trim().slice(0, 500)
      if (!clean) return
      transaction(() => {
        insertProposal.run(randomUUID(), clean, new Date().toISOString())
        pruneProposals.run()
      })
    },
    addToBucket(bucketId, emailIds, patch) {
      const now = new Date().toISOString()
      transaction(() => {
        const bucket = requireBucket(bucketId)
        assign(bucketId, sortableRows(emailIds), now)
        if (patch) applyPatch(bucket, patch)
      })
    },
    bucket(bucketId) {
      const row = selectBucket.get(bucketId) as BucketRow | undefined
      return row ? record(row) : null
    },
    buckets(activeSince, limit) {
      return (selectActiveBuckets.all(activeSince, limit) as unknown as BucketRow[]).map(record)
    },
    close() {
      database.close()
    },
    createBucket(metadata, emailIds) {
      const clean = cleanMetadata(metadata)
      const now = new Date().toISOString()
      const bucketId = randomUUID()
      transaction(() => {
        const rows = sortableRows(emailIds)
        insertBucket.run(
          bucketId,
          clean.title,
          clean.kind,
          clean.currentState,
          clean.summary,
          JSON.stringify(clean.linkEvidence),
          now,
          now,
        )
        assign(bucketId, rows, now)
      })
      return bucketId
    },
    enqueue(summaries) {
      const now = new Date().toISOString()
      return transaction(() => {
        let added = 0
        for (const summary of summaries) {
          const existing = selectMessage.get(summary.id) as MessageRow | undefined
          if (!existing) {
            insertMessage.run(
              summary.id,
              summary.threadId,
              JSON.stringify(summary),
              summary.receivedAt,
              now,
              now,
            )
            added += 1
          } else if (existing.status === 'done' || existing.status === 'gone') {
            if (
              existing.status === 'done' &&
              Date.parse(existing.updated_at) > Date.now() - REQUEUE_GRACE_MS
            ) {
              continue
            }
            requeueMessage.run(JSON.stringify(summary), summary.receivedAt, now, summary.id)
            refreshBucket(existing.bucket_id)
            added += 1
          }
        }
        return added
      })
    },
    logEvent(kind, detail) {
      insertEvent.run(new Date().toISOString(), kind.slice(0, 100), JSON.stringify(detail))
    },
    markDone(emailIds) {
      setStatus(emailIds, 'done')
    },
    markGone(emailIds) {
      setStatus(emailIds, 'gone')
    },
    memory,
    mergeBuckets(sourceBucketId, targetBucketId) {
      if (sourceBucketId === targetBucketId) {
        throw new TriageStoreError('A bucket cannot be merged into itself.', 'INVALID_BUCKET')
      }
      const now = new Date().toISOString()
      transaction(() => {
        requireBucket(sourceBucketId)
        requireBucket(targetBucketId)
        moveMembers.run(targetBucketId, now, sourceBucketId)
        touchBucket.run(now, targetBucketId)
        refreshBucket(targetBucketId)
        refreshBucket(sourceBucketId)
      })
    },
    message(emailId) {
      const row = selectMessage.get(emailId) as MessageRow | undefined
      return row ? toMessage(row) : null
    },
    park(emailIds) {
      setStatus(emailIds, 'parked')
    },
    parked() {
      return (selectParked.all() as unknown as MessageRow[]).map(toMessage)
    },
    prune(now = Date.now()) {
      transaction(() => {
        deleteHandledMessages.run(new Date(now - HANDLED_RETENTION_MS).toISOString())
        deleteEmptyBuckets.run()
        deleteOrphanEditors.run()
        pruneEvents.run()
      })
    },
    queueCounts(maxAttempts) {
      const row = countQueued.get(maxAttempts, maxAttempts) as {
        failed: number | bigint | null
        queued: number | bigint | null
      }
      return { failed: Number(row.failed ?? 0), queued: Number(row.queued ?? 0) }
    },
    queued(limit, maxAttempts) {
      return (selectQueued.all(maxAttempts, limit) as unknown as MessageRow[]).map(toMessage)
    },
    recordAttempt(emailIds, error) {
      const now = new Date().toISOString()
      transaction(() => {
        for (const emailId of new Set(emailIds)) {
          updateAttempt.run(error.slice(0, 1_000), now, emailId)
        }
      })
    },
    recordPoll(at, error) {
      updatePoll.run(at, error)
    },
    recordSort(at, error) {
      updateSort.run(at, error)
    },
    rejectProposal(id) {
      deleteProposal.run(id)
    },
    replyEditor(emailId) {
      const row = selectEditor.get(emailId) as { editor_json: string } | undefined
      return row ? (JSON.parse(row.editor_json) as ReplyEditorState) : null
    },
    reset() {
      transaction(() => {
        database.exec(`
          DELETE FROM triage_reply_editor;
          DELETE FROM triage_message;
          DELETE FROM triage_bucket;
          DELETE FROM triage_memory_proposal;
          DELETE FROM triage_event;
          UPDATE triage_state SET last_poll_at = NULL, last_poll_error = NULL,
            last_sort_at = NULL, last_sort_error = NULL WHERE singleton = 1;
        `)
      })
    },
    resetAttempts(emailIds) {
      const now = new Date().toISOString()
      transaction(() => {
        for (const emailId of new Set(emailIds)) clearAttempts.run(now, emailId)
      })
    },
    runState() {
      const state = selectState.get() as {
        last_poll_at: string | null
        last_poll_error: string | null
        last_sort_at: string | null
        last_sort_error: string | null
      }
      return {
        lastPollAt: state.last_poll_at,
        lastPollError: state.last_poll_error,
        lastSortAt: state.last_sort_at,
        lastSortError: state.last_sort_error,
      }
    },
    saveReplyEditor(emailId, editor) {
      upsertEditor.run(emailId, JSON.stringify(editor), new Date().toISOString())
    },
    setMemoryNotes(notes) {
      updateNotes.run(notes.slice(0, TRIAGE_MEMORY_MAX_LENGTH))
      return memory()
    },
    todo() {
      const unsorted = (selectAllQueued.all() as unknown as MessageRow[])
        .map(toMessage)
        .map((message): TriageBucket => {
          const { summary } = message
          return {
            activityAt: summary.receivedAt,
            bucketId: `unsorted:${summary.id}`,
            currentState: 'Noch nicht einsortiert',
            handledCount: 0,
            kind: 'standalone',
            linkEvidence: [],
            messages: [message],
            summary: summary.preview || summary.subject,
            title: summary.subject || '(Kein Betreff)',
            unsorted: true,
          }
        })
      const sorted = (selectOpenBuckets.all() as unknown as BucketRow[]).map(
        (row): TriageBucket => {
          const bucket = record(row)
          const messages = bucket.members
            .filter((member) => member.status === 'sorted')
            .sort(byReceivedAt)
          return {
            activityAt: bucket.activityAt,
            bucketId: bucket.bucketId,
            currentState: bucket.currentState,
            handledCount: bucket.members.filter(
              (member) => member.status === 'done' || member.status === 'gone',
            ).length,
            kind: bucket.kind,
            linkEvidence: bucket.linkEvidence,
            messages,
            summary: bucket.summary,
            title: bucket.title,
            unsorted: false,
          }
        },
      )
      return [...unsorted, ...sorted]
    },
    tokens() {
      const state = selectState.get() as { csrf_token: string; image_token: string }
      return { csrfToken: state.csrf_token, imageToken: state.image_token }
    },
    trackedIds() {
      return new Map(
        (selectTracked.all() as Array<{ email_id: string; status: TriageMessageStatus }>).map(
          (row) => [row.email_id, row.status],
        ),
      )
    },
    unpark(emailIds) {
      const now = new Date().toISOString()
      transaction(() => {
        for (const emailId of new Set(emailIds)) {
          const row = selectMessage.get(emailId) as MessageRow | undefined
          if (row?.status !== 'parked') continue
          const bucket = row.bucket_id
            ? (selectBucket.get(row.bucket_id) as BucketRow | undefined)
            : undefined
          updateStatus.run(bucket ? 'sorted' : 'queued', now, emailId)
          refreshBucket(row.bucket_id)
        }
      })
    },
    updateBucket(bucketId, patch) {
      transaction(() => applyPatch(requireBucket(bucketId), patch))
    },
  }
}
