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
  remoteImageIds: { 'https://tracker.example/pixel': 'opaque-image-id' },
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
    const document = emailDocument(email, 'snap-1', true, 'image-token')
    expect(document).toContain(
      '/api/reviews/snap-1/emails/mail-1/images/opaque-image-id?token=image-token',
    )
    expect(document).not.toContain('url=')
    expect(document).not.toContain('src="https://tracker.example/pixel"')
  })

  it('removes every non-proxied resource URL that could violate the iframe CSP', () => {
    const document = emailDocument(
      {
        ...email,
        html: `<svg><image href="https://tracker.example/svg"></image><use xlink:href="https://tracker.example/sprite"></use></svg><video poster="https://tracker.example/poster"><source src="https://tracker.example/movie"></video><table background="https://tracker.example/bg"><tr><td>Text</td></tr></table>`,
      },
      'snap-1',
      true,
      'image-token',
    )
    expect(document).not.toContain('tracker.example')
    expect(document).not.toMatch(/(?:src|srcset|background|poster|xlink:href)="https?:/i)
  })

  it('prevents mail color overrides from defeating the dark reader palette', () => {
    const document = emailDocument(
      {
        ...email,
        html: '<div style="background-color:#fff !important;color:#111!important">Text</div>',
      },
      'snap-1',
      true,
    )
    expect(document).not.toMatch(/(?:#fff|#111)\s*!\s*important/i)
    expect(document).toContain('background-color:#fff')
  })

  it('removes empty placeholder images instead of showing broken icons', () => {
    const document = emailDocument(
      { ...email, html: '<p>Text</p><img src="#"><img>' },
      'snap-1',
      true,
    )
    expect(document).not.toContain('<img')
  })

  it('hides unresolved CID and relative images instead of rendering broken icons', () => {
    const document = emailDocument(
      { ...email, html: '<img src="cid:missing"><img src="/relative-logo.png">' },
      'snap-1',
      true,
    )
    expect(document.match(/data-remote-image="blocked"/g)).toHaveLength(2)
    expect(document).not.toContain('src="cid:missing"')
    expect(document).not.toContain('src="/relative-logo.png"')
  })
})
