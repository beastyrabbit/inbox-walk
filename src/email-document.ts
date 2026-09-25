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

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']'])

/** Splits punctuation that ends a sentence from the URL it follows, without regex backtracking. */
function splitTrailingPunctuation(match: string) {
  let end = match.length
  while (end > 0 && TRAILING_PUNCTUATION.has(match[end - 1] ?? '')) end -= 1
  return { trailing: match.slice(end), url: match.slice(0, end) }
}

function linkify(escaped: string) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"']+/g, (match) => {
    const { trailing, url } = splitTrailingPunctuation(match)
    return `<a href="${url}">${url}</a>${trailing}`
  })
}

/** Turns a plain-text body into paragraphs with quoted passages and clickable links. */
export function plainTextHtml(text: string) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
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
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim())
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

const FORBIDDEN_TAGS = [
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
]

/**
 * Sanitizes the complete document. WHOLE_DOCUMENT keeps the sender's head
 * stylesheet, which the reader moves into the body below; everything still
 * renders inside a script-free sandboxed iframe with a strict CSP.
 */
function sanitizedDocument(source: string) {
  const clean = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: false },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['srcset', 'onerror', 'onload', 'background'],
  })
  return new DOMParser().parseFromString(clean, 'text/html')
}

/** Mail authors put stylesheets in <head> and canvas colours on <body>; keep both inside a wrapper. */
function hoistHeadStyles(parsed: Document) {
  const mailRoot = parsed.createElement('div')
  mailRoot.className = 'mail-root'
  const bodyStyle = parsed.body.getAttribute('style')
  const bodyColor = parsed.body.getAttribute('bgcolor')
  if (bodyColor) mailRoot.style.backgroundColor = bodyColor
  if (bodyStyle)
    mailRoot.setAttribute('style', `${mailRoot.getAttribute('style') ?? ''}${bodyStyle}`)
  mailRoot.append(...parsed.body.childNodes)
  parsed.body.replaceChildren(...parsed.head.querySelectorAll('style'), mailRoot)
}

function blockImage(image: HTMLImageElement) {
  image.removeAttribute('src')
  image.dataset.remoteImage = 'blocked'
  image.setAttribute('alt', image.getAttribute('alt') || 'Bild nicht verfügbar')
}

function proxiedRemoteImage(src: string, email: ReviewEmail, imageToken: string) {
  try {
    const normalized = new URL(src.startsWith('//') ? `https:${src}` : src).toString()
    const imageId = email.remoteImageIds?.[normalized]
    return imageId ? remoteImageUrl(email.id, imageId, imageToken) : undefined
  } catch {
    return undefined
  }
}

/** Points every image at an inline blob, the backend proxy, or blocks it. */
function rewriteImages(
  parsed: Document,
  email: ReviewEmail,
  loadRemoteImages: boolean,
  imageToken: string,
) {
  const cids = new Map(
    email.inlineResources
      .filter((resource) => resource.cid)
      .map((resource) => [resource.cid?.toLowerCase(), blobUrl(resource.blobId, true)]),
  )
  for (const image of parsed.querySelectorAll('img')) {
    const src = (image.getAttribute('src') || '').trim()
    if (!src || src === '#') {
      image.remove()
      continue
    }
    const lower = src.toLowerCase()
    let replacement: string | undefined
    if (lower.startsWith('cid:')) {
      replacement = cids.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase())
    } else if (lower.startsWith('data:image/')) {
      replacement = src
    } else if (loadRemoteImages && /^(https?:)?\/\//i.test(src)) {
      replacement = proxiedRemoteImage(src, email, imageToken)
    }
    if (replacement) image.setAttribute('src', replacement)
    else blockImage(image)
    constrainImage(image)
  }
}

const LINE_BREAKS = new Set(['\n', '\r', '\u2028', '\u2029'])

type Span = { start: number; end: number } | null

/**
 * Caches the next span at or after a position. Callers pass increasing positions, so every
 * character is scanned a bounded number of times.
 */
function forwardSearch(find: (from: number) => Span) {
  let cached: Span | undefined
  return (from: number) => {
    if (cached === undefined || (cached !== null && cached.start < from)) cached = find(from)
    return cached
  }
}

function findLineBreak(value: string, from: number): Span {
  for (let index = from; index < value.length; index += 1) {
    if (LINE_BREAKS.has(value[index] ?? '')) return { start: index, end: index + 1 }
  }
  return null
}

/**
 * Finds the earliest `quote\s*)` at or after `from`. The span starts where the reference's
 * body ends: at the quote, or, without a quote, at the whitespace before the parenthesis.
 */
function findClosing(value: string, quote: string, from: number): Span {
  if (!quote) {
    const paren = value.indexOf(')', from)
    if (paren === -1) return null
    let start = paren
    while (start > from && /\s/.test(value[start - 1] ?? '')) start -= 1
    return { start, end: paren + 1 }
  }
  for (
    let start = value.indexOf(quote, from);
    start !== -1;
    start = value.indexOf(quote, start + 1)
  ) {
    let paren = start + 1
    while (paren < value.length && /\s/.test(value[paren] ?? '')) paren += 1
    if (value[paren] === ')') return { start, end: paren + 1 }
  }
  return null
}

/**
 * Replaces remote `url(…)` references with `none`, matching exactly what
 * `/url\(\s*(['"]?)(?:https?:)?\/\/.*?\1\s*\)/gi` matched, but in linear time.
 */
function stripRemoteUrls(value: string) {
  const opening = /url\(\s*(['"]?)(?:https?:)?\/\//gi
  const closings: Record<string, (from: number) => Span> = {
    '': forwardSearch((from) => findClosing(value, '', from)),
    '"': forwardSearch((from) => findClosing(value, '"', from)),
    "'": forwardSearch((from) => findClosing(value, "'", from)),
  }
  const lineBreak = forwardSearch((from) => findLineBreak(value, from))
  let output = ''
  let cursor = 0
  for (let match = opening.exec(value); match; match = opening.exec(value)) {
    const from = match.index + match[0].length
    const closing = closings[match[1] ?? '']?.(from)
    const nextLineBreak = lineBreak(from)
    // The body before the closing may not span lines; only the trailing whitespace may.
    if (closing && (!nextLineBreak || nextLineBreak.start >= closing.start)) {
      output += `${value.slice(cursor, match.index)}none`
      cursor = closing.end
      opening.lastIndex = closing.end
    } else {
      opening.lastIndex = match.index + 1
    }
  }
  return output + value.slice(cursor)
}

/** Removes every remaining way for the document to reach a remote host. */
function stripRemoteReferences(parsed: Document) {
  for (const element of parsed.querySelectorAll('[srcset], [background], [poster]')) {
    element.removeAttribute('srcset')
    element.removeAttribute('background')
    element.removeAttribute('poster')
  }
  for (const element of parsed.querySelectorAll('[src]')) {
    if (element.tagName.toLowerCase() !== 'img') element.removeAttribute('src')
  }
  for (const element of parsed.querySelectorAll(String.raw`[href], [xlink\:href]`)) {
    if (element.tagName.toLowerCase() === 'a') continue
    for (const attribute of ['href', 'xlink:href']) {
      const value = element.getAttribute(attribute) ?? ''
      if (/^(?:https?:)?\/\//i.test(value)) element.removeAttribute(attribute)
    }
  }
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
}

export function emailDocument(
  email: ReviewEmail,
  loadRemoteImages: boolean,
  imageToken = '',
  colorMode: MailColorMode = 'dark',
) {
  const isPlainText = !email.html
  const parsed = sanitizedDocument(email.html || plainTextHtml(email.text))
  hoistHeadStyles(parsed)
  rewriteImages(parsed, email, loadRemoteImages, imageToken)
  stripRemoteReferences(parsed)
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
