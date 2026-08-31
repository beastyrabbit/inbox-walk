import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewEmailSummary } from '../src/shared.ts'
import {
  type BundleBuildProgress,
  type BundleDecisionCohort,
  type BundleDecisionInput,
  type BundleDecisionResult,
  type BundlePartitionDecision,
  type BundlePartitionInput,
  buildReviewBundles,
  buildReviewBundlesFromPartition,
  extractBundleSignals,
  hashLearningSignal,
  learningSignalsFor,
  normalizeBundleDecisionPartition,
  selectBundleExamples,
  singletonBundleRun,
  validateBundleDecisionPartition,
  validateBundlePartition,
} from './bundles.ts'

function mail(
  id: string,
  subject: string,
  preview: string,
  threadId = `thread-${id}`,
): ReviewEmailSummary {
  return {
    id,
    threadId,
    subject,
    preview,
    receivedAt: `2026-08-24T10:${id.padStart(2, '0')}:00Z`,
    from: [{ name: 'Notifier', email: 'notify@example.test' }],
    to: [{ name: 'Alex', email: 'alex@example.test' }],
    mailboxNames: ['Inbox'],
    hasAttachment: false,
    isNewsletter: false,
  }
}

function partitionStory(emailIds: string[]) {
  return {
    currentState: 'Aktuell',
    emailIds,
    kind: 'order_delivery' as const,
    linkEvidence: ['Gemeinsamer konkreter Vorgang'],
    membershipConfidence: 0.96,
    summary: 'Diese Nachrichten beschreiben denselben Vorgang.',
    title: 'Konkreter Vorgang',
  }
}

describe('global bundle partition builder', () => {
  it.each([379, 500])(
    'passes all %i summaries to exactly one global decision and materializes a full partition',
    async (messageCount) => {
      const emails = Array.from({ length: messageCount }, (_, index) => {
        const email = mail(
          `global-${index.toString().padStart(3, '0')}`,
          `Unique subject ${index}`,
          `Unique preview ${index}`,
        )
        email.receivedAt = new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString()
        return email
      })
      const groupedIds = [emails[0]?.id, emails.at(-1)?.id].filter((id): id is string =>
        Boolean(id),
      )
      const decidePartition = vi.fn(
        async (input: BundlePartitionInput): Promise<BundlePartitionDecision> => {
          expect(input.emails).toHaveLength(messageCount)
          expect(input.emails.map((email) => email.id)).toEqual(emails.map((email) => email.id))
          expect(new Set(input.emails.map((email) => email.id)).size).toBe(messageCount)
          return {
            standaloneEmailIds: input.emails
              .map((email) => email.id)
              .filter((id) => !groupedIds.includes(id)),
            stories: [partitionStory(groupedIds)],
          }
        },
      )

      const run = await buildReviewBundlesFromPartition(
        `global-snapshot-${messageCount}`,
        emails,
        decidePartition,
      )

      expect(decidePartition).toHaveBeenCalledOnce()
      expect(run.bundles).toHaveLength(messageCount - 1)
      expect(run.bundles[0]?.emailIds).toEqual(groupedIds)
      validateBundlePartition(
        emails.map((email) => email.id),
        run.bundles,
      )
    },
  )

  it('lets the global decision connect transitive providers and split exact local signals', async () => {
    const amazon = mail(
      'amazon',
      'Amazon Bestellung 305-1234567-1234567',
      'Die Bestellung wurde bestätigt.',
      'shared-thread',
    )
    amazon.from = [{ name: 'Amazon', email: 'shipment-tracking@amazon.de' }]
    amazon.receivedAt = '2026-08-20T10:00:00Z'
    const dhl = mail(
      'dhl',
      'DHL Sendungsnummer 1234567890',
      'Ein Paket ist unterwegs.',
      'dhl-thread',
    )
    dhl.from = [{ name: 'DHL', email: 'noreply@dhl.de' }]
    dhl.receivedAt = '2026-08-21T10:00:00Z'
    const payment = mail('payment', 'Kartenzahlung', 'Amazon Marketplace', 'payment-thread')
    payment.from = [{ name: 'American Express', email: 'notify@americanexpress.com' }]
    payment.receivedAt = '2026-08-20T10:05:00Z'
    const firstParcel = mail(
      'parcel-1',
      'Bestellung ABC-12345',
      'Tracking 11111111',
      'same-order-thread',
    )
    const secondParcel = mail(
      'parcel-2',
      'Bestellung ABC-12345',
      'Tracking 22222222',
      'same-order-thread',
    )
    firstParcel.receivedAt = '2026-08-22T10:00:00Z'
    secondParcel.receivedAt = '2026-08-23T10:00:00Z'
    const emails = [amazon, dhl, payment, firstParcel, secondParcel]
    const decidePartition = vi.fn(
      async (input: BundlePartitionInput): Promise<BundlePartitionDecision> => {
        expect(input.emails.map((email) => email.id)).toEqual([
          'amazon',
          'dhl',
          'payment',
          'parcel-1',
          'parcel-2',
        ])
        return {
          standaloneEmailIds: ['parcel-1', 'parcel-2'],
          stories: [partitionStory(['amazon', 'dhl', 'payment'])],
        }
      },
    )

    const run = await buildReviewBundlesFromPartition('global-story', emails, decidePartition)

    expect(decidePartition).toHaveBeenCalledOnce()
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([
      ['amazon', 'payment', 'dhl'],
      ['parcel-1'],
      ['parcel-2'],
    ])
    expect(run.bundles[0]).toMatchObject({
      currentState: 'Aktuell',
      title: 'Konkreter Vorgang',
    })
  })

  it.each([
    {
      decision: { standaloneEmailIds: ['one', 'unknown'], stories: [] },
      message: 'unknown snapshot ID',
      name: 'unknown IDs',
    },
    {
      decision: { standaloneEmailIds: ['one', 'one', 'two'], stories: [] },
      message: 'more than once',
      name: 'duplicate IDs',
    },
    {
      decision: { standaloneEmailIds: ['one'], stories: [] },
      message: 'complete snapshot',
      name: 'missing IDs',
    },
    {
      decision: { standaloneEmailIds: ['two'], stories: [partitionStory(['one'])] },
      message: 'at least two emails',
      name: 'one-message stories',
    },
  ])('rejects $name without returning a partial run', async ({ decision, message }) => {
    const emails = [mail('one', 'First', 'First'), mail('two', 'Second', 'Second')]
    expect(() =>
      validateBundleDecisionPartition(
        emails.map((email) => email.id),
        decision,
      ),
    ).toThrow(message)
    await expect(
      buildReviewBundlesFromPartition('invalid-global-partition', emails, async () => decision),
    ).rejects.toThrow(message)
  })

  it('rejects malformed story metadata even when the ID partition is complete', () => {
    const story = partitionStory(['one', 'two'])
    expect(() =>
      validateBundleDecisionPartition(['one', 'two'], {
        standaloneEmailIds: [],
        stories: [{ ...story, kind: 'unknown' }],
      }),
    ).toThrow('story kind is invalid')
    expect(() =>
      validateBundleDecisionPartition(['one', 'two'], {
        standaloneEmailIds: [],
        stories: [{ ...story, membershipConfidence: Number.NaN }],
      }),
    ).toThrow('story confidence is invalid')
  })

  it('normalizes cross-story duplicates by confidence and stable story order', () => {
    const snapshotIds = ['low-only', 'higher-conflict', 'tie-conflict', 'winner-only', 'late-only']
    const decision = {
      standaloneEmailIds: [],
      stories: [
        {
          ...partitionStory(['low-only', 'higher-conflict']),
          membershipConfidence: 0.7,
          title: 'Low confidence',
        },
        {
          ...partitionStory(['higher-conflict', 'tie-conflict', 'winner-only']),
          membershipConfidence: 0.9,
          title: 'Stable winner',
        },
        {
          ...partitionStory(['tie-conflict', 'late-only']),
          membershipConfidence: 0.9,
          title: 'Later tie',
        },
      ],
    }

    expect(() => validateBundleDecisionPartition(snapshotIds, decision)).toThrow('more than once')
    const normalized = normalizeBundleDecisionPartition(snapshotIds, decision)

    expect(normalized).toEqual({
      standaloneEmailIds: ['low-only', 'late-only'],
      stories: [
        expect.objectContaining({
          emailIds: ['higher-conflict', 'tie-conflict', 'winner-only'],
          membershipConfidence: 0.9,
          title: 'Stable winner',
        }),
      ],
    })
    expect(() => validateBundleDecisionPartition(snapshotIds, normalized)).not.toThrow()
  })

  it('prefers a surviving story over explicit standalone membership and fills missing IDs', () => {
    const snapshotIds = ['story-one', 'story-two', 'missing-one', 'explicit-standalone']
    const decision = {
      standaloneEmailIds: ['story-one', 'explicit-standalone'],
      stories: [partitionStory(['story-one', 'story-two'])],
    }

    expect(() => validateBundleDecisionPartition(snapshotIds, decision)).toThrow('more than once')
    expect(normalizeBundleDecisionPartition(snapshotIds, decision)).toEqual({
      standaloneEmailIds: ['missing-one', 'explicit-standalone'],
      stories: [expect.objectContaining({ emailIds: ['story-one', 'story-two'] })],
    })
  })

  it('moves members of a conflict-collapsed story to standalone', () => {
    const snapshotIds = ['collapsed-only', 'conflict', 'winner-only']
    const normalized = normalizeBundleDecisionPartition(snapshotIds, {
      standaloneEmailIds: [],
      stories: [
        {
          ...partitionStory(['collapsed-only', 'conflict']),
          membershipConfidence: 0.7,
          title: 'Collapsed',
        },
        {
          ...partitionStory(['conflict', 'winner-only']),
          membershipConfidence: 0.9,
          title: 'Winner',
        },
      ],
    })

    expect(normalized).toEqual({
      standaloneEmailIds: ['collapsed-only'],
      stories: [
        expect.objectContaining({
          emailIds: ['conflict', 'winner-only'],
          title: 'Winner',
        }),
      ],
    })
    expect(normalized.stories.every((story) => story.emailIds.length >= 2)).toBe(true)
  })

  it.each([
    {
      decision: {
        standaloneEmailIds: [],
        stories: [partitionStory(['known', 'unknown-story'])],
      },
      name: 'a story',
    },
    {
      decision: {
        standaloneEmailIds: ['unknown-standalone'],
        stories: [],
      },
      name: 'standalone IDs',
    },
  ])('keeps unknown IDs in $name as a hard error', ({ decision }) => {
    expect(() => normalizeBundleDecisionPartition(['known', 'other'], decision)).toThrow(
      'unknown snapshot ID',
    )
  })

  it('keeps malformed story metadata as a hard error during normalization', () => {
    expect(() =>
      normalizeBundleDecisionPartition(['one', 'two'], {
        standaloneEmailIds: [],
        stories: [{ ...partitionStory(['one', 'two']), membershipConfidence: 'high' }],
      }),
    ).toThrow('story confidence is invalid')
  })

  it('reports completion only after the full decision has been validated and materialized', async () => {
    const events: BundleBuildProgress[] = []
    const emails = [mail('one', 'First', 'First'), mail('two', 'Second', 'Second')]

    await buildReviewBundlesFromPartition(
      'completed-global-partition',
      emails,
      async () => ({ standaloneEmailIds: ['one', 'two'], stories: [] }),
      [],
      { onProgress: (event) => events.push(event) },
    )

    expect(events.map((event) => event.phase)).toEqual([
      'indexing',
      'deciding',
      'reconciling',
      'finalizing',
      'complete',
    ])
    expect(events.map((event) => event.processedEmailCount)).toEqual([0, 0, 2, 2, 2])
    expect(events.map((event) => event.codexCallCount)).toEqual([0, 1, 1, 1, 1])
  })

  it('reports honest coarse progress and propagates cancellation to the single decision', async () => {
    const controller = new AbortController()
    const events: BundleBuildProgress[] = []
    const emails = [mail('one', 'First', 'First'), mail('two', 'Second', 'Second')]
    const decidePartition = vi.fn(async (_input, signal?: AbortSignal) => {
      controller.abort(new DOMException('Cancelled by user.', 'AbortError'))
      signal?.throwIfAborted()
      return { standaloneEmailIds: ['one', 'two'], stories: [] }
    })

    await expect(
      buildReviewBundlesFromPartition('cancelled-global-partition', emails, decidePartition, [], {
        engine: 'codex',
        onProgress: (event) => events.push(event),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(decidePartition).toHaveBeenCalledOnce()
    expect(events.map((event) => event.phase)).toEqual(['indexing', 'deciding'])
    expect(events.at(-1)).toMatchObject({
      codexCallCount: 1,
      processedEmailCount: 0,
      progress: 0.15,
    })
  })

  it('does not call the global decision for an empty snapshot', async () => {
    const decidePartition = vi.fn()

    await expect(
      buildReviewBundlesFromPartition('empty-global-partition', [], decidePartition),
    ).resolves.toEqual({ bundles: [], fallback: false, snapshotId: 'empty-global-partition' })
    expect(decidePartition).not.toHaveBeenCalled()
  })
})

describe('contextual bundle builder', () => {
  it('extracts provider relationship identifiers without treating URLs as repositories', () => {
    expect(
      extractBundleSignals(
        mail(
          '1',
          '[beasty/inbox-walk] PR #184 merged',
          'Commit 7d2c1fa. See https://github.com/beasty/inbox-walk.',
        ),
      ).exactKeys,
    ).toEqual(
      expect.arrayContaining([
        'repo:beasty/inbox-walk|pr:184',
        'repo:beasty/inbox-walk|commit:7d2c1fa',
      ]),
    )
    expect(
      extractBundleSignals(mail('1', 'Link', 'https://github.com/x/y')).exactKeys,
    ).not.toContain('repo:github.com/x')
  })

  it('does not mistake dates or decimal reference numbers for exact repository or commit keys', async () => {
    const invoice = mail('1', 'Ihre Rechnung 20260824', 'Rechnung vom 24/08/2026')
    const appointment = mail('2', 'Terminbestätigung 20260824', 'Termin am 24/08/2026')
    expect(extractBundleSignals(invoice).exactKeys).toEqual(['thread:thread-1'])
    const run = await buildReviewBundles('snapshot', [invoice, appointment])
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['1'], ['2']])
  })

  it('extracts real order references without treating normal words as order IDs', () => {
    expect(
      extractBundleSignals(
        mail(
          '1',
          'Bestellung Nr. # 100324892',
          'Deine Bestellung 1624603538 wurde versendet. Order wurde bestätigt.',
        ),
      ).exactKeys,
    ).toEqual(expect.arrayContaining(['order:100324892', 'order:1624603538']))
    expect(
      extractBundleSignals(
        mail('2', 'Deine Bestellung wurde versendet', 'Wir haben deine Order lieber geprüft.'),
      ).exactKeys,
    ).toEqual(['thread:thread-2'])
  })

  it('uses normalized one-way relationship signals without exposing sender identity', () => {
    const first = mail('1', 'Private note', 'Hello', 'CaseSensitiveThread')
    first.from = [{ name: 'Dr. Sensitive Person', email: 'sensitive@private-family.example' }]
    const equivalent = { ...first, from: [{ ...first.from[0], name: '  DR. SENSITIVE PERSON  ' }] }

    const signals = learningSignalsFor([first])

    expect(signals).toContain(hashLearningSignal('provider:Dr. Sensitive Person'))
    expect(signals).toEqual(learningSignalsFor([equivalent]))
    expect(signals.every((signal) => /^[a-z][a-z0-9_-]*:sha256:[a-f0-9]{64}$/.test(signal))).toBe(
      true,
    )
    expect(signals.join(' ')).not.toContain('sensitive')
    expect(hashLearningSignal(signals[0] ?? '')).toBe(signals[0])
    const legacyThreadSignal = `thread:sha256:${createHash('sha256')
      .update('thread:CaseSensitiveThread')
      .digest('hex')}`
    expect(signals).toContain(legacyThreadSignal)
    expect(
      selectBundleExamples(
        [
          {
            anchorSignals: [legacyThreadSignal],
            candidateSignals: [],
            correct: true,
            reason: 'Vom Nutzer im Review bestätigt.',
          },
        ],
        signals,
      ),
    ).toHaveLength(1)
  })

  it('keeps signal extraction and the emergency fallback safe for null sender names', () => {
    const legacyEmail = mail('1', 'Plain notice', 'Fallback notice')
    legacyEmail.from = [
      { name: null, email: 'notify@example.test' },
    ] as unknown as ReviewEmailSummary['from']

    expect(extractBundleSignals(legacyEmail).provider).toBe('example.test')
    expect(learningSignalsFor([legacyEmail])).toContain(hashLearningSignal('provider:example.test'))
    expect(() => singletonBundleRun('snapshot', [legacyEmail])).not.toThrow()
    expect(singletonBundleRun('snapshot', [legacyEmail])).toMatchObject({
      bundles: [{ timeline: [{ source: 'example.test' }] }],
      fallback: true,
    })
  })

  it('prejoins exact keys, preserves exclusions, and partitions every message once', async () => {
    const emails = [
      mail('1', '[beasty/inbox-walk] PR #184 merged', 'Commit 7d2c1fa'),
      mail('2', 'Railway deploy failed', 'beasty/inbox-walk commit 7d2c1fa failed'),
      mail('3', 'Railway deploy healthy', 'beasty/inbox-walk commit 7d2c1fa is healthy'),
      mail('4', 'Unrelated invoice', 'Electricity bill for August'),
    ]
    const decide = vi.fn(async () => ({
      includedEmailIds: [],
      kind: 'standalone' as const,
      title: 'Unrelated',
      currentState: 'Open',
      summary: 'Separate story.',
      linkEvidence: [],
      membershipConfidence: 0.9,
    }))
    const run = await buildReviewBundles('snapshot', emails, decide)
    expect(run.bundles).toHaveLength(2)
    expect(run.bundles[0]?.emailIds).toEqual(['1', '2', '3'])
    expect(run.bundles[1]?.emailIds).toEqual(['4'])
    validateBundlePartition(
      emails.map((email) => email.id),
      run.bundles,
    )
  })

  it.each([379, 500])(
    'analyzes and assigns all %i messages without a per-round call cutoff',
    async (messageCount) => {
      const emails = Array.from({ length: messageCount }, (_, index) => {
        const story = Math.floor(index / 8)
        const email = mail(
          `mail-${index.toString().padStart(3, '0')}`,
          `Status zu Vorgang projekt${story.toString().padStart(3, '0')}`,
          `Neuer Schritt für projekt${story.toString().padStart(3, '0')}`,
        )
        email.receivedAt = new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString()
        return email
      })
      const analyzedSeeds = new Set<string>()
      const absorbedCandidates = new Set<string>()
      const decideBatch = vi.fn(async (cohorts: readonly BundleDecisionCohort[]) =>
        cohorts.map((cohort): BundleDecisionResult => {
          for (const seed of cohort.seed) {
            expect(absorbedCandidates.has(seed.id)).toBe(false)
            analyzedSeeds.add(seed.id)
          }
          for (const candidate of cohort.candidates) absorbedCandidates.add(candidate.id)
          return {
            cohortId: cohort.cohortId,
            currentState: 'Aktuell',
            includedEmailIds: cohort.candidates.map((candidate) => candidate.id),
            kind: 'conversation',
            linkEvidence: ['Lokaler Projektbezug'],
            membershipConfidence: 0.98,
            summary: 'Zusammengehörige Statusmeldungen.',
            title: 'Projektstatus',
          }
        }),
      )

      const run = await buildReviewBundles(`snapshot-${messageCount}`, emails, undefined, [], {
        decideBatch,
        engine: 'codex',
      })

      validateBundlePartition(
        emails.map((email) => email.id),
        run.bundles,
      )
      expect(run.bundles.flatMap((bundle) => bundle.emailIds)).toHaveLength(messageCount)
      expect(new Set(run.bundles.flatMap((bundle) => bundle.emailIds)).size).toBe(messageCount)
      expect(analyzedSeeds.size + absorbedCandidates.size).toBe(messageCount)
      expect(decideBatch.mock.calls.length).toBeLessThanOrEqual(Math.ceil(messageCount / 8))
      expect(decideBatch.mock.calls.length).toBeLessThan(10)
    },
  )

  it('batches candidate-free roots so Codex still analyzes every message', async () => {
    const emails = Array.from({ length: 17 }, (_, index) => {
      const email = mail(`solo-${index}`, `Einmalige Meldung ${index}`, `Ohne Verbindung ${index}`)
      email.receivedAt = new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString()
      return email
    })
    const seedIds: string[] = []
    const decideBatch = vi.fn(async (cohorts: readonly BundleDecisionCohort[]) =>
      cohorts.map((cohort): BundleDecisionResult => {
        seedIds.push(...cohort.seed.map((email) => email.id))
        return {
          cohortId: cohort.cohortId,
          currentState: 'Einzeln',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Eigenständige Nachricht.',
          title: cohort.seed[0]?.subject ?? 'Nachricht',
        }
      }),
    )

    const run = await buildReviewBundles('standalone-snapshot', emails, undefined, [], {
      decideBatch,
    })

    expect(seedIds).toHaveLength(17)
    expect(new Set(seedIds).size).toBe(17)
    expect(decideBatch).toHaveBeenCalledTimes(3)
    expect(run.bundles).toHaveLength(17)
  })

  it('shows Codex a nearby cross-provider relationship without exact or lexical overlap', async () => {
    const github = mail('github', 'Change accepted', 'Review completed successfully')
    github.receivedAt = '2026-08-24T10:00:00Z'
    github.from = [{ name: 'GitHub', email: 'notifications@github.com' }]
    const railway = mail('railway', 'Production rollout healthy', 'Service is live')
    railway.receivedAt = '2026-08-24T10:08:00Z'
    railway.from = [{ name: 'Railway', email: 'notify@railway.app' }]
    const githubSignals = extractBundleSignals(github)
    const railwaySignals = extractBundleSignals(railway)
    expect(githubSignals.provider).toBe('GitHub')
    expect(railwaySignals.provider).toBe('Railway')
    expect(githubSignals.exactKeys.filter((key) => railwaySignals.exactKeys.includes(key))).toEqual(
      [],
    )
    expect(
      githubSignals.searchTerms.filter((term) => railwaySignals.searchTerms.includes(term)),
    ).toEqual([])

    const decideBatch = vi.fn(async (cohorts: readonly BundleDecisionCohort[]) =>
      cohorts.map(
        (cohort): BundleDecisionResult => ({
          cohortId: cohort.cohortId,
          includedEmailIds: cohort.candidates.map((candidate) => candidate.id),
          kind: 'development_workstream',
          title: 'Accepted change rollout',
          currentState: 'Healthy',
          summary: 'The accepted change was rolled out successfully.',
          linkEvidence: ['Nearby cross-provider events'],
          membershipConfidence: 0.9,
        }),
      ),
    )

    const run = await buildReviewBundles(
      'cross-source-snapshot',
      [github, railway],
      undefined,
      [],
      {
        decideBatch,
      },
    )

    expect(decideBatch).toHaveBeenCalledOnce()
    expect(decideBatch.mock.calls[0]?.[0]?.[0]).toMatchObject({
      candidates: [{ id: 'railway' }],
      seed: [{ id: 'github' }],
    })
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['github', 'railway']])
  })

  it('bounds cross-provider recall work for 500 unrelated nearby messages', async () => {
    const messageCount = 500
    const emails = Array.from({ length: messageCount }, (_, index) => {
      const email = mail(
        `independent-${index.toString().padStart(3, '0')}`,
        `Activity ${index.toString().padStart(3, '0')}`,
        `Opaque event ${index.toString().padStart(3, '0')}`,
      )
      email.receivedAt = new Date(Date.UTC(2026, 7, 24, 10) + index * 60_000).toISOString()
      email.from =
        index % 2 === 0
          ? [{ name: 'GitHub', email: 'notifications@github.com' }]
          : [{ name: 'Railway', email: 'notify@railway.app' }]
      return email
    })
    const analyzedSeedIds: string[] = []
    let candidateCount = 0
    let cohortCount = 0
    const decideBatch = vi.fn(async (cohorts: readonly BundleDecisionCohort[]) => {
      cohortCount += cohorts.length
      return cohorts.map((cohort): BundleDecisionResult => {
        analyzedSeedIds.push(...cohort.seed.map((email) => email.id))
        candidateCount += cohort.candidates.length
        return {
          cohortId: cohort.cohortId,
          currentState: 'Separate',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Independent event.',
          title: cohort.seed[0]?.subject ?? 'Activity',
        }
      })
    })

    const run = await buildReviewBundles('independent-cross-provider', emails, undefined, [], {
      decideBatch,
    })

    validateBundlePartition(
      emails.map((email) => email.id),
      run.bundles,
    )
    expect(run.bundles).toHaveLength(messageCount)
    expect(analyzedSeedIds).toHaveLength(messageCount)
    expect(new Set(analyzedSeedIds).size).toBe(messageCount)
    expect(cohortCount).toBe(messageCount)
    expect(candidateCount).toBeLessThanOrEqual(messageCount * 8)
    expect(decideBatch.mock.calls.length).toBeLessThanOrEqual(Math.ceil(messageCount / 4))
  })

  it('keeps each Codex cohort bounded when lexical recall is broad', async () => {
    const topics = Array.from(
      { length: 12 },
      (_, index) => `topic${index.toString().padStart(4, '0')}`,
    )
    const seed = mail('seed', topics.join(' '), 'Seed event')
    seed.receivedAt = '2026-08-24T10:00:00Z'
    const emails = [
      seed,
      ...topics.flatMap((topic, topicIndex) =>
        Array.from({ length: 4 }, (_, candidateIndex) => {
          const candidate = mail(
            `candidate-${topicIndex}-${candidateIndex}`,
            `${topic} update-${candidateIndex}`,
            `Distinct event ${topicIndex}-${candidateIndex}`,
          )
          candidate.receivedAt = new Date(
            Date.UTC(2026, 7, 24, 10) + (topicIndex * 4 + candidateIndex + 1) * 60_000,
          ).toISOString()
          return candidate
        }),
      ),
    ]
    const cohortSizes: number[] = []
    const seedCandidateIds: string[] = []
    const decideBatch = vi.fn(async (cohorts: readonly BundleDecisionCohort[]) =>
      cohorts.map((cohort): BundleDecisionResult => {
        cohortSizes.push(cohort.candidates.length)
        if (cohort.seed.some((email) => email.id === 'seed')) {
          seedCandidateIds.push(...cohort.candidates.map((email) => email.id))
        }
        return {
          cohortId: cohort.cohortId,
          currentState: 'Separate',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Separate events.',
          title: 'Separate event',
        }
      }),
    )

    await buildReviewBundles('broad-lexical-snapshot', emails, undefined, [], { decideBatch })

    expect(new Set(seedCandidateIds).size).toBe(48)
    expect(Math.max(...cohortSizes)).toBe(24)
  })

  it('aborts without returning a partial bundle run', async () => {
    const controller = new AbortController()
    const emails = [
      mail('1', 'August electricity invoice', 'Electricity account notice'),
      mail('2', 'August electricity reminder', 'Electricity account notice'),
    ]
    const decideBatch = vi.fn(async (_cohorts, signal?: AbortSignal) => {
      controller.abort(new DOMException('Cancelled by user.', 'AbortError'))
      signal?.throwIfAborted()
      return []
    })

    await expect(
      buildReviewBundles('aborted-snapshot', emails, undefined, [], {
        decideBatch,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(decideBatch).toHaveBeenCalledOnce()
  })

  it('keeps conflicting repositories separate even when their wording is similar', async () => {
    const emails = [
      mail('1', '[team/alpha] production failed', 'Railway deployment production failed'),
      mail('2', '[team/beta] production failed', 'Railway deployment production failed'),
    ]
    const decide = vi.fn(async (input: BundleDecisionInput) => ({
      includedEmailIds: [],
      kind: 'standalone' as const,
      title: input.seed[0]?.subject ?? 'Deployment',
      currentState: 'Open',
      summary: 'Separate repository scope.',
      linkEvidence: [],
      membershipConfidence: 1,
    }))
    const run = await buildReviewBundles('snapshot', emails, decide)
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['1'], ['2']])
    expect(decide).toHaveBeenCalledTimes(2)
    expect(decide.mock.calls.every(([input]) => input.candidates.length === 0)).toBe(true)
  })

  it('lets Codex evaluate different tracking numbers for a possible multi-parcel story', async () => {
    const first = mail(
      '1',
      'DHL Acme Paket unterwegs',
      'Acme Sendungsnummer 1234567890 ist unterwegs',
    )
    first.from = [{ name: 'DHL Paket', email: 'noreply@dhl.de' }]
    const second = mail(
      '2',
      'DHL Acme Paket angekündigt',
      'Acme Sendungsnummer 9876543210 wurde angekündigt',
    )
    second.from = [{ name: 'DHL Paket', email: 'noreply@dhl.de' }]
    const decide = vi.fn(async (input: BundleDecisionInput) => ({
      includedEmailIds: input.candidates.map((candidate) => candidate.id),
      kind: 'order_delivery' as const,
      title: 'Acme-Bestellung: zwei Pakete unterwegs',
      currentState: 'Unterwegs',
      summary: 'Die Bestellung wird in zwei Paketen zugestellt.',
      linkEvidence: ['Acme und zwei Sendungsnummern'],
      membershipConfidence: 0.9,
    }))

    const run = await buildReviewBundles('multi-parcel', [first, second], decide)

    expect(decide.mock.calls[0]?.[0]).toMatchObject({ candidates: [{ id: '2' }] })
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['1', '2']])
  })

  it('keeps different repository scopes separate even when a commit-like value is shared', async () => {
    const run = await buildReviewBundles('snapshot', [
      mail('1', 'Deployment for acme/web 7d2c1fa failed', 'Production failed'),
      mail('2', 'Deployment for shop/api 7d2c1fa failed', 'Production failed'),
    ])
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['1'], ['2']])
  })

  it('rejects candidate injection and incomplete partitions', async () => {
    await expect(
      buildReviewBundles(
        'snapshot',
        [
          mail('1', 'August electricity invoice', 'Electricity account notice'),
          mail('2', 'August electricity reminder', 'Electricity account notice'),
        ],
        async () => ({
          includedEmailIds: ['outside-snapshot'],
          kind: 'standalone',
          title: 'Wrong',
          currentState: 'Wrong',
          summary: 'Wrong',
          linkEvidence: [],
          membershipConfidence: 1,
        }),
      ),
    ).rejects.toThrow('outside its candidate set')
    expect(() => validateBundlePartition(['1', '2'], [{ emailIds: ['1'] }])).toThrow(
      'complete snapshot',
    )
    expect(() => validateBundlePartition(['1'], [{ emailIds: ['1', 'unknown'] }])).toThrow(
      'unknown snapshot ID',
    )
  })

  it('uses no more than two confirmed positive and two confirmed negative examples', () => {
    const examples = Array.from({ length: 8 }, (_, index) => ({
      anchorSignals: [`a:${index}`],
      candidateSignals: [`b:${index}`],
      correct: index < 4,
      reason: `example-${index}`,
    }))
    const selected = selectBundleExamples(examples)
    expect(selected).toHaveLength(4)
    expect(selected.filter((example) => example.correct)).toHaveLength(2)
    expect(selected.filter((example) => !example.correct)).toHaveLength(2)
  })

  it('reports monotonic analysis progress with Codex provenance and call count', async () => {
    const emails = [
      mail('1', 'August electricity invoice', 'Electricity account notice'),
      mail('2', 'August electricity reminder', 'Electricity account notice'),
    ]
    const decide = vi.fn(async () => ({
      includedEmailIds: [],
      kind: 'standalone' as const,
      title: 'Separate notices',
      currentState: 'Open',
      summary: 'Separate stories.',
      linkEvidence: [],
      membershipConfidence: 0.9,
    }))
    const events: BundleBuildProgress[] = []

    await buildReviewBundles('snapshot', emails, decide, [], {
      engine: 'codex',
      model: 'gpt-5.6-sol',
      onProgress: (event) => events.push(event),
    })

    expect(events.map((event) => event.progress)).toEqual(
      [...events.map((event) => event.progress)].sort((left, right) => left - right),
    )
    expect(events.some((event) => event.phase === 'deciding')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      codexCallCount: decide.mock.calls.length,
      engine: 'codex',
      model: 'gpt-5.6-sol',
      phase: 'complete',
      processedEmailCount: emails.length,
      progress: 1,
      totalEmailCount: emails.length,
    })
  })

  it('reports a completed fallback with the attempted Codex call count', () => {
    const emails = [mail('1', 'Notice', 'Fallback notice')]
    const events: BundleBuildProgress[] = []

    const run = singletonBundleRun('snapshot', emails, {
      codexCallCount: 3,
      model: 'gpt-5.6-sol',
      onProgress: (event) => events.push(event),
    })

    expect(run.fallback).toBe(true)
    expect(events.map((event) => event.phase)).toEqual(['fallback', 'complete'])
    expect(events.map((event) => event.progress)).toEqual([0.95, 1])
    expect(events.at(-1)).toMatchObject({
      codexCallCount: 3,
      engine: 'fallback',
      model: 'gpt-5.6-sol',
      processedEmailCount: 1,
      totalEmailCount: 1,
    })
  })
})
