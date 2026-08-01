import { describe, expect, it } from 'vitest'
import type { MailIdentity, MailResource, ThreadMessage } from '../src/shared.ts'
import {
  appendSignature,
  computeReplyRecipients,
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
})
