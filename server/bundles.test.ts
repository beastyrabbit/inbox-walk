import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewEmailSummary } from '../src/shared.ts'
import {
  type BundleBuildProgress,
  buildReviewBundles,
  extractBundleSignals,
  hashLearningSignal,
  learningSignalsFor,
  selectBundleExamples,
  singletonBundleRun,
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

  it('keeps conflicting repositories separate even when their wording is similar', async () => {
    const emails = [
      mail('1', '[team/alpha] production failed', 'Railway deployment production failed'),
      mail('2', '[team/beta] production failed', 'Railway deployment production failed'),
    ]
    const decide = vi.fn(async () => {
      throw new Error('Conflicting candidates must not reach Codex')
    })
    const run = await buildReviewBundles('snapshot', emails, decide)
    expect(run.bundles.map((bundle) => bundle.emailIds)).toEqual([['1'], ['2']])
    expect(decide).not.toHaveBeenCalled()
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
