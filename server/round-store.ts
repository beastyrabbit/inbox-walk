import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type {
  FinalizeFailure,
  FinalizeResult,
  MailAddress,
  MailboxOption,
  ReplyEditorState,
  ReviewAnalysisEngine,
  ReviewAnalysisState,
  ReviewAnalysisStatus,
  ReviewBundleRun,
  ReviewEmailSummary,
  ReviewFilters,
} from '../src/shared.ts'
import { type BundleDecision, type BundleExample, hashLearningSignal } from './bundles.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const SCHEMA_VERSION = 4
const MAX_STORED_ROUNDS = 200
const MAX_BUNDLE_EXAMPLES = 100
const MAX_BUNDLE_EXAMPLE_SIGNALS = 100
const ROUND_PRUNE_INTERVAL_MS = 60 * 1000
const REVIEW_CONFIRMED_BUNDLE_REASON = 'Vom Nutzer im Review bestätigt.'

export type ReviewRoundStatus = 'active' | 'finalizing' | 'finalized'
export type RoundAnalysisStatus = ReviewAnalysisStatus
export type RoundAnalysisEngine = ReviewAnalysisEngine

export interface StoredRoundAnalysis extends ReviewAnalysisState {
  updatedAt: string
}

export type RoundAnalysisUpdate = Partial<Omit<StoredRoundAnalysis, 'error' | 'updatedAt'>> & {
  error?: string | null
}

export interface StoredRoundUserState {
  bundleGroups: string[][]
  index: number
  keptUnreadIds: string[]
  processedIds: string[]
  replyDrafts: Record<string, ReplyEditorState>
  revision: number
  secondaryActionIds: string[]
  selectedMemberId: string | null
}

export interface RoundUserStateUpdate {
  bundleGroups: string[][]
  index: number
  keptUnreadIds: string[]
  processedIds: string[]
  replyDrafts: Record<string, ReplyEditorState>
  secondaryActionIds: string[]
  selectedMemberId?: string | null
}

export interface StoredRoundFinalization {
  actionFailed: FinalizeFailure[]
  failed: FinalizeFailure[]
  finalizeIds: string[]
  keepUnreadIds: string[]
  result: FinalizeResult | null
  secondaryActionIds: string[]
  secondaryActionSucceededIds: string[]
  state: ReviewRoundStatus
  succeededIds: string[]
  updatedAt: string
}

export type RoundFinalizationUpdate = Partial<Omit<StoredRoundFinalization, 'updatedAt'>>

export interface StoredReviewRound {
  analysis: StoredRoundAnalysis
  bundleCallLimit: number
  bundleExamples: BundleExample[]
  bundleRun: ReviewBundleRun | null
  createdAt: string
  csrfToken: string
  emails: ReviewEmailSummary[]
  filters: ReviewFilters
  id: string
  imageToken: string
  mailboxes: MailboxOption[]
  missingIds: string[]
  mode: 'demo' | 'live'
  finalization: StoredRoundFinalization
  status: ReviewRoundStatus
  totalBeforeLimit: number
  truncated: boolean
  updatedAt: string
  userState: StoredRoundUserState
}

export interface CreateReviewRoundInput {
  analysis?: Partial<Omit<StoredRoundAnalysis, 'updatedAt'>>
  bundleCallLimit?: number
  bundleExamples?: BundleExample[]
  csrfToken: string
  emails: ReviewEmailSummary[]
  filters: ReviewFilters
  id?: string
  imageToken: string
  mailboxes: MailboxOption[]
  missingIds?: string[]
  mode: 'demo' | 'live'
  status?: ReviewRoundStatus
  totalBeforeLimit?: number
  truncated?: boolean
  userState?: Partial<Omit<StoredRoundUserState, 'revision'>>
}

export interface RoundStore {
  close(): void
  create(input: CreateReviewRoundInput): StoredReviewRound
  getBundleDecision(roundId: string, decisionKey: string): BundleDecision | null
  get(roundId: string): StoredReviewRound | null
  saveBundleRun(
    roundId: string,
    bundleRun: ReviewBundleRun,
    analysis?: RoundAnalysisUpdate,
  ): StoredReviewRound | null
  saveBundleDecision(
    roundId: string,
    decisionKey: string,
    decision: BundleDecision,
  ): BundleDecision | null
  saveFinalization(roundId: string, finalization: RoundFinalizationUpdate): StoredReviewRound | null
  updateAnalysis(roundId: string, analysis: RoundAnalysisUpdate): StoredReviewRound | null
  updateUserState(
    roundId: string,
    expectedRevision: number,
    state: RoundUserStateUpdate,
  ): StoredReviewRound
}

export class RoundNotFoundError extends Error {
  readonly code = 'ROUND_NOT_FOUND'

  constructor(readonly roundId: string) {
    super(`Review round ${roundId} does not exist.`)
    this.name = 'RoundNotFoundError'
  }
}

export class RoundRevisionConflictError extends Error {
  readonly code = 'ROUND_REVISION_CONFLICT'

  constructor(
    readonly roundId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Review round ${roundId} has revision ${actualRevision}; expected ${expectedRevision}.`)
    this.name = 'RoundRevisionConflictError'
  }
}

interface RoundRow {
  analysis_call_count: number | bigint
  analysis_engine: RoundAnalysisEngine
  analysis_error: string | null
  analysis_model: string | null
  analysis_phase: string
  analysis_processed_email_count: number | bigint
  analysis_progress: number
  analysis_status: RoundAnalysisStatus
  analysis_total_email_count: number | bigint
  analysis_updated_at: string
  bundle_call_limit: number | bigint
  bundle_examples_json: string
  created_at: string
  csrf_token: string
  filters_json: string
  image_token: string
  mailboxes_json: string
  missing_ids_json: string
  mode: 'demo' | 'live'
  round_id: string
  status: ReviewRoundStatus
  total_before_limit: number | bigint
  truncated: number | bigint
  updated_at: string
}

interface MessageRow {
  email_id: string
  from_json: string
  has_attachment: number | bigint
  is_newsletter: number | bigint
  mailbox_names_json: string
  preview: string
  received_at: string
  subject: string
  thread_id: string
  to_json: string
}

interface UserStateRow {
  bundle_groups_json: string
  current_index: number | bigint
  kept_unread_ids_json: string
  processed_ids_json: string
  reply_drafts_json: string
  revision: number | bigint
  secondary_action_ids_json: string
  selected_member_id: string | null
}

interface FinalizationRow {
  action_failed_json: string
  failed_json: string
  finalize_ids_json: string
  keep_unread_ids_json: string
  result_json: string | null
  secondary_action_ids_json: string
  secondary_action_succeeded_ids_json: string
  state: ReviewRoundStatus
  succeeded_ids_json: string
  updated_at: string
}

type PersistedMailAddress = Omit<MailAddress, 'name'> & { name?: string | null }

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`)
  }
}

function assertProgress(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Analysis progress must be between 0 and 1.')
  }
}

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new TypeError(`${label} must not be empty.`)
}

function jsonParse<T>(value: string): T {
  return JSON.parse(value) as T
}

function cleanBundleExampleSignals(value: unknown) {
  if (!Array.isArray(value)) return []
  const signals = new Set<string>()
  for (const signal of value) {
    if (typeof signal !== 'string' || !signal.trim()) continue
    signals.add(hashLearningSignal(signal))
    if (signals.size >= MAX_BUNDLE_EXAMPLE_SIGNALS) break
  }
  return [...signals]
}

export function cleanBundleExamples(value: unknown): BundleExample[] {
  if (!Array.isArray(value)) return []
  const examples: BundleExample[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const example = candidate as Partial<BundleExample>
    if (typeof example.correct !== 'boolean') continue
    const anchorSignals = cleanBundleExampleSignals(example.anchorSignals)
    const candidateSignals = cleanBundleExampleSignals(example.candidateSignals)
    if (anchorSignals.length === 0 || candidateSignals.length === 0) continue
    const clean: BundleExample = {
      anchorSignals,
      candidateSignals,
      correct: example.correct,
      reason: REVIEW_CONFIRMED_BUNDLE_REASON,
    }
    const key = JSON.stringify(clean)
    if (seen.has(key)) continue
    seen.add(key)
    examples.push(clean)
    if (examples.length >= MAX_BUNDLE_EXAMPLES) break
  }
  return examples
}

function cleanAddress(address: PersistedMailAddress): MailAddress {
  return { email: address.email, name: address.name ?? '' }
}

function cleanSummary(email: ReviewEmailSummary): ReviewEmailSummary {
  return {
    from: email.from.map(cleanAddress),
    hasAttachment: email.hasAttachment,
    id: email.id,
    isNewsletter: email.isNewsletter,
    mailboxNames: [...email.mailboxNames],
    preview: email.preview,
    receivedAt: email.receivedAt,
    subject: email.subject,
    threadId: email.threadId,
    to: email.to.map(cleanAddress),
  }
}

function cleanMailbox(mailbox: MailboxOption): MailboxOption {
  return {
    id: mailbox.id,
    name: mailbox.name,
    ...(mailbox.role === undefined ? {} : { role: mailbox.role }),
  }
}

function cleanFilters(filters: ReviewFilters): ReviewFilters {
  return {
    hideReviewed: filters.hideReviewed,
    mailboxId: filters.mailboxId,
    newsletter: filters.newsletter,
    spam: filters.spam,
    timeRange: filters.timeRange,
  }
}

function cleanReplyDraft(draft: ReplyEditorState): ReplyEditorState {
  return {
    bodyText: draft.bodyText,
    cc: draft.cc.map(cleanAddress),
    ...(draft.draftRequestId === undefined ? {} : { draftRequestId: draft.draftRequestId }),
    identityId: draft.identityId,
    revisionInstruction: draft.revisionInstruction,
    roughNotes: draft.roughNotes,
    subject: draft.subject,
    to: draft.to.map(cleanAddress),
  }
}

function cleanReplyDrafts(
  drafts: Readonly<Record<string, ReplyEditorState>>,
): Record<string, ReplyEditorState> {
  return Object.fromEntries(
    Object.entries(drafts).map(([emailId, draft]) => [emailId, cleanReplyDraft(draft)]),
  )
}

function cleanFailure(failure: FinalizeFailure): FinalizeFailure {
  return { id: failure.id, reason: failure.reason }
}

function cleanFinalizeResult(result: FinalizeResult): FinalizeResult {
  return {
    actionFailed: result.actionFailed.map(cleanFailure),
    failed: result.failed.map(cleanFailure),
    finalized: result.finalized,
    keptUnread: result.keptUnread,
    markedRead: result.markedRead,
    mode: result.mode,
    processed: result.processed,
    remaining: result.remaining,
    rescuedFromSpam: result.rescuedFromSpam,
    taggedForUnsubscribe: result.taggedForUnsubscribe,
    untouched: result.untouched,
  }
}

function cleanBundleRun(run: ReviewBundleRun): ReviewBundleRun {
  return {
    bundles: run.bundles.map((bundle) => ({
      bundleId: bundle.bundleId,
      currentState: bundle.currentState,
      emailIds: [...bundle.emailIds],
      kind: bundle.kind,
      linkEvidence: [...bundle.linkEvidence],
      membershipConfidence: bundle.membershipConfidence,
      summary: bundle.summary,
      timeline: bundle.timeline.map((item) => ({
        emailId: item.emailId,
        event: item.event,
        occurredAt: item.occurredAt,
        source: item.source,
      })),
      title: bundle.title,
    })),
    fallback: run.fallback,
    snapshotId: run.snapshotId,
  }
}

function cleanBundleDecision(decision: BundleDecision): BundleDecision {
  return {
    currentState: decision.currentState,
    includedEmailIds: [...decision.includedEmailIds],
    kind: decision.kind,
    linkEvidence: [...decision.linkEvidence],
    membershipConfidence: decision.membershipConfidence,
    summary: decision.summary,
    title: decision.title,
  }
}

function cleanUserStateUpdate(state: RoundUserStateUpdate): RoundUserStateUpdate {
  assertNonNegativeInteger(state.index, 'Review index')
  return {
    bundleGroups: state.bundleGroups.map((group) => [...group]),
    index: state.index,
    keptUnreadIds: [...state.keptUnreadIds],
    processedIds: [...state.processedIds],
    replyDrafts: cleanReplyDrafts(state.replyDrafts),
    secondaryActionIds: [...state.secondaryActionIds],
    ...(state.selectedMemberId === undefined ? {} : { selectedMemberId: state.selectedMemberId }),
  }
}

function initialUserState(
  state: CreateReviewRoundInput['userState'],
): Omit<StoredRoundUserState, 'revision'> {
  return cleanUserStateUpdate({
    bundleGroups: state?.bundleGroups ?? [],
    index: state?.index ?? 0,
    keptUnreadIds: state?.keptUnreadIds ?? [],
    processedIds: state?.processedIds ?? [],
    replyDrafts: state?.replyDrafts ?? {},
    secondaryActionIds: state?.secondaryActionIds ?? [],
    selectedMemberId: state?.selectedMemberId ?? null,
  }) as Omit<StoredRoundUserState, 'revision'>
}

function validateAnalysis(analysis: Omit<StoredRoundAnalysis, 'updatedAt'>) {
  assertProgress(analysis.progress)
  assertNonNegativeInteger(analysis.callCount, 'Analysis call count')
  assertNonNegativeInteger(analysis.processedEmailCount, 'Processed email count')
  assertNonNegativeInteger(analysis.totalEmailCount, 'Total email count')
  if (analysis.processedEmailCount > analysis.totalEmailCount) {
    throw new RangeError('Processed email count cannot exceed total email count.')
  }
  assertNonEmpty(analysis.phase, 'Analysis phase')
}

function runMigration(database: InstanceType<typeof DatabaseSync>) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inbox_walk_round_store_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO inbox_walk_round_store_schema(singleton, version) VALUES (1, 0);
  `)
  const schema = database
    .prepare('SELECT version FROM inbox_walk_round_store_schema WHERE singleton = 1')
    .get() as { version: number | bigint }
  let version = Number(schema.version)
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Round store schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`,
    )
  }
  if (version < 1) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
      CREATE TABLE IF NOT EXISTS review_round (
        round_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
        status TEXT NOT NULL CHECK (status IN ('active', 'finalizing', 'finalized')),
        filters_json TEXT NOT NULL,
        mailboxes_json TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        image_token TEXT NOT NULL,
        total_before_limit INTEGER NOT NULL CHECK (total_before_limit >= 0),
        truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
        missing_ids_json TEXT NOT NULL,
        analysis_status TEXT NOT NULL CHECK (
          analysis_status IN ('pending', 'running', 'complete')
        ),
        analysis_phase TEXT NOT NULL,
        analysis_progress REAL NOT NULL CHECK (
          analysis_progress >= 0 AND analysis_progress <= 1
        ),
        analysis_engine TEXT NOT NULL CHECK (
          analysis_engine IN ('codex', 'heuristic', 'fallback')
        ),
        analysis_model TEXT,
        analysis_call_count INTEGER NOT NULL CHECK (analysis_call_count >= 0),
        analysis_processed_email_count INTEGER NOT NULL CHECK (
          analysis_processed_email_count >= 0
        ),
        analysis_total_email_count INTEGER NOT NULL CHECK (
          analysis_total_email_count >= 0
        ),
        analysis_error TEXT,
        analysis_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_round_message (
        round_id TEXT NOT NULL REFERENCES review_round(round_id) ON DELETE CASCADE,
        email_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        thread_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        preview TEXT NOT NULL,
        mailbox_names_json TEXT NOT NULL,
        has_attachment INTEGER NOT NULL CHECK (has_attachment IN (0, 1)),
        is_newsletter INTEGER NOT NULL CHECK (is_newsletter IN (0, 1)),
        PRIMARY KEY (round_id, email_id),
        UNIQUE (round_id, ordinal)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_bundle_run (
        round_id TEXT PRIMARY KEY REFERENCES review_round(round_id) ON DELETE CASCADE,
        run_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_round_user_state (
        round_id TEXT PRIMARY KEY REFERENCES review_round(round_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        current_index INTEGER NOT NULL CHECK (current_index >= 0),
        bundle_groups_json TEXT NOT NULL,
        processed_ids_json TEXT NOT NULL,
        kept_unread_ids_json TEXT NOT NULL,
        secondary_action_ids_json TEXT NOT NULL,
        reply_drafts_json TEXT NOT NULL,
        selected_member_id TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_round_finalization (
        round_id TEXT PRIMARY KEY REFERENCES review_round(round_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('active', 'finalizing', 'finalized')),
        finalize_ids_json TEXT NOT NULL,
        keep_unread_ids_json TEXT NOT NULL,
        secondary_action_ids_json TEXT NOT NULL,
        succeeded_ids_json TEXT NOT NULL,
        secondary_action_succeeded_ids_json TEXT NOT NULL,
        failed_json TEXT NOT NULL,
        action_failed_json TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

        UPDATE inbox_walk_round_store_schema SET version = 1 WHERE singleton = 1;
      `)
      database.exec('COMMIT')
      version = 1
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  if (version < 2) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        CREATE TABLE review_round_bundle_decision (
          round_id TEXT NOT NULL REFERENCES review_round(round_id) ON DELETE CASCADE,
          decision_key TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (round_id, decision_key)
        ) STRICT;

        UPDATE inbox_walk_round_store_schema SET version = 2 WHERE singleton = 1;
      `)
      database.exec('COMMIT')
      version = 2
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  if (version < 3) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        ALTER TABLE review_round
          ADD COLUMN bundle_examples_json TEXT NOT NULL DEFAULT '[]';

        UPDATE inbox_walk_round_store_schema SET version = 3 WHERE singleton = 1;
      `)
      database.exec('COMMIT')
      version = 3
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  if (version < 4) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        ALTER TABLE review_round
          ADD COLUMN bundle_call_limit INTEGER NOT NULL DEFAULT 64
          CHECK (bundle_call_limit >= 1 AND bundle_call_limit <= 512);

        UPDATE inbox_walk_round_store_schema SET version = 4 WHERE singleton = 1;
      `)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

export function roundStorePath() {
  return join(process.env.DATA_DIR ?? resolve('data'), 'inbox-walk.sqlite')
}

export function createRoundStore(databasePath = roundStorePath()): RoundStore {
  const inMemory = databasePath === ':memory:'
  if (!inMemory) mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(databasePath)
  if (!inMemory) chmodSync(databasePath, 0o600)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
  `)
  runMigration(database)

  const insertRound = database.prepare(`
    INSERT INTO review_round (
      round_id, mode, status, filters_json, mailboxes_json, csrf_token, image_token,
      total_before_limit, truncated, missing_ids_json, bundle_examples_json,
      bundle_call_limit,
      analysis_status, analysis_phase,
      analysis_progress, analysis_engine, analysis_model, analysis_call_count,
      analysis_processed_email_count, analysis_total_email_count, analysis_error,
      analysis_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMessage = database.prepare(`
    INSERT INTO review_round_message (
      round_id, email_id, ordinal, thread_id, subject, received_at, from_json, to_json,
      preview, mailbox_names_json, has_attachment, is_newsletter
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertUserState = database.prepare(`
    INSERT INTO review_round_user_state (
      round_id, revision, current_index, bundle_groups_json, processed_ids_json,
      kept_unread_ids_json, secondary_action_ids_json, reply_drafts_json,
      selected_member_id, updated_at
    ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFinalization = database.prepare(`
    INSERT INTO review_round_finalization (
      round_id, state, finalize_ids_json, keep_unread_ids_json,
      secondary_action_ids_json, succeeded_ids_json,
      secondary_action_succeeded_ids_json, failed_json, action_failed_json,
      result_json, updated_at
    ) VALUES (?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', NULL, ?)
  `)
  const selectRound = database.prepare('SELECT * FROM review_round WHERE round_id = ?')
  const selectMessages = database.prepare(`
    SELECT email_id, thread_id, subject, received_at, from_json, to_json, preview,
      mailbox_names_json, has_attachment, is_newsletter
    FROM review_round_message
    WHERE round_id = ?
    ORDER BY ordinal
  `)
  const selectBundleRun = database.prepare(
    'SELECT run_json FROM review_bundle_run WHERE round_id = ?',
  )
  const selectBundleDecision = database.prepare(`
    SELECT decision_json
    FROM review_round_bundle_decision
    WHERE round_id = ? AND decision_key = ?
  `)
  const insertBundleDecision = database.prepare(`
    INSERT OR IGNORE INTO review_round_bundle_decision (
      round_id, decision_key, decision_json, created_at
    ) VALUES (?, ?, ?, ?)
  `)
  const selectUserState = database.prepare(
    'SELECT * FROM review_round_user_state WHERE round_id = ?',
  )
  const selectFinalization = database.prepare(
    'SELECT * FROM review_round_finalization WHERE round_id = ?',
  )
  const updateAnalysisRow = database.prepare(`
    UPDATE review_round SET
      analysis_status = ?, analysis_phase = ?, analysis_progress = ?,
      analysis_engine = ?, analysis_model = ?, analysis_call_count = ?,
      analysis_processed_email_count = ?, analysis_total_email_count = ?,
      analysis_error = ?, analysis_updated_at = ?, updated_at = ?
    WHERE round_id = ?
  `)
  const upsertBundleRun = database.prepare(`
    INSERT INTO review_bundle_run(round_id, run_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(round_id) DO UPDATE SET
      run_json = excluded.run_json,
      updated_at = excluded.updated_at
  `)
  const updateUserStateRow = database.prepare(`
    UPDATE review_round_user_state SET
      revision = revision + 1,
      current_index = ?,
      bundle_groups_json = ?,
      processed_ids_json = ?,
      kept_unread_ids_json = ?,
      secondary_action_ids_json = ?,
      reply_drafts_json = ?,
      selected_member_id = ?,
      updated_at = ?
    WHERE round_id = ? AND revision = ?
  `)
  const updateFinalizationRow = database.prepare(`
    UPDATE review_round_finalization SET
      state = ?, finalize_ids_json = ?, keep_unread_ids_json = ?,
      secondary_action_ids_json = ?, succeeded_ids_json = ?,
      secondary_action_succeeded_ids_json = ?, failed_json = ?, action_failed_json = ?,
      result_json = ?, updated_at = ?
    WHERE round_id = ?
  `)
  const updateRoundStatus = database.prepare(
    'UPDATE review_round SET status = ?, updated_at = ? WHERE round_id = ?',
  )
  const touchRound = database.prepare('UPDATE review_round SET updated_at = ? WHERE round_id = ?')
  const pruneExpiredRounds = database.prepare(`
    DELETE FROM review_round
    WHERE
      (status = 'finalized' AND julianday(updated_at) < julianday('now', '-7 days'))
      OR julianday(updated_at) < julianday('now', '-30 days')
  `)
  const pruneOverflowRounds = database.prepare(`
    DELETE FROM review_round
    WHERE round_id IN (
      SELECT round_id
      FROM review_round
      ORDER BY (status = 'finalized') DESC, julianday(updated_at) ASC, rowid ASC
      LIMIT (
        SELECT MAX(COUNT(*) - ?, 0)
        FROM review_round
      )
    )
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
            event: 'round_store_checkpoint_busy',
            checkpointed: Number(checkpoint.checkpointed),
            log: Number(checkpoint.log),
          })}\n`,
        )
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'round_store_checkpoint_failed',
          message: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      )
    }
  }

  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const pruneStoredRounds = () => {
    const pruned = transaction(() => {
      const expired = Number(pruneExpiredRounds.run().changes)
      const overflow = Number(pruneOverflowRounds.run(MAX_STORED_ROUNDS).changes)
      return expired + overflow > 0
    })
    if (pruned) checkpointDeletedPages()
    return pruned
  }

  const readAnalysis = (row: RoundRow): StoredRoundAnalysis => ({
    callCount: Number(row.analysis_call_count),
    engine: row.analysis_engine,
    ...(row.analysis_error === null ? {} : { error: row.analysis_error }),
    ...(row.analysis_model === null ? {} : { model: row.analysis_model }),
    phase: row.analysis_phase,
    processedEmailCount: Number(row.analysis_processed_email_count),
    progress: row.analysis_progress,
    status: row.analysis_status,
    totalEmailCount: Number(row.analysis_total_email_count),
    updatedAt: row.analysis_updated_at,
  })

  const readUserState = (roundId: string): StoredRoundUserState => {
    const row = selectUserState.get(roundId) as UserStateRow | undefined
    if (!row) throw new Error(`Review round ${roundId} is missing its user state.`)
    return {
      bundleGroups: jsonParse<string[][]>(row.bundle_groups_json),
      index: Number(row.current_index),
      keptUnreadIds: jsonParse<string[]>(row.kept_unread_ids_json),
      processedIds: jsonParse<string[]>(row.processed_ids_json),
      replyDrafts: cleanReplyDrafts(
        jsonParse<Record<string, ReplyEditorState>>(row.reply_drafts_json),
      ),
      revision: Number(row.revision),
      secondaryActionIds: jsonParse<string[]>(row.secondary_action_ids_json),
      selectedMemberId: row.selected_member_id,
    }
  }

  const readFinalization = (roundId: string): StoredRoundFinalization => {
    const row = selectFinalization.get(roundId) as FinalizationRow | undefined
    if (!row) throw new Error(`Review round ${roundId} is missing its finalization state.`)
    return {
      actionFailed: jsonParse<FinalizeFailure[]>(row.action_failed_json),
      failed: jsonParse<FinalizeFailure[]>(row.failed_json),
      finalizeIds: jsonParse<string[]>(row.finalize_ids_json),
      keepUnreadIds: jsonParse<string[]>(row.keep_unread_ids_json),
      result: row.result_json ? jsonParse<FinalizeResult>(row.result_json) : null,
      secondaryActionIds: jsonParse<string[]>(row.secondary_action_ids_json),
      secondaryActionSucceededIds: jsonParse<string[]>(row.secondary_action_succeeded_ids_json),
      state: row.state,
      succeededIds: jsonParse<string[]>(row.succeeded_ids_json),
      updatedAt: row.updated_at,
    }
  }

  const get = (roundId: string): StoredReviewRound | null => {
    const row = selectRound.get(roundId) as RoundRow | undefined
    if (!row) return null
    const emails = (selectMessages.all(roundId) as unknown as MessageRow[]).map((message) => ({
      from: jsonParse<PersistedMailAddress[]>(message.from_json).map(cleanAddress),
      hasAttachment: Boolean(message.has_attachment),
      id: message.email_id,
      isNewsletter: Boolean(message.is_newsletter),
      mailboxNames: jsonParse<string[]>(message.mailbox_names_json),
      preview: message.preview,
      receivedAt: message.received_at,
      subject: message.subject,
      threadId: message.thread_id,
      to: jsonParse<PersistedMailAddress[]>(message.to_json).map(cleanAddress),
    }))
    const bundle = selectBundleRun.get(roundId) as { run_json: string } | undefined
    return {
      analysis: readAnalysis(row),
      bundleCallLimit: Number(row.bundle_call_limit),
      bundleExamples: cleanBundleExamples(jsonParse<unknown>(row.bundle_examples_json)),
      bundleRun: bundle ? jsonParse<ReviewBundleRun>(bundle.run_json) : null,
      createdAt: row.created_at,
      csrfToken: row.csrf_token,
      emails,
      filters: jsonParse<ReviewFilters>(row.filters_json),
      finalization: readFinalization(roundId),
      id: row.round_id,
      imageToken: row.image_token,
      mailboxes: jsonParse<MailboxOption[]>(row.mailboxes_json),
      missingIds: jsonParse<string[]>(row.missing_ids_json),
      mode: row.mode,
      status: row.status,
      totalBeforeLimit: Number(row.total_before_limit),
      truncated: Boolean(row.truncated),
      updatedAt: row.updated_at,
      userState: readUserState(roundId),
    }
  }

  const writeAnalysis = (
    roundId: string,
    row: RoundRow,
    patch: RoundAnalysisUpdate,
    now: string,
  ) => {
    const { updatedAt: _updatedAt, ...current } = readAnalysis(row)
    const { error, ...rest } = patch
    const next: Omit<StoredRoundAnalysis, 'updatedAt'> = { ...current, ...rest }
    if (error === null) delete next.error
    else if (error !== undefined) next.error = error
    validateAnalysis(next)
    updateAnalysisRow.run(
      next.status,
      next.phase,
      next.progress,
      next.engine,
      next.model ?? null,
      next.callCount,
      next.processedEmailCount,
      next.totalEmailCount,
      next.error ?? null,
      now,
      now,
      roundId,
    )
  }

  let closed = false
  pruneStoredRounds()
  const pruneTimer = setInterval(() => {
    if (closed) return
    try {
      pruneStoredRounds()
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'round_store_prune_failed',
          message: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      )
    }
  }, ROUND_PRUNE_INTERVAL_MS)
  pruneTimer.unref()
  return {
    close() {
      if (closed) return
      closed = true
      clearInterval(pruneTimer)
      database.close()
    },
    create(input) {
      const id = input.id ?? randomUUID()
      assertNonEmpty(id, 'Review round ID')
      const emails = input.emails.map(cleanSummary)
      const emailIds = new Set<string>()
      for (const email of emails) {
        assertNonEmpty(email.id, 'Email ID')
        if (emailIds.has(email.id)) {
          throw new TypeError(`Review round contains duplicate email ID ${email.id}.`)
        }
        emailIds.add(email.id)
      }
      const totalBeforeLimit = input.totalBeforeLimit ?? emails.length
      assertNonNegativeInteger(totalBeforeLimit, 'Total before limit')
      const bundleExamples = cleanBundleExamples(input.bundleExamples ?? [])
      const bundleCallLimit = input.bundleCallLimit ?? 64
      if (!Number.isSafeInteger(bundleCallLimit) || bundleCallLimit < 1 || bundleCallLimit > 512) {
        throw new RangeError('Bundle call limit must be an integer between 1 and 512.')
      }
      const now = new Date().toISOString()
      const analysis: Omit<StoredRoundAnalysis, 'updatedAt'> = {
        callCount: input.analysis?.callCount ?? 0,
        engine: input.analysis?.engine ?? 'heuristic',
        ...(input.analysis?.error === undefined ? {} : { error: input.analysis.error }),
        ...(input.analysis?.model === undefined ? {} : { model: input.analysis.model }),
        phase: input.analysis?.phase ?? 'queued',
        processedEmailCount: input.analysis?.processedEmailCount ?? 0,
        progress: input.analysis?.progress ?? 0,
        status: input.analysis?.status ?? 'pending',
        totalEmailCount: input.analysis?.totalEmailCount ?? emails.length,
      }
      validateAnalysis(analysis)
      const userState = initialUserState(input.userState)
      const status = input.status ?? 'active'
      const pruned = transaction(() => {
        insertRound.run(
          id,
          input.mode,
          status,
          JSON.stringify(cleanFilters(input.filters)),
          JSON.stringify(input.mailboxes.map(cleanMailbox)),
          input.csrfToken,
          input.imageToken,
          totalBeforeLimit,
          input.truncated ? 1 : 0,
          JSON.stringify(input.missingIds ?? []),
          JSON.stringify(bundleExamples),
          bundleCallLimit,
          analysis.status,
          analysis.phase,
          analysis.progress,
          analysis.engine,
          analysis.model ?? null,
          analysis.callCount,
          analysis.processedEmailCount,
          analysis.totalEmailCount,
          analysis.error ?? null,
          now,
          now,
          now,
        )
        for (const [ordinal, email] of emails.entries()) {
          insertMessage.run(
            id,
            email.id,
            ordinal,
            email.threadId,
            email.subject,
            email.receivedAt,
            JSON.stringify(email.from),
            JSON.stringify(email.to),
            email.preview,
            JSON.stringify(email.mailboxNames),
            email.hasAttachment ? 1 : 0,
            email.isNewsletter ? 1 : 0,
          )
        }
        insertUserState.run(
          id,
          userState.index,
          JSON.stringify(userState.bundleGroups),
          JSON.stringify(userState.processedIds),
          JSON.stringify(userState.keptUnreadIds),
          JSON.stringify(userState.secondaryActionIds),
          JSON.stringify(userState.replyDrafts),
          userState.selectedMemberId,
          now,
        )
        insertFinalization.run(id, status, now)
        const expired = Number(pruneExpiredRounds.run().changes)
        const overflow = Number(pruneOverflowRounds.run(MAX_STORED_ROUNDS).changes)
        return expired + overflow > 0
      })
      if (pruned) checkpointDeletedPages()
      const created = get(id)
      if (!created) throw new Error(`Failed to read newly created review round ${id}.`)
      return created
    },
    getBundleDecision(roundId, decisionKey) {
      assertNonEmpty(decisionKey, 'Bundle decision key')
      const row = selectBundleDecision.get(roundId, decisionKey) as
        | { decision_json: string }
        | undefined
      return row ? cleanBundleDecision(jsonParse<BundleDecision>(row.decision_json)) : null
    },
    get,
    saveBundleDecision(roundId, decisionKey, decision) {
      assertNonEmpty(decisionKey, 'Bundle decision key')
      const clean = cleanBundleDecision(decision)
      const now = new Date().toISOString()
      const saved = transaction(() => {
        const row = selectRound.get(roundId) as RoundRow | undefined
        if (!row) return false
        insertBundleDecision.run(roundId, decisionKey, JSON.stringify(clean), now)
        touchRound.run(now, roundId)
        return true
      })
      if (!saved) return null
      const persisted = selectBundleDecision.get(roundId, decisionKey) as
        | { decision_json: string }
        | undefined
      return persisted
        ? cleanBundleDecision(jsonParse<BundleDecision>(persisted.decision_json))
        : null
    },
    saveBundleRun(roundId, bundleRun, analysisPatch = {}) {
      if (bundleRun.snapshotId !== roundId) {
        throw new TypeError('Bundle run snapshot ID must match the review round ID.')
      }
      const run = cleanBundleRun(bundleRun)
      const now = new Date().toISOString()
      const saved = transaction(() => {
        const row = selectRound.get(roundId) as RoundRow | undefined
        if (!row) return false
        upsertBundleRun.run(roundId, JSON.stringify(run), now, now)
        writeAnalysis(
          roundId,
          row,
          {
            ...analysisPatch,
            engine: analysisPatch.engine ?? (run.fallback ? 'fallback' : row.analysis_engine),
            phase: analysisPatch.phase ?? 'complete',
            processedEmailCount:
              analysisPatch.processedEmailCount ?? Number(row.analysis_total_email_count),
            progress: analysisPatch.progress ?? 1,
            status: analysisPatch.status ?? 'complete',
          },
          now,
        )
        return true
      })
      return saved ? get(roundId) : null
    },
    saveFinalization(roundId, patch) {
      const saved = transaction(() => {
        const row = selectRound.get(roundId) as RoundRow | undefined
        if (!row) return false
        const current = readFinalization(roundId)
        const now = new Date().toISOString()
        const next: Omit<StoredRoundFinalization, 'updatedAt'> = {
          actionFailed: (patch.actionFailed ?? current.actionFailed).map(cleanFailure),
          failed: (patch.failed ?? current.failed).map(cleanFailure),
          finalizeIds: [...(patch.finalizeIds ?? current.finalizeIds)],
          keepUnreadIds: [...(patch.keepUnreadIds ?? current.keepUnreadIds)],
          result:
            patch.result === undefined
              ? current.result
              : patch.result
                ? cleanFinalizeResult(patch.result)
                : null,
          secondaryActionIds: [...(patch.secondaryActionIds ?? current.secondaryActionIds)],
          secondaryActionSucceededIds: [
            ...(patch.secondaryActionSucceededIds ?? current.secondaryActionSucceededIds),
          ],
          state: patch.state ?? current.state,
          succeededIds: [...(patch.succeededIds ?? current.succeededIds)],
        }
        updateFinalizationRow.run(
          next.state,
          JSON.stringify(next.finalizeIds),
          JSON.stringify(next.keepUnreadIds),
          JSON.stringify(next.secondaryActionIds),
          JSON.stringify(next.succeededIds),
          JSON.stringify(next.secondaryActionSucceededIds),
          JSON.stringify(next.failed),
          JSON.stringify(next.actionFailed),
          next.result ? JSON.stringify(next.result) : null,
          now,
          roundId,
        )
        updateRoundStatus.run(next.state, now, roundId)
        return true
      })
      return saved ? get(roundId) : null
    },
    updateAnalysis(roundId, patch) {
      const now = new Date().toISOString()
      const updated = transaction(() => {
        const row = selectRound.get(roundId) as RoundRow | undefined
        if (!row) return false
        writeAnalysis(roundId, row, patch, now)
        return true
      })
      return updated ? get(roundId) : null
    },
    updateUserState(roundId, expectedRevision, state) {
      assertNonNegativeInteger(expectedRevision, 'Expected revision')
      const clean = cleanUserStateUpdate(state)
      const replyDraftsJson = JSON.stringify(clean.replyDrafts)
      let supersededDraftState = false
      transaction(() => {
        const current = selectUserState.get(roundId) as UserStateRow | undefined
        if (!current) throw new RoundNotFoundError(roundId)
        supersededDraftState = current.reply_drafts_json !== replyDraftsJson
        const selectedMemberId =
          clean.selectedMemberId === undefined ? current.selected_member_id : clean.selectedMemberId
        const now = new Date().toISOString()
        const result = updateUserStateRow.run(
          clean.index,
          JSON.stringify(clean.bundleGroups),
          JSON.stringify(clean.processedIds),
          JSON.stringify(clean.keptUnreadIds),
          JSON.stringify(clean.secondaryActionIds),
          replyDraftsJson,
          selectedMemberId,
          now,
          roundId,
          expectedRevision,
        )
        if (Number(result.changes) === 0) {
          const latest = selectUserState.get(roundId) as UserStateRow | undefined
          if (!latest) throw new RoundNotFoundError(roundId)
          throw new RoundRevisionConflictError(roundId, expectedRevision, Number(latest.revision))
        }
        touchRound.run(now, roundId)
      })
      if (supersededDraftState) checkpointDeletedPages()
      const updated = get(roundId)
      if (!updated) throw new RoundNotFoundError(roundId)
      return updated
    },
  }
}
