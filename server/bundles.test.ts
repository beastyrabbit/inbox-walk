import { describe, expect, it, vi } from 'vitest'
import type { ReviewEmailSummary } from '../src/shared.ts'
import {
  type BundleBuildProgress,
  type BundlePartitionDecision,
  type BundlePartitionInput,
  buildReviewBundlesFromPartition,
  extractBundleSignals,
  heuristicBundlePartition,
  normalizeBundleDecisionPartition,
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
  it('accepts and materializes partitions beyond 10000 items without repeated snapshot scans', async () => {
    let reads = 0
    const emails = Array.from({ length: 10_001 }, (_, index) => ({
      ...mail(String(index), 'Fixture', 'Synthetic'),
      get id() {
        reads += 1
        return String(index)
      },
      receivedAt: new Date(index * 1000).toISOString(),
    }))
    const ids = emails.map((email) => email.id)
    const standalone = normalizeBundleDecisionPartition(ids, {
      standaloneEmailIds: ids,
      stories: [],
    })
    expect(standalone.standaloneEmailIds).toHaveLength(ids.length)
    const oneStory = normalizeBundleDecisionPartition(ids, {
      standaloneEmailIds: [],
      stories: [partitionStory([...ids].reverse())],
    })
    expect(oneStory.stories[0]?.emailIds).toHaveLength(ids.length)
    reads = 0
    const run = await buildReviewBundlesFromPartition('large', emails, async () => ({
      ...standalone,
      standaloneEmailIds: [...ids].reverse(),
    }))
    expect(run.bundles.flatMap((bundle) => bundle.emailIds)).toEqual(ids)
    expect(reads).toBeLessThan(ids.length * 30)
    const grouped = await buildReviewBundlesFromPartition('large', emails, async () => oneStory)
    expect(grouped.bundles[0]?.emailIds).toEqual(ids)
  })
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
      message: 'standalone IDs are invalid',
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

describe('local heuristic partition', () => {
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

  it('does not mistake dates or decimal reference numbers for exact repository or commit keys', () => {
    const invoice = mail('1', 'Ihre Rechnung 20260824', 'Rechnung vom 24/08/2026')
    const appointment = mail('2', 'Terminbestätigung 20260824', 'Termin am 24/08/2026')
    expect(extractBundleSignals(invoice).exactKeys).toEqual(['thread:thread-1'])
    expect(heuristicBundlePartition([invoice, appointment])).toEqual({
      standaloneEmailIds: ['1', '2'],
      stories: [],
    })
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

  it('joins messages that share exact keys and materializes them without a provider', async () => {
    const emails = [
      mail('1', '[beasty/inbox-walk] PR #184 merged', 'Commit 7d2c1fa'),
      mail('2', 'Railway deploy failed', 'beasty/inbox-walk commit 7d2c1fa failed'),
      mail('3', 'Railway deploy healthy', 'beasty/inbox-walk commit 7d2c1fa is healthy'),
      mail('4', 'Unrelated invoice', 'Electricity bill for August'),
    ]
    const partition = heuristicBundlePartition(emails)
    expect(partition.standaloneEmailIds).toEqual(['4'])
    expect(partition.stories.map((story) => story.emailIds)).toEqual([['1', '2', '3']])
    expect(partition.stories[0]).toMatchObject({
      currentState: 'Erfolgreich',
      kind: 'development_workstream',
      linkEvidence: expect.arrayContaining(['repo:beasty/inbox-walk|commit:7d2c1fa']),
    })

    const progress: BundleBuildProgress[] = []
    const run = await buildReviewBundlesFromPartition(
      'snapshot',
      emails,
      async (input) => heuristicBundlePartition(input.emails),
      [],
      { engine: 'heuristic', onProgress: (event) => progress.push(event) },
    )
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['1', '2', '3'], ['4']])
    expect(run.bundles[0]?.timeline.map((item) => item.source)).toEqual([
      'Notifier',
      'Railway',
      'Railway',
    ])
    expect(progress.every((event) => event.engine === 'heuristic')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ codexCallCount: 0, phase: 'complete' })
    validateBundlePartition(
      emails.map((email) => email.id),
      run.bundles,
    )
  })

  it('keeps conflicting repositories separate even when their wording is similar', () => {
    const partition = heuristicBundlePartition([
      mail('1', '[team/alpha] production failed', 'Railway deployment production failed'),
      mail('2', '[team/beta] production failed', 'Railway deployment production failed'),
    ])
    expect(partition).toEqual({ standaloneEmailIds: ['1', '2'], stories: [] })
  })

  it('keeps different repository scopes separate even when a commit-like value is shared', () => {
    const partition = heuristicBundlePartition([
      mail('1', 'Deployment for acme/web 7d2c1fa failed', 'Production failed'),
      mail('2', 'Deployment for shop/api 7d2c1fa failed', 'Production failed'),
    ])
    expect(partition).toEqual({ standaloneEmailIds: ['1', '2'], stories: [] })
  })

  it('keeps signal extraction safe for null sender names', () => {
    const legacyEmail = mail('1', 'Plain notice', 'Standalone notice')
    legacyEmail.from = [
      { name: null, email: 'notify@example.test' },
    ] as unknown as ReviewEmailSummary['from']
    expect(extractBundleSignals(legacyEmail).provider).toBe('example.test')
    expect(heuristicBundlePartition([legacyEmail])).toEqual({
      standaloneEmailIds: ['1'],
      stories: [],
    })
  })
})
