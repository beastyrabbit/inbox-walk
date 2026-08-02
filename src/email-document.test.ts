// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { emailDocument } from './App.tsx'
import type { ReviewEmail } from './shared.ts'

const email: ReviewEmail = {
  id: 'mail-1',
  threadId: 'thread-1',
  subject: 'Test',
  receivedAt: '2026-08-01T10:00:00Z',
  from: [],
  to: [],
  cc: [],
  replyTo: [],
  messageId: [],
  inReplyTo: [],
  references: [],
  preview: '',
  text: '',
  mailboxNames: [],
  hasAttachment: false,
  isNewsletter: false,
  canOneClickUnsubscribe: false,
  bodyTruncated: false,
  attachments: [],
  inlineResources: [
    { blobId: 'inline-1', cid: 'logo', name: 'logo.png', type: 'image/png', size: 10 },
  ],
  html: `<script>alert(1)</script><style>.hero{background:url(https://tracker.example/a)}</style><img src="https://tracker.example/pixel"><img src="cid:logo"><a href="https://example.com">Open</a>`,
}

describe('email document isolation', () => {
  it('sanitizes scripts and blocks remote resources by default', () => {
    const document = emailDocument(email, 'snap-1', false)
    expect(document).not.toContain('<script')
    expect(document).not.toContain('https://tracker.example')
    expect(document).toContain('/api/reviews/snap-1/blobs/inline-1?inline=1')
    expect(document).toContain('target="_blank"')
  })

  it('routes explicitly requested remote images through the backend proxy', () => {
    const document = emailDocument(email, 'snap-1', true)
    expect(document).toContain(
      '/api/reviews/snap-1/emails/mail-1/images?token=&amp;url=https%3A%2F%2Ftracker.example%2Fpixel',
    )
    expect(document).not.toContain('src="https://tracker.example/pixel"')
  })
})
