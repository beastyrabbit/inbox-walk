// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { emailDocument } from './App.tsx'
import { plainTextHtml, stripDarkSchemeRules } from './email-document.ts'
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
    const document = emailDocument(email, false)
    expect(document).not.toContain('<script')
    expect(document).not.toContain('https://tracker.example')
    expect(document).toContain('/api/todo/blobs/inline-1?inline=1')
    expect(document).toContain('target="_blank"')
  })

  it('routes explicitly requested remote images through the backend proxy', () => {
    const document = emailDocument(email, true, 'image-token')
    expect(document).toContain('/api/todo/emails/mail-1/images/opaque-image-id?token=image-token')
    expect(document).not.toContain('url=')
    expect(document).not.toContain('src="https://tracker.example/pixel"')
  })

  it('removes every non-proxied resource URL that could violate the iframe CSP', () => {
    const document = emailDocument(
      {
        ...email,
        html: `<svg><image href="https://tracker.example/svg"></image><use xlink:href="https://tracker.example/sprite"></use></svg><video poster="https://tracker.example/poster"><source src="https://tracker.example/movie"></video><table background="https://tracker.example/bg"><tr><td>Text</td></tr></table>`,
      },
      true,
      'image-token',
    )
    expect(document).not.toContain('tracker.example')
    expect(document).not.toMatch(/(?:src|srcset|background|poster|xlink:href)="https?:/i)
  })

  it('removes empty placeholder images instead of showing broken icons', () => {
    const document = emailDocument({ ...email, html: '<p>Text</p><img src="#"><img>' }, true)
    expect(document).not.toContain('<img')
  })

  it('hides unresolved CID and relative images instead of rendering broken icons', () => {
    const document = emailDocument(
      { ...email, html: '<img src="cid:missing"><img src="/relative-logo.png">' },
      true,
    )
    expect(document.match(/data-remote-image="blocked"/g)).toHaveLength(2)
    expect(document).not.toContain('src="cid:missing"')
    expect(document).not.toContain('src="/relative-logo.png"')
  })
})

describe('email document presentation', () => {
  it('keeps head stylesheets and body canvas colours of the mail', () => {
    const document = emailDocument(
      {
        ...email,
        html: `<html><head><style>.btn{background:#1a73e8}</style></head><body bgcolor="#f2f2f2" style="margin:0"><a class="btn">Go</a></body></html>`,
      },
      true,
    )
    expect(document).toContain('.btn{background:#1a73e8}')
    expect(document).toMatch(
      /<div class="mail-root" style="[^"]*background-color: (?:#f2f2f2|rgb\(242, 242, 242\))/,
    )
    expect(document).toContain('margin:0')
  })

  it('adapts mail colours to the dark reader by default and keeps images unchanged', () => {
    const document = emailDocument({ ...email, html: '<p>Text</p>' }, true)
    expect(document).toContain('body { min-height: 100vh; background: #e2e0dc;')
    expect(document).toContain('filter: invert(1) hue-rotate(180deg)')
    expect(document).toContain('img, picture, svg, video { filter: invert(1) hue-rotate(180deg); }')
  })

  it('shows original colours without any filter when requested', () => {
    const document = emailDocument({ ...email, html: '<p>Text</p>' }, true, '', 'original')
    expect(document).not.toContain('filter: invert')
    expect(document).toContain('background: #ffffff')
  })

  it('drops dark-scheme media rules so the light design is the adaptation source', () => {
    const document = emailDocument(
      {
        ...email,
        html: `<style>p{color:#111}@media (prefers-color-scheme: dark){p{color:#eee}.x{background:#000}}p{margin:0}</style><p>Text</p>`,
      },
      true,
    )
    expect(document).not.toContain('prefers-color-scheme')
    expect(document).toContain('p{color:#111}')
    expect(document).toContain('p{margin:0}')
  })

  it('keeps declared image widths but never lets them overflow the reader', () => {
    const document = emailDocument(
      {
        ...email,
        html: `<img src="data:image/png;base64,AA" style="width:100%;max-width:560px"><img src="data:image/png;base64,AA" width="900">`,
      },
      true,
    )
    expect(document).toContain('max-width: min(560px, 100%) !important')
    expect(document).toContain('max-width: min(900px, 100%) !important')
  })

  it('renders plain text natively without inversion', () => {
    const document = emailDocument({ ...email, html: null, text: 'Hallo' }, true)
    expect(document).not.toContain('invert(1)')
    expect(document).toContain('<div class="plain-text">Hallo')
  })
})

describe('plainTextHtml', () => {
  it('escapes markup, links URLs and groups quoted lines', () => {
    const html = plainTextHtml(
      'Siehe <b>hier</b>: https://example.com/a?x=1&y=2.\n> Zitat eins\n>> Zitat zwei\nAntwort',
    )
    expect(html).toContain('&lt;b&gt;hier&lt;/b&gt;')
    expect(html).toContain(
      '<a href="https://example.com/a?x=1&amp;y=2">https://example.com/a?x=1&amp;y=2</a>.',
    )
    expect(html).toContain('<blockquote>Zitat eins\nZitat zwei</blockquote>')
    expect(html).toContain('</blockquote>Antwort\n')
  })
})

describe('stripDarkSchemeRules', () => {
  it('removes nested dark-scheme blocks and keeps everything else', () => {
    const css =
      'a{color:red}@media (prefers-color-scheme: dark){a{color:blue}@media (x){b{c:d}}}b{x:y}@media screen{c{z:1}}'
    expect(stripDarkSchemeRules(css)).toBe('a{color:red}b{x:y}@media screen{c{z:1}}')
  })
})
