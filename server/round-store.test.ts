import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FinalizeResult,
  ReplyEditorState,
  ReviewBundleRun,
  ReviewEmailSummary,
  ReviewFilters,
} from '../src/shared.ts'
import { type BundleExample, hashLearningSignal } from './bundles.ts'
import { createRoundStore, RoundNotFoundError, RoundRevisionConflictError } from './round-store.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const filters: ReviewFilters = {
  hideReviewed: true,
  mailboxId: 'inbox',
  newsletter: 'exclude',
  spam: 'exclude',
  timeRange: '7d',
}

const emails: ReviewEmailSummary[] = [
  {
    from: [{ email: 'alice@example.com', name: 'Alice' }],
    hasAttachment: false,
    id: 'mail-1',
    isNewsletter: false,
    mailboxNames: ['Inbox'],
    preview: 'The first preview',
    receivedAt: '2026-08-29T08:00:00.000Z',
    subject: 'First subject',
    threadId: 'thread-1',
    to: [{ email: 'me@example.com', name: 'Me' }],
  },
  {
    from: [{ email: 'shop@example.com', name: 'Shop' }],
    hasAttachment: true,
    id: 'mail-2',
    isNewsletter: true,
    mailboxNames: ['Inbox', 'Receipts'],
    preview: 'The second preview',
    receivedAt: '2026-08-30T09:00:00.000Z',
    subject: 'Second subject',
    threadId: 'thread-2',
    to: [{ email: 'me@example.com', name: '' }],
  },
]

const rawBundleExample: BundleExample = {
  anchorSignals: ['provider:Private Example', 'provider:Private Example', '  '],
  candidateSignals: ['thread:Private Thread 9382'],
  correct: true,
  reason: 'Untrusted reason that must not be persisted.',
}

const storedBundleExample: BundleExample = {
  anchorSignals: [hashLearningSignal('provider:Private Example')],
  candidateSignals: [hashLearningSignal('thread:Private Thread 9382')],
  correct: true,
  reason: 'Vom Nutzer im Review bestätigt.',
}

const replyDraft: ReplyEditorState = {
  bodyText: 'A reply draft, not received-message content.',
  cc: [],
  draftRequestId: 'request-1',
  identityId: 'identity-1',
  revisionInstruction: '',
  roughNotes: 'Answer next week.',
  subject: 'Re: First subject',
  to: [{ email: 'alice@example.com', name: 'Alice' }],
}

function createDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-round-store-'))
  directories.push(directory)
  return join(directory, 'inbox-walk.sqlite')
}

function databaseArtifacts(databasePath: string) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(existsSync)
    .map((file) => readFileSync(file).toString('latin1'))
    .join('\n')
}

function createRound(databasePath: string) {
  const store = createRoundStore(databasePath)
  const round = store.create({
    analysis: { model: 'gpt-5.6-sol', thinkingLevel: 'xhigh' },
    bundleExamples: [rawBundleExample],
    csrfToken: 'csrf-token',
    emails,
    filters,
    id: 'round-1',
    imageToken: 'image-token',
    mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
    mode: 'demo',
    totalBeforeLimit: 2,
    truncated: false,
  })
  return { round, store }
}

function bundleRun(fallback = false): ReviewBundleRun {
  return {
    bundles: [
      {
        bundleId: 'bundle-one',
        currentState: 'Waiting for an answer.',
        emailIds: ['mail-1', 'mail-2'],
        kind: 'conversation',
        linkEvidence: ['Same project reference'],
        membershipConfidence: 0.92,
        summary: 'Two related messages.',
        timeline: [
          {
            emailId: 'mail-1',
            event: 'Question arrived',
            occurredAt: '2026-08-29T08:00:00.000Z',
            source: 'Alice',
          },
        ],
        title: 'Related work',
      },
    ],
    fallback,
    snapshotId: 'round-1',
  }
}

const partialFinalizeResult: FinalizeResult = {
  actionFailed: [{ id: 'mail-2', reason: 'Temporary label error' }],
  failed: [{ id: 'mail-1', reason: 'Temporary read error' }],
  finalized: false,
  keptUnread: 0,
  markedRead: 0,
  mode: 'demo',
  processed: 2,
  remaining: 2,
  rescuedFromSpam: 0,
  taggedForUnsubscribe: 0,
  untouched: 0,
}

describe('SQLite review round store', () => {
  it('supports an in-memory store for isolated API tests', () => {
    const store = createRoundStore(':memory:')
    expect(
      store.create({
        csrfToken: 'csrf',
        emails: [],
        filters,
        id: 'memory-round',
        imageToken: 'image',
        mailboxes: [],
        mode: 'demo',
      }).id,
    ).toBe('memory-round')
    store.close()
  })

  it('persists a complete round, analysis, bundles, decisions, and finalization across reopen', () => {
    const databasePath = createDatabasePath()
    const { round, store } = createRound(databasePath)

    expect(round.id).toBe('round-1')
    expect(round.bundleExamples).toEqual([storedBundleExample])
    expect(round.analysis).toMatchObject({
      callCount: 0,
      model: 'gpt-5.6-sol',
      phase: 'queued',
      processedEmailCount: 0,
      progress: 0,
      status: 'pending',
      totalEmailCount: 2,
      thinkingLevel: 'xhigh',
    })
    expect(round.userState).toEqual({
      bundleGroups: [],
      index: 0,
      keptUnreadIds: [],
      processedIds: [],
      replyDrafts: {},
      revision: 0,
      secondaryActionIds: [],
      selectedMemberId: null,
    })
    expect(store.list()).toEqual([
      expect.objectContaining({
        id: 'round-1',
        incompleteSnapshot: false,
        reanalyzable: true,
      }),
    ])

    store.updateAnalysis('round-1', {
      callCount: 3,
      engine: 'codex',
      model: 'gpt-5.6-sol',
      phase: 'grouping',
      processedEmailCount: 1,
      progress: 0.5,
      status: 'running',
    })
    store.saveBundleRun('round-1', bundleRun())
    const updated = store.updateUserState('round-1', 0, {
      bundleGroups: [['mail-2', 'mail-1']],
      index: 1,
      keptUnreadIds: ['mail-1'],
      processedIds: ['mail-1'],
      replyDrafts: { 'mail-1': replyDraft },
      secondaryActionIds: ['mail-2'],
      selectedMemberId: 'mail-2',
    })
    expect(updated.userState.revision).toBe(1)
    store.saveFinalization('round-1', {
      actionFailed: partialFinalizeResult.actionFailed,
      failed: partialFinalizeResult.failed,
      finalizeIds: ['mail-1', 'mail-2'],
      keepUnreadIds: [],
      result: partialFinalizeResult,
      secondaryActionIds: ['mail-2'],
      secondaryActionSucceededIds: [],
      state: 'active',
      succeededIds: [],
    })
    expect(store.list()).toEqual([expect.objectContaining({ id: 'round-1', reanalyzable: false })])
    store.close()

    const reopened = createRoundStore(databasePath)
    const restored = reopened.get('round-1')
    expect(restored).not.toBeNull()
    expect(restored).toMatchObject({
      bundleRun: bundleRun(),
      bundleExamples: [storedBundleExample],
      csrfToken: 'csrf-token',
      emails,
      filters,
      id: 'round-1',
      imageToken: 'image-token',
      mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
      missingIds: [],
      mode: 'demo',
      totalBeforeLimit: 2,
      truncated: false,
    })
    expect(restored?.analysis).toMatchObject({
      callCount: 3,
      engine: 'codex',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      phase: 'complete',
      processedEmailCount: 2,
      progress: 1,
      status: 'complete',
      totalEmailCount: 2,
    })
    expect(restored?.userState).toEqual({
      bundleGroups: [['mail-2', 'mail-1']],
      index: 1,
      keptUnreadIds: ['mail-1'],
      processedIds: ['mail-1'],
      replyDrafts: { 'mail-1': replyDraft },
      revision: 1,
      secondaryActionIds: ['mail-2'],
      selectedMemberId: 'mail-2',
    })
    expect(restored?.finalization).toMatchObject({
      actionFailed: partialFinalizeResult.actionFailed,
      failed: partialFinalizeResult.failed,
      finalizeIds: ['mail-1', 'mail-2'],
      keepUnreadIds: [],
      result: partialFinalizeResult,
      secondaryActionIds: ['mail-2'],
      secondaryActionSucceededIds: [],
      state: 'active',
      succeededIds: [],
    })
    reopened.close()
  })

  it('migrates an existing v1 round database with frozen analysis defaults and checkpoints', () => {
    const databasePath = createDatabasePath()
    const { store } = createRound(databasePath)
    store.close()
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP TABLE review_round_bundle_decision;
      ALTER TABLE review_round DROP COLUMN bundle_examples_json;
      UPDATE inbox_walk_round_store_schema SET version = 1 WHERE singleton = 1;
    `)
    legacy.close()

    const migrated = createRoundStore(databasePath)
    const decision = {
      currentState: 'Ready',
      includedEmailIds: ['mail-2'],
      kind: 'conversation' as const,
      linkEvidence: ['same conversation'],
      membershipConfidence: 0.9,
      summary: 'Related messages.',
      title: 'Conversation',
    }
    expect(migrated.saveBundleDecision('round-1', 'decision-key', decision)).toEqual(decision)
    expect(migrated.getBundleDecision('round-1', 'decision-key')).toEqual(decision)
    expect(migrated.get('round-1')?.bundleExamples).toEqual([])
    migrated.close()

    const inspected = new DatabaseSync(databasePath)
    expect(
      Number(
        (
          inspected
            .prepare('SELECT version FROM inbox_walk_round_store_schema WHERE singleton = 1')
            .get() as { version: number | bigint }
        ).version,
      ),
    ).toBe(7)
    expect(
      (
        inspected.prepare('PRAGMA table_info(review_round)').all() as unknown as Array<{
          name: string
        }>
      ).some(({ name }) => name === 'bundle_call_limit'),
    ).toBe(false)
    inspected.close()
  })

  it('keeps incomplete snapshots failed even when callers try to make them ready', () => {
    const store = createRoundStore(':memory:')
    const incomplete = store.create({
      analysis: {
        phase: 'complete',
        processedEmailCount: emails.length,
        progress: 1,
        status: 'complete',
        totalEmailCount: emails.length,
      },
      csrfToken: 'incomplete-csrf',
      emails,
      filters,
      id: 'incomplete-round',
      imageToken: 'incomplete-image',
      mailboxes: [],
      missingIds: ['gone-mail'],
      mode: 'demo',
      runStatus: 'ready',
      totalBeforeLimit: 3,
    })

    expect(incomplete).toMatchObject({
      bundleRun: null,
      runStatus: 'failed',
      analysis: {
        phase: 'failed',
        status: 'pending',
      },
    })
    expect(store.list()).toEqual([
      expect.objectContaining({
        id: 'incomplete-round',
        incompleteSnapshot: true,
        reanalyzable: false,
      }),
    ])

    expect(
      store.saveBundleRun('incomplete-round', {
        ...bundleRun(),
        snapshotId: 'incomplete-round',
      }),
    ).toBeNull()
    expect(store.get('incomplete-round')).toMatchObject({
      bundleRun: null,
      runStatus: 'failed',
      analysis: {
        phase: 'failed',
        status: 'pending',
      },
    })

    expect(
      store.updateRunStatus('incomplete-round', incomplete.generation, 'ready', {
        phase: 'complete',
        status: 'complete',
      }),
    ).toMatchObject({
      runStatus: 'failed',
      analysis: {
        phase: 'failed',
        status: 'pending',
      },
    })
    store.close()
  })

  it('migrates incomplete v6 snapshots to a fail-closed lifecycle state', () => {
    const databasePath = createDatabasePath()
    const { store } = createRound(databasePath)
    store.saveBundleRun('round-1', bundleRun())
    store.saveBundleDecision('round-1', 'stale-decision', {
      currentState: 'Ready',
      includedEmailIds: ['mail-2'],
      kind: 'conversation',
      linkEvidence: ['same conversation'],
      membershipConfidence: 0.9,
      summary: 'Related messages.',
      title: 'Conversation',
    })
    store.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      UPDATE review_round
      SET
        missing_ids_json = '["gone-mail"]',
        run_status = 'ready',
        analysis_status = 'complete',
        analysis_phase = 'complete',
        analysis_error = NULL
      WHERE round_id = 'round-1';
      UPDATE inbox_walk_round_store_schema SET version = 6 WHERE singleton = 1;
    `)
    legacy.close()

    const migrated = createRoundStore(databasePath)
    expect(migrated.get('round-1')).toMatchObject({
      bundleRun: null,
      missingIds: ['gone-mail'],
      runStatus: 'failed',
      analysis: {
        phase: 'failed',
        status: 'pending',
      },
    })
    expect(migrated.list()).toEqual([
      expect.objectContaining({ id: 'round-1', reanalyzable: false, runStatus: 'failed' }),
    ])
    expect(migrated.getBundleDecision('round-1', 'stale-decision')).toBeNull()
    migrated.close()
  })

  it('migrates v4 lifecycle state without exposing incomplete analysis as ready', () => {
    const databasePath = createDatabasePath()
    const store = createRoundStore(databasePath)
    store.create({
      csrfToken: 'pending-csrf',
      emails: [emails[0] as ReviewEmailSummary],
      filters,
      id: 'pending-round',
      imageToken: 'pending-image',
      mailboxes: [],
      mode: 'demo',
    })
    store.create({
      csrfToken: 'ready-csrf',
      emails,
      filters,
      id: 'ready-round',
      imageToken: 'ready-image',
      mailboxes: [],
      mode: 'demo',
    })
    store.saveBundleRun('ready-round', { ...bundleRun(), snapshotId: 'ready-round' })
    store.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      ALTER TABLE review_round DROP COLUMN analysis_thinking_level;
      ALTER TABLE review_round DROP COLUMN generation;
      ALTER TABLE review_round DROP COLUMN run_status;
      UPDATE inbox_walk_round_store_schema SET version = 4 WHERE singleton = 1;
    `)
    legacy.close()

    const migrated = createRoundStore(databasePath)
    expect(migrated.get('ready-round')?.runStatus).toBe('ready')
    expect(migrated.get('pending-round')?.runStatus).toBe('analyzing')
    migrated.close()
  })

  it('atomically populates, resets, and deletes a generation-guarded background run', () => {
    const store = createRoundStore(':memory:')
    const stub = store.create({
      analysis: { phase: 'queued', totalEmailCount: 0 },
      csrfToken: 'background-csrf',
      emails: [],
      filters,
      generation: 1,
      id: 'background-round',
      imageToken: 'background-image',
      mailboxes: [],
      mode: 'demo',
      runStatus: 'queued',
    })
    expect(stub.runStatus).toBe('queued')
    expect(
      store.populate('background-round', 0, {
        analysis: {},
        emails,
        mailboxes: [],
      }),
    ).toBeNull()
    const populated = store.populate('background-round', 1, {
      analysis: {
        phase: 'indexing',
        status: 'pending',
        totalEmailCount: emails.length,
      },
      emails,
      mailboxes: [{ id: 'inbox', name: 'Inbox' }],
    })
    expect(populated).toMatchObject({ generation: 1, runStatus: 'analyzing' })
    store.saveBundleRun(
      'background-round',
      { ...bundleRun(), snapshotId: 'background-round' },
      {},
      1,
    )
    const withProgress = store.updateUserState('background-round', 0, {
      bundleGroups: [['mail-1'], ['mail-2']],
      index: 1,
      keptUnreadIds: ['mail-1'],
      processedIds: ['mail-1'],
      replyDrafts: { 'mail-1': replyDraft },
      secondaryActionIds: [],
      selectedMemberId: 'mail-1',
    })
    expect(withProgress.userState.revision).toBe(1)
    const restarted = store.reanalyze('background-round', {
      callCount: 0,
      phase: 'indexing',
      processedEmailCount: 0,
      progress: 0,
      status: 'pending',
    })
    expect(restarted).toMatchObject({ generation: 2, runStatus: 'analyzing' })
    expect(restarted?.userState.bundleGroups).toEqual([])
    expect(restarted?.userState).toMatchObject({
      index: 0,
      keptUnreadIds: ['mail-1'],
      processedIds: ['mail-1'],
      replyDrafts: { 'mail-1': replyDraft },
      revision: 2,
      selectedMemberId: null,
    })
    expect(store.delete('background-round')).toBe(true)
    expect(store.get('background-round')).toBeNull()
    store.close()
  })

  it('normalizes null address names from legacy persisted rounds and reply drafts', () => {
    const databasePath = createDatabasePath()
    const { store } = createRound(databasePath)
    store.close()

    const legacy = new DatabaseSync(databasePath)
    legacy
      .prepare(
        'UPDATE review_round_message SET from_json = ?, to_json = ? WHERE round_id = ? AND email_id = ?',
      )
      .run(
        JSON.stringify([{ email: 'alice@example.com', name: null }]),
        JSON.stringify([{ email: 'me@example.com', name: null }]),
        'round-1',
        'mail-1',
      )
    legacy
      .prepare('UPDATE review_round_user_state SET reply_drafts_json = ? WHERE round_id = ?')
      .run(
        JSON.stringify({
          'mail-1': {
            ...replyDraft,
            cc: [{ email: 'copy@example.com', name: null }],
            to: [{ email: 'alice@example.com', name: null }],
          },
        }),
        'round-1',
      )
    legacy.close()

    const reopened = createRoundStore(databasePath)
    const restored = reopened.get('round-1')

    expect(restored?.emails[0]?.from).toEqual([{ email: 'alice@example.com', name: '' }])
    expect(restored?.emails[0]?.to).toEqual([{ email: 'me@example.com', name: '' }])
    expect(restored?.userState.replyDrafts['mail-1']?.cc).toEqual([
      { email: 'copy@example.com', name: '' },
    ])
    expect(restored?.userState.replyDrafts['mail-1']?.to).toEqual([
      { email: 'alice@example.com', name: '' },
    ])
    reopened.close()
  })

  it('bounds and hashes the learning corpus before writing it to the round database', () => {
    const databasePath = createDatabasePath()
    const store = createRoundStore(databasePath)
    const oversized = Array.from({ length: 105 }, (_, exampleIndex) => ({
      anchorSignals: Array.from(
        { length: 105 },
        (_, signalIndex) => `provider:private-${exampleIndex}-${signalIndex}`,
      ),
      candidateSignals: [`thread:private-${exampleIndex}`],
      correct: exampleIndex % 2 === 0,
      reason: `private-reason-${exampleIndex}`,
    }))

    const round = store.create({
      bundleExamples: oversized,
      csrfToken: 'bounded-csrf',
      emails: [],
      filters,
      id: 'bounded-round',
      imageToken: 'bounded-image',
      mailboxes: [],
      mode: 'demo',
    })

    expect(round.bundleExamples).toHaveLength(100)
    expect(round.bundleExamples[0]?.anchorSignals).toHaveLength(100)
    expect(round.bundleExamples[0]?.anchorSignals[0]).toBe(
      hashLearningSignal('provider:private-0-0'),
    )
    expect(
      round.bundleExamples.every((example) => example.reason === storedBundleExample.reason),
    ).toBe(true)
    store.close()
    const artifacts = databaseArtifacts(databasePath)
    expect(artifacts).not.toContain('provider:private-0-0')
    expect(artifacts).not.toContain('private-reason-0')
  })

  it('rejects stale writes with the current revision and preserves merge/split groups', () => {
    const databasePath = createDatabasePath()
    const first = createRound(databasePath).store
    const second = createRoundStore(databasePath)
    const initialUpdate = {
      bundleGroups: [['mail-1'], ['mail-2']],
      index: 1,
      keptUnreadIds: [],
      processedIds: ['mail-1'],
      replyDrafts: {},
      secondaryActionIds: [],
    }

    expect(first.updateUserState('round-1', 0, initialUpdate).userState).toMatchObject({
      bundleGroups: [['mail-1'], ['mail-2']],
      revision: 1,
    })
    expect(() =>
      second.updateUserState('round-1', 0, {
        ...initialUpdate,
        bundleGroups: [['mail-1', 'mail-2']],
      }),
    ).toThrowError(
      expect.objectContaining({
        actualRevision: 1,
        code: 'ROUND_REVISION_CONFLICT',
        expectedRevision: 0,
      }),
    )
    const corrected = second.updateUserState('round-1', 1, {
      ...initialUpdate,
      bundleGroups: [['mail-1', 'mail-2']],
    })
    expect(corrected.userState).toMatchObject({
      bundleGroups: [['mail-1', 'mail-2']],
      revision: 2,
    })

    first.close()
    second.close()
  })

  it('clears a persisted analysis error only when explicitly requested', () => {
    const databasePath = createDatabasePath()
    const { store } = createRound(databasePath)
    store.updateAnalysis('round-1', {
      error: 'Codex muss erneut verbunden werden.',
      phase: 'waiting_for_codex',
      status: 'pending',
    })
    store.updateAnalysis('round-1', { phase: 'indexing', status: 'running' })
    expect(store.get('round-1')?.analysis.error).toBe('Codex muss erneut verbunden werden.')

    store.updateAnalysis('round-1', { error: null, phase: 'grouping' })
    expect(store.get('round-1')?.analysis).toMatchObject({ phase: 'grouping' })
    expect(store.get('round-1')?.analysis).not.toHaveProperty('error')
    store.close()
  })

  it('does not persist received bodies or attachment content from wider input objects', () => {
    const databasePath = createDatabasePath()
    const receivedBody = 'CONFIDENTIAL-RECEIVED-BODY'
    const attachmentContent = 'CONFIDENTIAL-ATTACHMENT-CONTENT'
    const widerEmail = {
      ...emails[0],
      attachments: [{ content: attachmentContent }],
      html: `<p>${receivedBody}</p>`,
      text: receivedBody,
    } as unknown as ReviewEmailSummary
    const store = createRoundStore(databasePath)
    store.create({
      csrfToken: 'csrf',
      emails: [widerEmail],
      filters,
      id: 'safe-round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'demo',
    })
    store.close()

    const databaseBytes = readFileSync(databasePath).toString('utf8')
    expect(databaseBytes).not.toContain(receivedBody)
    expect(databaseBytes).not.toContain(attachmentContent)
  })

  it('returns null for missing optional updates and a typed error for missing user state', () => {
    const databasePath = createDatabasePath()
    const store = createRoundStore(databasePath)
    expect(store.get('missing')).toBeNull()
    expect(store.updateAnalysis('missing', { phase: 'running' })).toBeNull()
    expect(store.saveBundleRun('missing', { ...bundleRun(), snapshotId: 'missing' })).toBeNull()
    expect(store.saveFinalization('missing', { state: 'finalizing' })).toBeNull()
    expect(() =>
      store.updateUserState('missing', 0, {
        bundleGroups: [],
        index: 0,
        keptUnreadIds: [],
        processedIds: [],
        replyDrafts: {},
        secondaryActionIds: [],
      }),
    ).toThrow(RoundNotFoundError)
    expect(RoundRevisionConflictError.prototype).toBeInstanceOf(Error)
    store.close()
  })

  it('caps durable round metadata instead of growing the database without a bound', () => {
    const databasePath = createDatabasePath()
    const store = createRoundStore(databasePath)
    const deletedDraftMarker = 'DELETED-DRAFT-MARKER-7c68e4c1'
    for (let index = 0; index < 202; index += 1) {
      store.create({
        csrfToken: `csrf-${index}`,
        emails: [],
        filters,
        id: `round-${index}`,
        imageToken: `image-${index}`,
        mailboxes: [],
        mode: 'demo',
        ...(index === 0
          ? {
              userState: {
                replyDrafts: {
                  deleted: { ...replyDraft, bodyText: deletedDraftMarker },
                },
              },
            }
          : {}),
      })
    }

    expect(store.get('round-0')).toBeNull()
    expect(store.get('round-1')).toBeNull()
    expect(store.get('round-201')).not.toBeNull()
    store.close()
    expect(readFileSync(databasePath).toString('utf8')).not.toContain(deletedDraftMarker)
  })

  it('enforces time retention as soon as an existing database is opened', () => {
    const databasePath = createDatabasePath()
    const { store } = createRound(databasePath)
    store.close()

    const legacy = new DatabaseSync(databasePath)
    legacy
      .prepare("UPDATE review_round SET status = 'finalized', updated_at = ? WHERE round_id = ?")
      .run('2020-01-01T00:00:00.000Z', 'round-1')
    legacy.close()

    const reopened = createRoundStore(databasePath)
    expect(reopened.get('round-1')).toBeNull()
    reopened.close()
  })

  it('checkpoints superseded draft text out of SQLite artifacts immediately', () => {
    const databasePath = createDatabasePath()
    const { store } = createRound(databasePath)
    const draftMarker = 'SUPERSEDED-DRAFT-MARKER-226bd148'
    const withDraft = store.updateUserState('round-1', 0, {
      bundleGroups: [],
      index: 0,
      keptUnreadIds: [],
      processedIds: [],
      replyDrafts: { 'mail-1': { ...replyDraft, bodyText: draftMarker } },
      secondaryActionIds: [],
    })
    expect(databaseArtifacts(databasePath)).toContain(draftMarker)

    store.updateUserState('round-1', withDraft.userState.revision, {
      bundleGroups: [],
      index: 0,
      keptUnreadIds: [],
      processedIds: [],
      replyDrafts: {},
      secondaryActionIds: [],
    })
    expect(databaseArtifacts(databasePath)).not.toContain(draftMarker)
    store.close()
  })
})
