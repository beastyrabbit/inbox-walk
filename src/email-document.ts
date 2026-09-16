import DOMPurify from 'dompurify'
import { blobUrl, remoteImageUrl } from './api.ts'
import type { ReviewEmail } from './shared.ts'

export type MailColorMode = 'dark' | 'original'

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

function linkify(escaped: string) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"']+/g, (match) => {
    const trailing = match.match(/[.,;:!?)\]]+$/)?.[0] ?? ''
    const url = trailing ? match.slice(0, -trailing.length) : match
    return `<a href="${url}">${url}</a>${trailing}`
  })
}

/** Turns a plain-text body into paragraphs with quoted passages and clickable links. */
export function plainTextHtml(text: string) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .split('\n')
  let html = ''
  let quoted = false
  for (const line of lines) {
    const isQuote = /^\s*>/.test(line)
    if (isQuote !== quoted) {
      html += isQuote ? '<blockquote>' : '</blockquote>'
      quoted = isQuote
    }
    const content = isQuote ? line.replace(/^\s*(?:>\s?)+/, '') : line
    html += `${linkify(escapeHtml(content))}\n`
  }
  if (quoted) html += '</blockquote>'
  return `<div class="plain-text">${html.replace(/\n(?=<\/blockquote>)/g, '')}</div>`
}

/**
 * Removes `@media` blocks that target a dark colour scheme. The reader applies its own
 * dark adaptation, so a mail must always render its light design first.
 */
export function stripDarkSchemeRules(css: string) {
  let output = ''
  let cursor = 0
  const pattern = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/gi
  for (const match of css.matchAll(pattern)) {
    const start = match.index
    if (start < cursor) continue
    let depth = 1
    let end = start + match[0].length
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}') depth -= 1
      end += 1
    }
    output += css.slice(cursor, start)
    cursor = end
  }
  return output + css.slice(cursor)
}

function pixelValue(value: string | null | undefined) {
  if (!value) return undefined
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i)
  return match ? Number(match[1]) : undefined
}

/**
 * Mails often fix image widths in pixels. Keep the author's size on wide screens, but never
 * let an image overflow the reader on narrow ones.
 */
function constrainImage(image: HTMLImageElement) {
  const declared =
    pixelValue(image.style.maxWidth) ??
    pixelValue(image.style.width) ??
    pixelValue(image.getAttribute('width'))
  if (declared !== undefined && declared > 0) {
    image.style.setProperty('max-width', `min(${declared}px, 100%)`, 'important')
  }
}

const readerStyles = {
  dark: `
    :root { color-scheme: light; }
    html { background: #211f1b; }
    body { min-height: 100vh; background: #e2e0dc; color: #1a150b; filter: invert(1) hue-rotate(180deg); }
    img, picture, svg, video { filter: invert(1) hue-rotate(180deg); }
    a { color: #ad5532; }
    .plain-text { color: #1a150b; }`,
  original: `
    :root { color-scheme: light; }
    html { background: #211f1b; }
    body { min-height: 100vh; background: #ffffff; color: #1f1d1a; }
    a { color: #9d4d32; }`,
}

const plainTextStyles = `
    :root { color-scheme: dark; }
    html, body { background: #211f1b; color: #eee9df; }
    body { min-height: 100vh; filter: none; }
    a { color: #e28a67; }`

export function emailDocument(
  email: ReviewEmail,
  snapshotId: string,
  loadRemoteImages: boolean,
  imageToken = '',
  colorMode: MailColorMode = 'dark',
) {
  const isPlainText = !email.html
  const source = email.html || plainTextHtml(email.text)
  const clean = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true,
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
  // Mail authors put their stylesheets in <head> and canvas colours on <body>. Keep both:
  // styles move into the body, and the body's own presentation moves onto a wrapper.
  const mailRoot = parsed.createElement('div')
  mailRoot.className = 'mail-root'
  const bodyStyle = parsed.body.getAttribute('style')
  const bodyColor = parsed.body.getAttribute('bgcolor')
  if (bodyColor) mailRoot.style.backgroundColor = bodyColor
  if (bodyStyle)
    mailRoot.setAttribute('style', `${mailRoot.getAttribute('style') ?? ''}${bodyStyle}`)
  mailRoot.append(...parsed.body.childNodes)
  parsed.body.replaceChildren(...parsed.head.querySelectorAll('style'), mailRoot)
  const remoteImageIds = email.remoteImageIds ?? {}
  const cids = new Map(
    email.inlineResources
      .filter((resource) => resource.cid)
      .map((resource) => [resource.cid?.toLowerCase(), blobUrl(snapshotId, resource.blobId, true)]),
  )
  const blockImage = (image: HTMLImageElement) => {
    image.removeAttribute('src')
    image.setAttribute('data-remote-image', 'blocked')
    image.setAttribute('alt', image.getAttribute('alt') || 'Bild nicht verfügbar')
  }
  for (const image of parsed.querySelectorAll('img')) {
    const src = image.getAttribute('src') || ''
    if (!src.trim() || src.trim() === '#') {
      image.remove()
      continue
    }
    if (src.toLowerCase().startsWith('cid:')) {
      const replacement = cids.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase())
      if (replacement) image.setAttribute('src', replacement)
      else blockImage(image)
    } else if (/^(https?:)?\/\//i.test(src)) {
      let imageId: string | undefined
      try {
        const normalized = new URL(src.startsWith('//') ? `https:${src}` : src).toString()
        imageId = remoteImageIds[normalized]
      } catch {
        // Malformed remote URLs stay blocked.
      }
      if (loadRemoteImages && imageId) {
        image.setAttribute('src', remoteImageUrl(snapshotId, email.id, imageId, imageToken))
      } else {
        blockImage(image)
      }
    } else if (!src.toLowerCase().startsWith('data:image/')) {
      blockImage(image)
    }
    constrainImage(image)
  }
  for (const element of parsed.querySelectorAll('[srcset], [background], [poster]')) {
    element.removeAttribute('srcset')
    element.removeAttribute('background')
    element.removeAttribute('poster')
  }
  for (const element of parsed.querySelectorAll('[src]')) {
    if (element.tagName.toLowerCase() !== 'img') element.removeAttribute('src')
  }
  for (const element of parsed.querySelectorAll('[href], [xlink\\:href]')) {
    if (element.tagName.toLowerCase() === 'a') continue
    for (const attribute of ['href', 'xlink:href']) {
      const value = element.getAttribute(attribute) ?? ''
      if (/^(?:https?:)?\/\//i.test(value)) element.removeAttribute(attribute)
    }
  }
  const stripRemoteUrls = (value: string) =>
    value.replace(/url\(\s*(['"]?)(?:https?:)?\/\/.*?\1\s*\)/gi, 'none')
  for (const element of parsed.querySelectorAll<HTMLElement>('[style]')) {
    element.setAttribute('style', stripRemoteUrls(element.getAttribute('style') || ''))
  }
  for (const style of parsed.querySelectorAll('style')) {
    style.textContent = stripDarkSchemeRules(
      stripRemoteUrls(style.textContent || '').replace(/@import[^;]+;/gi, ''),
    )
  }
  for (const link of parsed.querySelectorAll('a')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  const appOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const modeStyles = isPlainText ? plainTextStyles : readerStyles[colorMode]
  return `<!doctype html><html lang="de"><head><base target="_blank"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${appOrigin} data: blob:; style-src 'unsafe-inline';"><style>
    * { box-sizing: border-box; }
    html { margin: 0; }
    body { margin: 0; padding: 28px clamp(16px, 4vw, 40px) 56px; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow-wrap: break-word; }
    img { max-width: 100%; height: auto !important; } img[data-remote-image] { display: none !important; }
    table { max-width: 100% !important; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } a { overflow-wrap: anywhere; }
    blockquote { margin: 0.6em 0; padding-left: 14px; border-left: 2px solid #b6b0a6; color: #5f5a52; }
    .plain-text { max-width: 72ch; margin: 0 auto; white-space: pre-wrap; font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .plain-text blockquote { margin: 0.8em 0; padding-left: 14px; border-left: 2px solid #5b554c; color: #aaa297; }
    ${modeStyles}
  </style></head><body>${parsed.body.innerHTML}</body></html>`
}
