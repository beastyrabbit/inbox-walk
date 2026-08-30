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
    bundleCallLimit: 17,
    bundleExamples: [rawBundleExample],
    csrfToken: 'csrf-token',
    emails,
    filters,
    id: 'round-1',
    imageToken: 'image-token',
    mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
    missingIds: ['gone-mail'],
    mode: 'demo',
    totalBeforeLimit: 3,
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
    expect(round.bundleCallLimit).toBe(17)
    expect(round.bundleExamples).toEqual([storedBundleExample])
    expect(round.analysis).toMatchObject({
      callCount: 0,
      phase: 'queued',
      processedEmailCount: 0,
      progress: 0,
      status: 'pending',
      totalEmailCount: 2,
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
    store.close()

    const reopened = createRoundStore(databasePath)
    const restored = reopened.get('round-1')
    expect(restored).not.toBeNull()
    expect(restored).toMatchObject({
      bundleCallLimit: 17,
      bundleRun: bundleRun(),
      bundleExamples: [storedBundleExample],
      csrfToken: 'csrf-token',
      emails,
      filters,
      id: 'round-1',
      imageToken: 'image-token',
      mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
      missingIds: ['gone-mail'],
      mode: 'demo',
      totalBeforeLimit: 3,
      truncated: false,
    })
    expect(restored?.analysis).toMatchObject({
      callCount: 3,
      engine: 'codex',
      model: 'gpt-5.6-sol',
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
      ALTER TABLE review_round DROP COLUMN bundle_call_limit;
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
    expect(migrated.get('round-1')?.bundleCallLimit).toBe(64)
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
    ).toBe(4)
    inspected.close()
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
