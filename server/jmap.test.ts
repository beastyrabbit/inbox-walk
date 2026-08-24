import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchEmailDetail,
  fetchUnreadEmailIds,
  fetchUnreadSnapshot,
  markEmailsRead,
  moveEmailsOutOfSpam,
  tagEmailsForLaterUnsubscribe,
  unreadFilter,
} from './jmap.ts'

function jmapResponse(methodResponses: unknown[]) {
  return new Response(JSON.stringify({ methodResponses }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Fastmail JMAP adapter', () => {
  it('queries only unseen, non-draft messages', () => {
    expect(unreadFilter()).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$seen' }, { notKeyword: '$draft' }],
    })
  })

  it('switches explicitly between non-spam and spam queries', () => {
    expect(
      unreadFilter(
        {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        'junk',
      ),
    ).toEqual({
      operator: 'AND',
      conditions: [
        { notKeyword: '$seen' },
        { notKeyword: '$draft' },
        { operator: 'NOT', conditions: [{ inMailbox: 'junk' }] },
      ],
    })
    expect(
      unreadFilter(
        {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'only',
          timeRange: 'all',
        },
        'junk',
      ),
    ).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$seen' }, { notKeyword: '$draft' }, { inMailbox: 'junk' }],
    })
  })

  it('loads and maps an unread snapshot while excluding sent-only mail', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            apiUrl: 'https://api.example/jmap',
            downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}?type={type}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1' },
            capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 10 } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        jmapResponse([
          [
            'Mailbox/get',
            {
              list: [
                { id: 'inbox', name: 'Inbox', role: 'inbox' },
                { id: 'sent', name: 'Sent', role: 'sent' },
              ],
            },
            'mailboxes',
          ],
        ]),
      )
      .mockResolvedValueOnce(
        jmapResponse([['Email/query', { ids: ['incoming', 'outgoing'], total: 2 }, 'query']]),
      )
      .mockResolvedValueOnce(
        jmapResponse([
          [
            'Email/get',
            {
              list: [
                {
                  id: 'incoming',
                  threadId: 'thread-1',
                  mailboxIds: { inbox: true },
                  receivedAt: '2026-08-01T10:00:00Z',
                  from: [{ name: 'Mara', email: 'mara@example.com' }],
                  to: [{ name: 'Alex', email: 'alex@example.com' }],
                  subject: 'Hallo',
                  preview: 'Text',
                  hasAttachment: true,
                  htmlBody: [{ partId: 'html', type: 'text/html' }],
                  textBody: [{ partId: 'text', type: 'text/plain' }],
                  bodyValues: { html: { value: '<p>Text</p>' }, text: { value: 'Text' } },
                  attachments: [
                    { blobId: 'blob-1', name: 'note.pdf', type: 'application/pdf', size: 1200 },
                  ],
                },
                {
                  id: 'outgoing',
                  threadId: 'thread-2',
                  mailboxIds: { sent: true },
                  receivedAt: '2026-08-01T09:00:00Z',
                  from: [],
                  to: [],
                  subject: 'Sent',
                  bodyValues: {},
                },
              ],
            },
            'emails',
          ],
        ]),
      )
      .mockResolvedValueOnce(
        jmapResponse([['Email/query', { ids: ['incoming', 'outgoing'], total: 2 }, 'query-check']]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await fetchUnreadSnapshot('secret-token')
    expect(snapshot.emails).toHaveLength(1)
    expect(snapshot.emails[0]).toMatchObject({
      id: 'incoming',
      subject: 'Hallo',
      hasAttachment: true,
    })
    expect(snapshot.totalBeforeLimit).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer secret-token' })
  })

  it('freezes every matching message when the snapshot contains more than 250 IDs', async () => {
    const ids = Array.from({ length: 301 }, (_, index) => `mail-${index}`)
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/jmap/session')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'https://api.example/jmap',
            downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1' },
            capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
          }),
          { status: 200 },
        )
      }
      const request = JSON.parse(String(init?.body)) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>
      }
      const [method, arguments_, callId] = request.methodCalls[0] ?? []
      if (method === 'Mailbox/get') {
        return jmapResponse([
          ['Mailbox/get', { list: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }] }, callId],
        ])
      }
      if (method === 'Email/query') {
        const position = Number(arguments_?.position ?? 0)
        const limit = Number(arguments_?.limit ?? 250)
        return jmapResponse([
          [
            'Email/query',
            {
              ids: limit === 1 ? ids.slice(0, 1) : ids.slice(position, position + limit),
              queryState: 'stable-state',
              total: ids.length,
            },
            callId,
          ],
        ])
      }
      if (method === 'Email/get') {
        const wanted = arguments_?.ids as string[]
        return jmapResponse([
          [
            'Email/get',
            {
              list: wanted.map((id) => ({
                id,
                threadId: `thread-${id}`,
                mailboxIds: { inbox: true },
                receivedAt: '2026-08-24T10:00:00Z',
                from: [{ name: 'Sender', email: 'sender@example.test' }],
                to: [{ name: 'Alex', email: 'alex@example.test' }],
                subject: id,
                preview: 'Snapshot test',
                bodyValues: {},
              })),
            },
            callId,
          ],
        ])
      }
      throw new Error(`Unexpected JMAP method: ${method}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await fetchUnreadSnapshot('secret-token')
    expect(snapshot.emails).toHaveLength(301)
    expect(snapshot.emails.map((email) => email.id)).toEqual(ids)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.totalBeforeLimit).toBe(301)
  })

  it('does not classify message body blobs as attachments', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jmapResponse([
        [
          'Email/get',
          {
            list: [
              {
                id: 'mail-1',
                threadId: 'thread-1',
                mailboxIds: { inbox: true },
                receivedAt: '2026-08-01T10:00:00Z',
                from: [],
                to: [],
                subject: 'Body resources',
                bodyStructure: {
                  type: 'multipart/alternative',
                  subParts: [
                    { partId: 'text', blobId: 'body-text', type: 'text/plain' },
                    { partId: 'html', blobId: 'body-html', type: 'text/html' },
                  ],
                },
                textBody: [{ partId: 'text', blobId: 'body-text', type: 'text/plain' }],
                htmlBody: [{ partId: 'html', blobId: 'body-html', type: 'text/html' }],
                bodyValues: {
                  text: { value: 'Hello' },
                  html: { value: '<p>Hello</p>' },
                },
                attachments: [
                  { blobId: 'file-1', name: 'real.pdf', type: 'application/pdf', size: 1200 },
                  {
                    blobId: 'inline-1',
                    cid: '<logo>',
                    name: 'logo.png',
                    type: 'image/png',
                    size: 800,
                  },
                ],
              },
            ],
          },
          'emails',
        ],
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const detail = await fetchEmailDetail(
      {
        accountId: 'acc-1',
        apiUrl: 'https://api.example/jmap',
        downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}',
        maxObjectsInGet: 10,
        maxObjectsInSet: 10,
        username: 'alex@example.com',
      },
      'token',
      'mail-1',
      [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
    )

    expect(detail.attachments.map((item) => item.blobId)).toEqual(['file-1'])
    expect(detail.inlineResources.map((item) => item.blobId)).toEqual(['inline-1'])
    expect(detail.bodyTruncated).toBe(false)
  })

  it('uses an Email/set keyword patch and reports individual failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jmapResponse([
        [
          'Email/set',
          {
            updated: { a: null },
            notUpdated: { b: { type: 'forbidden', description: 'No access' } },
          },
          'mark-read',
        ],
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await markEmailsRead(
      {
        accountId: 'acc-1',
        apiUrl: 'https://api.example/jmap',
        downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}',
        maxObjectsInGet: 10,
        maxObjectsInSet: 10,
        username: 'alex@example.com',
      },
      'token',
      ['a', 'b'],
    )
    expect(result).toEqual({ markedIds: ['a'], failed: [{ id: 'b', reason: 'No access' }] })
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request.methodCalls[0]).toEqual([
      'Email/set',
      {
        accountId: 'acc-1',
        update: { a: { 'keywords/$seen': true }, b: { 'keywords/$seen': true } },
      },
      'mark-read',
    ])
  })

  it('reconciles retained history IDs with their current unread state', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jmapResponse([
        [
          'Email/get',
          {
            list: [
              { id: 'still-unread', keywords: {} },
              { id: 'now-read', keywords: { $seen: true } },
            ],
            notFound: ['deleted'],
          },
          'history-emails',
        ],
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const unreadIds = await fetchUnreadEmailIds(
      {
        accountId: 'acc-1',
        apiUrl: 'https://api.example/jmap',
        downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}',
        maxObjectsInGet: 10,
        maxObjectsInSet: 10,
        username: 'alex@example.com',
      },
      'token',
      ['still-unread', 'now-read', 'deleted'],
    )

    expect(unreadIds).toEqual(new Set(['still-unread']))
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request.methodCalls[0]).toEqual([
      'Email/get',
      {
        accountId: 'acc-1',
        ids: ['still-unread', 'now-read', 'deleted'],
        properties: ['id', 'keywords'],
      },
      'history-emails',
    ])
  })

  it('moves messages out of Spam and into Inbox', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jmapResponse([
          [
            'Mailbox/get',
            {
              list: [
                { id: 'inbox', name: 'Inbox', role: 'inbox' },
                { id: 'junk', name: 'Spam', role: 'junk' },
              ],
            },
            'mailboxes',
          ],
        ]),
      )
      .mockResolvedValueOnce(jmapResponse([['Email/set', { updated: { a: null } }, 'not-spam']]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await moveEmailsOutOfSpam(
      {
        accountId: 'acc-1',
        apiUrl: 'https://api.example/jmap',
        downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}',
        maxObjectsInGet: 10,
        maxObjectsInSet: 10,
        username: 'alex@example.com',
      },
      'token',
      ['a'],
    )

    expect(result).toEqual({ failed: [], succeededIds: ['a'] })
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(request.methodCalls[0]).toEqual([
      'Email/set',
      {
        accountId: 'acc-1',
        update: {
          a: { 'mailboxIds/inbox': true, 'mailboxIds/junk': null },
        },
      },
      'not-spam',
    ])
  })

  it('creates and applies a deferred newsletter-unsubscribe label', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jmapResponse([['Mailbox/get', { list: [] }, 'mailboxes']]))
      .mockResolvedValueOnce(
        jmapResponse([
          [
            'Mailbox/set',
            { created: { deferredUnsubscribe: { id: 'unsubscribe-label' } } },
            'create-unsubscribe-mailbox',
          ],
        ]),
      )
      .mockResolvedValueOnce(
        jmapResponse([['Email/set', { updated: { news: null } }, 'tag-unsubscribe']]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await tagEmailsForLaterUnsubscribe(
      {
        accountId: 'acc-1',
        apiUrl: 'https://api.example/jmap',
        downloadUrl: 'https://api.example/download/{accountId}/{blobId}/{name}',
        maxObjectsInGet: 10,
        maxObjectsInSet: 10,
        username: 'alex@example.com',
      },
      'token',
      ['news'],
    )

    expect(result).toEqual({ failed: [], succeededIds: ['news'] })
    const createRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(createRequest.methodCalls[0][1].create.deferredUnsubscribe).toMatchObject({
      name: 'Newsletter abmelden',
      parentId: null,
    })
    const tagRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
    expect(tagRequest.methodCalls[0][1].update).toEqual({
      news: { 'mailboxIds/unsubscribe-label': true },
    })
  })
})
