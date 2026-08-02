import DOMPurify from 'dompurify'
import { blobUrl, remoteImageUrl } from './api.ts'
import type { ReviewEmail } from './shared.ts'

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }
  return value.replace(/[&<>'"]/g, (character) => entities[character])
}

function releaseColorOverride(value: string) {
  return value.replace(
    /((?:background(?:-color)?|color|border(?:-(?:top|right|bottom|left))?-color)\s*:[^;{}]*?)\s*!\s*important/gi,
    '$1',
  )
}

export function emailDocument(
  email: ReviewEmail,
  snapshotId: string,
  loadRemoteImages: boolean,
  imageToken = '',
) {
  const source =
    email.html || `<div class="plain-text">${escapeHtml(email.text).replaceAll('\n', '<br>')}</div>`
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { html: true, svg: true, svgFilters: false },
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'link',
      'meta',
      'video',
      'audio',
      'source',
    ],
    FORBID_ATTR: ['srcset', 'onerror', 'onload', 'background'],
  })
  const parsed = new DOMParser().parseFromString(clean, 'text/html')
  const cids = new Map(
    email.inlineResources
      .filter((resource) => resource.cid)
      .map((resource) => [resource.cid?.toLowerCase(), blobUrl(snapshotId, resource.blobId, true)]),
  )
  for (const image of parsed.querySelectorAll('img')) {
    const src = image.getAttribute('src') || ''
    if (!src.trim() || src.trim() === '#') {
      image.remove()
    } else if (src.toLowerCase().startsWith('cid:')) {
      const replacement = cids.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase())
      if (replacement) image.setAttribute('src', replacement)
      else image.removeAttribute('src')
    } else if (/^(https?:)?\/\//i.test(src)) {
      const normalized = src.startsWith('//') ? `https:${src}` : src
      if (loadRemoteImages && normalized.toLowerCase().startsWith('https://')) {
        image.setAttribute('src', remoteImageUrl(snapshotId, email.id, normalized, imageToken))
      } else {
        image.removeAttribute('src')
        image.setAttribute('data-remote-image', 'blocked')
        image.setAttribute('alt', image.getAttribute('alt') || 'Externes Bild blockiert')
      }
    }
  }
  const stripRemoteUrls = (value: string) =>
    value.replace(/url\(\s*(['"]?)(?:https?:)?\/\/.*?\1\s*\)/gi, 'none')
  for (const element of parsed.querySelectorAll<HTMLElement>('[style]')) {
    element.setAttribute(
      'style',
      releaseColorOverride(stripRemoteUrls(element.getAttribute('style') || '')),
    )
  }
  for (const style of parsed.querySelectorAll('style')) {
    style.textContent = releaseColorOverride(
      stripRemoteUrls(style.textContent || '').replace(/@import[^;]+;/gi, ''),
    )
  }
  for (const link of parsed.querySelectorAll('a')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  const appOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  return `<!doctype html><html lang="de"><head><base target="_blank"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${appOrigin} data: blob:; style-src 'unsafe-inline';"><style>
    :root { color-scheme: dark; } * { box-sizing: border-box; }
    html, body { background: #211f1b !important; color: #eee9df !important; }
    body { margin: 0; padding: 28px 36px 52px; font: 16px/1.62 Arial, sans-serif; overflow-wrap: break-word; }
    body *:not(img):not(picture) { border-color: #4b463e !important; color: inherit !important; }
    body table, body thead, body tbody, body tfoot, body tr, body td, body th, body div, body section, body article, body header, body footer, body main { background-color: transparent !important; }
    body .email-bg > table.email-body { width: min(720px, 100%) !important; max-width: min(720px, 100%) !important; }
    img { max-width: 100% !important; height: auto !important; } img[data-remote-image] { display: none !important; }
    table { max-width: 100% !important; } th, td { overflow-wrap: normal !important; word-break: normal !important; } th { white-space: nowrap !important; } a { overflow-wrap: anywhere; } pre { white-space: pre-wrap; }
    blockquote { margin-left: 0; padding-left: 18px; border-left: 2px solid #575047; color: #aaa297 !important; }
    a, a * { color: #e28a67 !important; } .plain-text { white-space: normal; font: 17px/1.72 Georgia, serif; }
    @media (max-width: 620px) { body { padding: 20px 18px 42px; } }
  </style></head><body>${parsed.body.innerHTML}</body></html>`
}
