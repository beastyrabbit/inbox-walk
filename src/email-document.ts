import DOMPurify from 'dompurify'
import { blobUrl } from './api.ts'
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

export function emailDocument(email: ReviewEmail, snapshotId: string, loadRemoteImages: boolean) {
  const source =
    email.html || `<div class="plain-text">${escapeHtml(email.text).replaceAll('\n', '<br>')}</div>`
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { html: true },
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
    if (src.toLowerCase().startsWith('cid:')) {
      const replacement = cids.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase())
      if (replacement) image.setAttribute('src', replacement)
      else image.removeAttribute('src')
    } else if (/^(https?:)?\/\//i.test(src) && !loadRemoteImages) {
      image.removeAttribute('src')
      image.setAttribute('data-remote-image', 'blocked')
      image.setAttribute('alt', image.getAttribute('alt') || 'Externes Bild blockiert')
    }
  }
  if (!loadRemoteImages) {
    const stripRemoteUrls = (value: string) =>
      value.replace(/url\(\s*(['"]?)(?:https?:)?\/\/.*?\1\s*\)/gi, 'none')
    for (const element of parsed.querySelectorAll<HTMLElement>('[style]')) {
      element.setAttribute('style', stripRemoteUrls(element.getAttribute('style') || ''))
    }
    for (const style of parsed.querySelectorAll('style')) {
      style.textContent = stripRemoteUrls(style.textContent || '').replace(/@import[^;]+;/gi, '')
    }
  }
  for (const link of parsed.querySelectorAll('a')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  const appOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const remoteImages = loadRemoteImages ? 'https: http:' : ''
  return `<!doctype html><html lang="de"><head><base target="_blank"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${appOrigin} data: blob: ${remoteImages}; style-src 'unsafe-inline';"><style>
    :root { color-scheme: light; } * { box-sizing: border-box; }
    body { margin: 0; padding: 28px 36px 52px; color: #28241d; background: #fbf7ec; font: 16px/1.62 Arial, sans-serif; overflow-wrap: anywhere; }
    img { max-width: 100% !important; height: auto !important; } img[data-remote-image] { display: none !important; }
    table { max-width: 100% !important; } pre { white-space: pre-wrap; }
    blockquote { margin-left: 0; padding-left: 18px; border-left: 2px solid #d8cfbc; color: #6b6459; }
    a { color: #914726; } .plain-text { white-space: normal; font: 17px/1.72 Georgia, serif; }
    @media (max-width: 620px) { body { padding: 20px 18px 42px; } }
  </style></head><body>${parsed.body.innerHTML}</body></html>`
}
