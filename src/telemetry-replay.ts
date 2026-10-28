import { telemetryPath } from './telemetry-contract.ts'

const structure = new Set([
  'type',
  'timestamp',
  'data',
  'node',
  'childNodes',
  'id',
  'rootId',
  'tagName',
  'attributes',
  'textContent',
  'isSVG',
  'isShadow',
  'isShadowHost',
  'needBlock',
  'initialOffset',
  'left',
  'top',
  'source',
  'texts',
  'value',
  'removes',
  'adds',
  'parentId',
  'nextId',
  'previousId',
  'positions',
  'x',
  'y',
  'timeOffset',
  'width',
  'height',
  'href',
  'url',
  'text',
  'isChecked',
  'userTriggered',
])
const tags = new Set(
  'html head body title meta link style main header footer nav article section aside div span p h1 h2 h3 h4 button a ol ul li strong small time output details summary dl dt dd fieldset legend label input textarea select option iframe img svg path circle rect line polyline polygon br hr pre code form'.split(
    ' ',
  ),
)
const classes = new Set(
  'rr-block rr-mask app-shell with-reply topbar top-actions brand-button brand-name app-version story-position counter counter-compact mode-label analysis-badge heuristic codex text-button icon-button reader message-card controls button primary secondary todo-page todo-section runs-heading todo-list todo-row todo-row-main todo-row-meta todo-status todo-empty completion-mark parked-section dialog-backdrop dialog settings-dialog dialog-header settings-section settings-section-heading settings-values settings-source settings-demo-note button-row state-page spinner sr-only segmented'.split(
    ' ',
  ),
)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const mask = (value: unknown) => (typeof value === 'string' ? value.replace(/\S/g, '*') : '')

function replayAttributes(attrs: Record<string, unknown>, stylesheet: string) {
  const safe: Record<string, unknown> = {}
  if (typeof attrs.class === 'string')
    safe.class = attrs.class
      .split(/\s+/)
      .filter((name) => classes.has(name))
      .join(' ')
  for (const dimension of ['rr_width', 'rr_height']) {
    if (typeof attrs[dimension] === 'string' && /^\d+(\.\d+)?px$/.test(attrs[dimension]))
      safe[dimension] = attrs[dimension]
  }
  // Replace captured CSS with the build's static stylesheet. No dynamic CSS or URLs escape.
  if ('_cssText' in attrs && stylesheet) safe._cssText = `@import url("${stylesheet}");`
  return safe
}

function replayEntry(key: string, entry: unknown, stylesheet: string, depth: number): unknown {
  if (key === 'href' || key === 'url') return telemetryPath(entry)
  if (key === 'textContent' || key === 'text' || key === 'value') return mask(entry)
  if (key === 'tagName') return typeof entry === 'string' && tags.has(entry) ? entry : 'div'
  if (key === 'attributes' && entry && typeof entry === 'object' && !Array.isArray(entry))
    return replayAttributes(entry as Record<string, unknown>, stylesheet)
  return replayValue(entry, stylesheet, depth + 1)
}

function replayObject(value: object, stylesheet: string, depth: number) {
  if ('type' in value && value.type === 1 && 'name' in value) {
    return {
      type: 1,
      name: 'html',
      publicId: '',
      systemId: '',
      ...('id' in value && finite(value.id) ? { id: value.id } : {}),
    }
  }
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!structure.has(key)) continue
    const safe = replayEntry(key, entry, stylesheet, depth)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

/** rrweb masks text, but not attributes, CSS, metadata URLs or custom-event payloads. */
function replayValue(value: unknown, stylesheet: string, depth = 0): unknown {
  if (depth > 80) return null
  if (finite(value) || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value))
    return value.slice(0, 20_000).map((entry) => replayValue(entry, stylesheet, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  return replayObject(value, stylesheet, depth)
}

export function scrubRecording(input: unknown, website: string, stylesheet = '') {
  if (!input || typeof input !== 'object') return null
  const { type, payload } = input as { type?: unknown; payload?: Record<string, unknown> }
  if (!payload || !Array.isArray(payload.events) || !finite(payload.timestamp)) return null
  let events: unknown[]
  if (type === 'heatmap') {
    events = payload.events.flatMap((event) => {
      if (!event || !['click', 'scroll'].includes(event.type)) return []
      const safe: Record<string, unknown> = { type: event.type, url: telemetryPath(event.url) }
      for (const key of [
        'timestamp',
        'x',
        'y',
        'pageX',
        'pageY',
        'pageW',
        'pageH',
        'viewportW',
        'viewportH',
        'scrollPct',
      ]) {
        if (finite(event[key])) safe[key] = Math.round(event[key])
      }
      return [safe]
    })
  } else if (type === 'record') {
    events = payload.events.flatMap((event) => {
      // Custom events, plugins, CSS mutations and fragmented JSON are never forwarded.
      if (!event || !Number.isInteger(event.type) || event.type < 0 || event.type > 4) return []
      if (event.type === 3 && ![0, 1, 2, 3, 4, 5].includes(event.data?.source)) return []
      return [replayValue(event, stylesheet)]
    })
  } else return null
  return events.length ? { type, payload: { website, timestamp: payload.timestamp, events } } : null
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Fail closed for every Umami transport. Non-Umami requests retain their original arguments. */
export function guardRecorder(url: string, websiteId: string) {
  const endpoint = `${url}/api/record`
  const origin = new URL(url).origin
  const configPath = `/api/websites/${websiteId}/recorder`
  const original = window.fetch.bind(window)
  const drop = () => Promise.resolve(new Response(null, { status: 204 }))
  const cleanUrl = (target: URL) =>
    !target.search && !target.hash && !target.username && !target.password
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.href
  let stylesheet = ''
  if (link) {
    const parsed = new URL(link)
    if (
      parsed.origin === location.origin &&
      /^\/assets\/index-[a-zA-Z0-9_-]{8}\.css$/.test(parsed.pathname)
    )
      stylesheet = parsed.href
  }
  window.fetch = (input, init) => {
    const target = requestUrl(input)
    const parsed = new URL(target, location.href)
    if (parsed.origin !== origin) return original(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (!cleanUrl(parsed)) return drop()
    if (
      (method === 'POST' && parsed.pathname === '/api/send') ||
      (method === 'GET' && parsed.pathname === configPath)
    )
      return original(input, init)
    if (method !== 'POST' || parsed.pathname !== '/api/record') return drop()
    try {
      if (target !== endpoint) throw new Error('Unexpected recorder URL')
      if (init?.method !== 'POST' || typeof init.body !== 'string' || init.body.length > 1_000_000)
        throw new Error('Unsupported recording')
      const body = scrubRecording(JSON.parse(init.body), websiteId, stylesheet)
      if (!body) throw new Error('Unsupported recording')
      const cache = new Headers(init.headers).get('x-umami-cache')
      return original(endpoint, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: init.keepalive,
        headers: {
          'Content-Type': 'application/json',
          ...(cache ? { 'x-umami-cache': cache } : {}),
        },
        body: JSON.stringify(body),
      })
    } catch {
      // A successful empty response drops unrecognized payloads without retries or logs.
      return drop()
    }
  }

  const originalBeacon = navigator.sendBeacon.bind(navigator)
  navigator.sendBeacon = (target, data) => {
    const parsed = new URL(target, location.href)
    if (parsed.origin !== origin || (parsed.pathname === '/api/send' && cleanUrl(parsed)))
      return originalBeacon(target, data)
    // Beacons provide no response and may use an unknown encoding. Drop recorder data entirely.
    return true
  }

  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const blocked = new WeakSet<XMLHttpRequest>()
  XMLHttpRequest.prototype.open = function (
    ...args: [
      method: string,
      target: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ]
  ) {
    if (new URL(args[1], location.href).origin === origin) {
      blocked.add(this)
      // Cancel any previously opened request before reusing this instance.
      this.abort()
      return
    }
    blocked.delete(this)
    return Reflect.apply(originalOpen, this, args)
  }
  XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest['send']>) {
    if (blocked.has(this)) return
    return Reflect.apply(originalSend, this, args)
  }
}
