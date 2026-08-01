import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchEmailDetail, fetchUnreadSnapshot, markEmailsRead, unreadFilter } from './jmap.ts'

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
})
