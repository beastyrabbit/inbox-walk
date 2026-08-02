import { describe, expect, it } from 'vitest'
import type { MailIdentity, MailResource, ThreadMessage } from '../src/shared.ts'
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
  canOneClickUnsubscribe: false,
  bodyTruncated: false,
  inlineResources: [],
  attachments: [],
}

describe('reply construction', () => {
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

  it('includes every supported attachment and fails closed through injected processing', async () => {
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
