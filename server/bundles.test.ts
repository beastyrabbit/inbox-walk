import { describe, expect, it } from 'vitest'
import type { ReviewEmailSummary } from '../src/shared.ts'
import {
  bundleGroupsConflict,
  extractBundleSignals,
  heuristicBundlePartition,
  heuristicStoryMetadata,
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

  it('joins messages that share exact keys without a provider', () => {
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
    expect(heuristicStoryMetadata([emails[3] as ReviewEmailSummary])).toMatchObject({
      kind: 'standalone',
      membershipConfidence: 1,
      title: 'Unrelated invoice',
    })
    expect(
      bundleGroupsConflict([emails[0] as ReviewEmailSummary], [emails[3] as ReviewEmailSummary]),
    ).toBe(false)
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
