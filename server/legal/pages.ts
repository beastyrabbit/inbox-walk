import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type LegalDocument, type LegalLanguage, legalNotices, privacyPolicies } from './content.ts'

// Match the app palette without requiring fonts, stylesheets, or bypassed asset paths.
const css = `
:root{color-scheme:dark;font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eee9df;background:#141310}
*{box-sizing:border-box}body{margin:0}main{max-width:800px;margin:auto;padding:32px 24px 64px}
nav{display:flex;flex-wrap:wrap;gap:12px 24px;padding:16px 0;border-block:1px solid #38342e;font-size:.9rem}
a{color:#e28a67;text-underline-offset:.2em}a:hover{color:#eee9df}a:focus-visible{outline:3px solid #db7654;outline-offset:4px}
h1{font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.2;margin:32px 0 24px;letter-spacing:-.025em}
h2{font-size:1.25rem;line-height:1.4;margin:0 0 16px}section{margin:32px 0;padding-top:24px;border-top:1px solid #38342e}
p,ul{margin:0 0 18px}li{margin:4px 0}p,li,h1,h2{overflow-wrap:anywhere}ul{padding-left:24px}
.table-scroll{overflow-x:auto;margin:0 0 18px}table{border-collapse:collapse;width:100%;min-width:680px;font-size:.9rem}th,td{border:1px solid #38342e;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#201e1a}th:first-child,td:first-child{min-width:130px}
.brand{color:#aaa297;margin:0 0 16px}footer{margin-top:40px}
@media(max-width:480px){main{padding:20px 16px 40px}nav{gap:10px 18px}}
`

export const legalCsp = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'`,
  "script-src 'none'",
  "connect-src 'none'",
  'img-src data:',
  "font-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character] ?? character
  })
}

// Only the Markdown constructs used by our trusted legal copy are supported.
// Escape all source HTML and allow only explicit local, HTTPS, or mailto links.
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) =>
      /^(?:\/(?!\/)|https:\/\/|mailto:)/.test(href) ? `<a href="${href}">${label}</a>` : label,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replaceAll('\n', '<br>')
}

function blocks(text: string): string {
  if (!text) return ''
  return text
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n')
      // Tables require an explicit header separator and equal cell counts.
      // Each cell uses the same escaping and link allowlist as ordinary prose.
      if (lines.length >= 3 && lines.every((line) => line.startsWith('|') && line.endsWith('|'))) {
        const rows = lines.map((line) =>
          line
            .slice(1, -1)
            .split('|')
            .map((cell) => cell.trim()),
        )
        const [header, separator, ...body] = rows
        if (
          header &&
          separator &&
          header.length > 0 &&
          separator.every((cell) => /^---+$/.test(cell)) &&
          rows.every((row) => row.length === header.length)
        ) {
          return `<div class="table-scroll"><table><thead><tr>${header.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        }
      }
      return block.startsWith('- ')
        ? `<ul>${block
            .split('\n')
            .map((line) => `<li>${inline(line.replace(/^- /, ''))}</li>`)
            .join('')}</ul>`
        : `<p>${inline(block)}</p>`
    })
    .join('\n')
}

export const legalRoutes = {
  '/impressum': { language: 'de', kind: 'notice' },
  '/datenschutz': { language: 'de', kind: 'privacy' },
  '/legal-notice': { language: 'en', kind: 'notice' },
  '/privacy': { language: 'en', kind: 'privacy' },
} as const

export type LegalPath = keyof typeof legalRoutes

export function renderLegalPage(path: LegalPath): string {
  const { language, kind } = legalRoutes[path]
  const document: LegalDocument =
    kind === 'notice' ? legalNotices[language] : privacyPolicies[language]
  const german = language === 'de'
  const counterpart: Record<LegalLanguage, Record<typeof kind, LegalPath>> = {
    de: { notice: '/legal-notice', privacy: '/privacy' },
    en: { notice: '/impressum', privacy: '/datenschutz' },
  }
  const sibling =
    kind === 'notice'
      ? `<a href="${german ? '/datenschutz' : '/privacy'}">${german ? 'Datenschutz' : 'Privacy Policy'}</a>`
      : `<a href="${german ? '/impressum' : '/legal-notice'}">${german ? 'Impressum' : 'Legal Notice'}</a>`
  const navigation = `<nav aria-label="${german ? 'Rechtliche Informationen' : 'Legal information'}"><a href="/">${german ? 'Zur App' : 'Back to app'}</a>${sibling}<a href="${counterpart[language][kind]}" hreflang="${german ? 'en' : 'de'}" lang="${german ? 'en' : 'de'}">${german ? 'English' : 'Deutsch'}</a></nav>`
  return `<!doctype html>
<html lang="${language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${escapeHtml(document.title)} · Inbox Walk</title><style>${css}</style></head>
<body><main><p class="brand">Inbox Walk</p>${navigation}<h1>${escapeHtml(document.title)}</h1>${blocks(document.intro)}${document.sections
    .map(
      (section, index) =>
        `<section aria-labelledby="section-${index + 1}"><h2 id="section-${index + 1}">${document.numbered ? `${index + 1}. ` : ''}${inline(section.heading)}</h2>${blocks(section.body)}</section>`,
    )
    .join('\n')}<footer>${navigation}</footer></main></body></html>`
}

// Run before API/session handling and application telemetry. Match only these paths.
export function serveLegalPage(req: IncomingMessage, res: ServerResponse): boolean {
  const path = new URL(req.url || '/', 'http://localhost').pathname
  if (!Object.hasOwn(legalRoutes, path)) return false
  res.setHeader('Content-Security-Policy', legalCsp)
  res.setHeader('X-Robots-Tag', 'noindex')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end('Method not allowed')
    return true
  }
  const html = renderLegalPage(path as LegalPath)
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(html))
  res.end(req.method === 'HEAD' ? undefined : html)
  return true
}
