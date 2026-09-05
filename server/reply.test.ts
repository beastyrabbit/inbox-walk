import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailIdentity, MailResource, ThreadMessage } from '../src/shared.ts'
import { IoError, withIoDeadline } from './io.ts'
import { JmapError } from './jmap.ts'
import {
  appendSignature,
  computeReplyRecipients,
  generateReply,
  ReplyError,
  validateAttachmentManifest,
} from './reply.ts'

const identity: MailIdentity = {
  id: 'identity-1',
  name: 'Alex',
  email: 'alex@example.com',
  textSignature: 'Viele Grüße\nAlex',
  htmlSignature: '',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const message: ThreadMessage = {
  id: 'mail-1',
  threadId: 'thread-1',
  subject: 'Termin',
  receivedAt: '2026-08-01T10:00:00Z',
  sentAt: null,
  from: [{ name: 'Mara', email: 'mara@example.com' }],
  to: [{ name: 'Alex', email: 'alex@example.com' }],
  cc: [
    { name: 'Alex', email: 'alex@example.com' },
    { name: 'Kai', email: 'kai@example.com' },
  ],
  replyTo: [{ name: 'Mara Reply', email: 'reply@example.com' }],
  messageId: ['mail-1@example.com'],
  inReplyTo: [],
  references: [],
  preview: '',
  text: 'Text',
  html: null,
  mailboxNames: ['Inbox'],
  hasAttachment: false,
  isNewsletter: false,
  bodyTruncated: false,
  inlineResources: [],
  attachments: [],
}

describe('reply construction', () => {
  const context = {
    accountId: 'account-1',
    apiUrl: 'https://api.example/jmap',
    downloadUrl: 'https://api.example/{blobId}',
    maxObjectsInGet: 10,
    maxObjectsInSet: 10,
    username: 'alex@example.com',
  }
  const request = { requestId: 'fixture', roughNotes: 'Bestätigen.' }
  const document = { blobId: 'document', name: 'brief.pdf', type: 'application/pdf', size: 8 }

  it('uses the outgoing sender identity and its signature when continuing a thread', () => {
    const second = {
      ...identity,
      id: 'identity-2',
      email: 'second@example.com',
      textSignature: 'Second signature',
    }
    const recipients = computeReplyRecipients(
      {
        ...message,
        from: [{ name: 'Second', email: second.email }],
        to: [{ name: 'Mara', email: 'mara@example.com' }],
      },
      [identity, second],
    )
    expect(recipients).toMatchObject({
      identityId: second.id,
      from: { email: second.email },
      to: [{ email: 'mara@example.com' }],
      cc: [{ email: 'kai@example.com' }],
    })
    expect(appendSignature('Reply', second)).toBe('Reply\n\nSecond signature')
  })

  it('rejects a truncated older body before any download, extraction or inference', async () => {
    const dependencies = { download: vi.fn(), extractDocument: vi.fn(), runCodex: vi.fn() }
    await expect(
      generateReply(
        context,
        'fixture',
        [
          { ...message, bodyTruncated: true, attachments: [document] },
          { ...message, id: 'latest' },
        ],
        request,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_THREAD' })
    for (const call of Object.values(dependencies)) expect(call).not.toHaveBeenCalled()
  })

  it.each(['failed', 'empty', 'large', 'interrupted'] as const)(
    'rejects %s attachment processing before inference',
    async (failure) => {
      const runCodex = vi.fn()
      const download = vi.fn(async () =>
        failure === 'interrupted'
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error('interrupted'))
                },
              }),
            )
          : new Response('pdf-data'),
      )
      const extractDocument = vi.fn(async () => {
        if (failure === 'failed') throw new Error('extractor failed')
        return failure === 'empty' ? '' : 'x'.repeat(1_000_001)
      })
      await expect(
        generateReply(context, 'fixture', [{ ...message, attachments: [document] }], request, {
          download,
          extractDocument,
          runCodex,
        }),
      ).rejects.toBeInstanceOf(ReplyError)
      expect(runCodex).not.toHaveBeenCalled()
    },
  )

  it.each([
    new JmapError('Session expired', 'FASTMAIL_AUTH_EXPIRED', 401),
    new JmapError('Attachment missing', 'BLOB_NOT_FOUND', 404),
    new IoError('Upstream deadline', 'IO_TIMEOUT'),
  ])('preserves attachment error $code before inference', async (error) => {
    const runCodex = vi.fn()
    await expect(
      generateReply(context, 'fixture', [{ ...message, attachments: [document] }], request, {
        download: async () => {
          throw error
        },
        runCodex,
      }),
    ).rejects.toBe(error)
    expect(runCodex).not.toHaveBeenCalled()
  })

  it('distinguishes interrupted downloads from expired deadlines before inference', async () => {
    const runCodex = vi.fn()
    const generate = (download: () => Promise<Response>) =>
      generateReply(context, 'fixture', [{ ...message, attachments: [document] }], request, {
        download,
        runCodex,
      })
    await expect(
      generate(async () => {
        throw new Error('Network interrupted')
      }),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_DOWNLOAD_FAILED',
      status: 502,
      message: 'Ein Anhang konnte nicht vollständig geladen werden. Bitte erneut versuchen.',
    })
    await expect(
      withIoDeadline(() => generate(() => new Promise(() => {})), 10),
    ).rejects.toMatchObject({ code: 'IO_TIMEOUT' })
    expect(runCodex).not.toHaveBeenCalled()
  })

  it('cancels an extraction that never settles without calling the provider', async () => {
    const runCodex = vi.fn()
    const { withIoDeadline } = await import('./io.ts')
    const pending = withIoDeadline(
      () =>
        generateReply(context, 'fixture', [{ ...message, attachments: [document] }], request, {
          download: async () => new Response('pdf'),
          extractDocument: () => new Promise(() => {}),
          runCodex,
        }),
      15,
    )
    await expect(pending).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACTION_TIMEOUT' })
    expect(runCodex).not.toHaveBeenCalled()
  })

  it('bounds actual attachment bytes before buffering a falsely small manifest', async () => {
    const runCodex = vi.fn()
    let cancelled = false
    let chunks = 0
    const download = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            chunks += 1
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    await expect(
      generateReply(context, 'fixture', [{ ...message, attachments: [document] }], request, {
        download,
        runCodex,
      }),
    ).rejects.toMatchObject({ code: 'ATTACHMENTS_TOO_LARGE' })
    expect(cancelled).toBe(true)
    expect(chunks).toBeLessThan(49)
    expect(runCodex).not.toHaveBeenCalled()
  })

  it.each(['failure', 'empty', 'oversized'] as const)(
    'checks %s Tika responses through the actual adapter',
    async (kind) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(kind === 'oversized' ? 'x'.repeat(1_000_001) : '', {
              status: kind === 'failure' ? 502 : 200,
            }),
        ),
      )
      const runCodex = vi.fn()
      await expect(
        generateReply(context, 'fixture', [{ ...message, attachments: [document] }], request, {
          download: async () => new Response('pdf'),
          runCodex,
        }),
      ).rejects.toBeInstanceOf(ReplyError)
      expect(runCodex).not.toHaveBeenCalled()
    },
  )
  it('computes reply-all while excluding every own identity', () => {
    expect(computeReplyRecipients(message, [identity])).toMatchObject({
      identityId: 'identity-1',
      to: [{ name: 'Mara Reply', email: 'reply@example.com' }],
      cc: [{ name: 'Kai', email: 'kai@example.com' }],
      subject: 'Re: Termin',
    })
  })

  it('never selects a wildcard identity as the draft sender', () => {
    const wildcard = { ...identity, id: 'wildcard', email: '*@example.com' }
    expect(computeReplyRecipients(message, [wildcard, identity]).identityId).toBe(identity.id)
    expect(() => computeReplyRecipients(message, [wildcard])).toThrowError(
      expect.objectContaining({ code: 'NO_IDENTITY' }),
    )
  })

  it('fails closed when any attachment type is unsupported', () => {
    const resource: MailResource = {
      blobId: 'blob-1',
      name: 'archive.zip',
      type: 'application/zip',
      size: 100,
    }
    expect(() => validateAttachmentManifest([resource])).toThrowError(ReplyError)
    try {
      validateAttachmentManifest([resource])
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_ATTACHMENT' })
    }
  })

  it('fails closed before download when declared attachments exceed 45 MiB', () => {
    expect(() =>
      validateAttachmentManifest([
        {
          blobId: 'blob-1',
          name: 'large.pdf',
          type: 'application/pdf',
          size: 46 * 1024 * 1024,
        },
      ]),
    ).toThrow(/45 MiB/)
  })

  it('adds the selected Fastmail identity signature exactly once', () => {
    expect(appendSignature('Bis Donnerstag.', identity)).toBe(
      'Bis Donnerstag.\n\nViele Grüße\nAlex',
    )
  })

  it('turns an expired Codex subscription login into an actionable app error', async () => {
    await expect(
      generateReply(
        {
          accountId: 'account-1',
          apiUrl: 'https://api.example/jmap',
          downloadUrl: 'https://api.example/download/{blobId}',
          maxObjectsInGet: 10,
          maxObjectsInSet: 10,
          username: 'alex@example.com',
        },
        'unused-token',
        [message],
        { requestId: crypto.randomUUID(), roughNotes: 'Bestätigen.' },
        {
          runCodex: async () => {
            throw new Error('OAuth token is unauthorized')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'CODEX_AUTH_FAILED', status: 503 })
  })

  it.each([
    {
      providerMessage: 'You have 120000 weighted tokens left — usage limit reached',
      expected: { code: 'CODEX_USAGE_LIMIT', retryable: false, status: 429 },
    },
    {
      providerMessage: 'This request exceeds the maximum number of tokens allowed',
      expected: { code: 'CODEX_CONTEXT_LIMIT', retryable: false, status: 422 },
    },
    {
      providerMessage: 'Codex inference timed out after 300000 ms.',
      expected: { code: 'CODEX_TIMEOUT', retryable: false, status: 504 },
    },
  ])(
    'classifies provider limits without claiming OAuth expired',
    async ({ providerMessage, expected }) => {
      await expect(
        generateReply(
          {
            accountId: 'account-1',
            apiUrl: 'https://api.example/jmap',
            downloadUrl: 'https://api.example/download/{blobId}',
            maxObjectsInGet: 10,
            maxObjectsInSet: 10,
            username: 'alex@example.com',
          },
          'unused-token',
          [message],
          { requestId: crypto.randomUUID(), roughNotes: 'Bestätigen.' },
          {
            runCodex: async () => {
              throw new Error(providerMessage)
            },
          },
        ),
      ).rejects.toMatchObject(expected)
    },
  )

  it('includes all supported documents and images in the injected provider input', async () => {
    const withAttachments: ThreadMessage = {
      ...message,
      hasAttachment: true,
      attachments: [
        { blobId: 'document', name: 'brief.pdf', type: 'application/pdf', size: 8 },
        { blobId: 'image', name: 'plan.png', type: 'image/png', size: 8 },
      ],
    }
    let prompt = ''
    let imageCount = 0
    const result = await generateReply(
      {
        accountId: 'account-1',
        apiUrl: 'https://api.example/jmap',
        downloadUrl: 'https://api.example/download/{blobId}',
        maxObjectsInGet: 10,
        maxObjectsInSet: 10,
        username: 'alex@example.com',
      },
      'unused-token',
      [withAttachments],
      { requestId: crypto.randomUUID(), roughNotes: 'Bestätigen.' },
      {
        download: async (_context, _token, resource) =>
          new Response(resource.blobId === 'image' ? 'png-data' : 'pdf-data'),
        extractDocument: async (resource) => `Vollständiger Inhalt von ${resource.name}`,
        runCodex: async (input) => {
          prompt = input.prompt
          imageCount = input.images.length
          return {
            bodyText: 'Bestätigt.',
            supportedDetails: [{ detail: 'Bestätigung', sourceMessageIds: ['mail-1'] }],
            questions: [],
            warnings: [],
          }
        },
      },
    )
    expect(prompt).toContain('Vollständiger Inhalt von brief.pdf')
    expect(imageCount).toBe(1)
    expect(result.attachmentManifest).toHaveLength(2)
  })
})
