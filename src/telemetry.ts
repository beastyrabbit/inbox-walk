import {
  type ClientConfig,
  durationBucket,
  eventProperties,
  telemetryPath,
  type ViewPath,
} from './telemetry-contract.ts'

export { durationBucket }

type Payload = Record<string, unknown>
type Umami = { track: (payload: Payload) => unknown }
declare global {
  interface Window {
    umami?: Umami
    inboxWalkBeforeSend?: (type: string, payload: Payload) => Payload | null
  }
}

export interface TelemetryDependencies {
  config: () => Promise<ClientConfig>
  loadScript: (url: string, attributes: Record<string, string>) => Promise<void>
  startErrors: (config: ClientConfig) => Promise<void>
  startReplay: (url: string, websiteId: string) => Promise<void>
  tracker: () => Umami | undefined
  hostname: string
  beforeSend: (hook: (type: string, payload: Payload) => Payload | null) => void
}

/** No mail data, identities or DOM values are accepted by the telemetry API. */
export function createTelemetry(deps: TelemetryDependencies) {
  let ready = false
  let enabled = false
  let started: Promise<void> | undefined
  let view: ViewPath = '/'
  let pageSent = false
  let performanceSent = false
  let pending: Payload[] = []
  const send = (payload: Payload) => {
    if (enabled) {
      try {
        void deps.tracker()?.track(payload)
      } catch {
        /* Telemetry must never interrupt mail review. */
      }
    } else if (!ready && pending.length < 100) pending.push(payload)
  }
  return {
    start() {
      started ??= (async () => {
        try {
          const config = await deps.config()
          // Errors and analytics are independent; a blocked script must not disable errors.
          const errors = config.glitchtip
            ? deps.startErrors(config).catch(() => {})
            : Promise.resolve()
          if (config.umami) {
            const { url, websiteId } = config.umami
            deps.beforeSend((type, payload) => {
              const base: Payload = {
                website: websiteId,
                hostname: deps.hostname,
                title: 'Inbox Walk',
                url: telemetryPath(payload.url ?? view),
                referrer: '',
                tag: config.release,
              }
              if (type === 'performance') {
                if (performanceSent) return null
                performanceSent = true
                for (const key of ['ttfb', 'fcp', 'lcp', 'cls', 'inp', 'duration']) {
                  const value = payload[key]
                  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    base[key] = key === 'cls' ? Math.round(value * 1000) / 1000 : Math.round(value)
                  }
                }
                return base
              }
              if (type !== 'event') return null
              if (payload.name !== undefined) {
                if (typeof payload.name !== 'string') return null
                const data = eventProperties(
                  payload.name,
                  isRecord(payload.data) ? payload.data : {},
                )
                if (!data) return null
                return { ...base, name: payload.name, data }
              }
              return base
            })
            await deps
              .loadScript(`${url}/script.js`, {
                'data-website-id': websiteId,
                'data-host-url': url,
                'data-domains': deps.hostname,
                'data-auto-pageview': 'false',
                'data-exclude-search': 'true',
                'data-exclude-hash': 'true',
                'data-before-send': 'inboxWalkBeforeSend',
                'data-performance': 'true',
                'data-fetch-credentials': 'omit',
                'data-tag': config.release,
              })
              .catch(() => {})
            enabled = Boolean(deps.tracker())
            if (enabled && config.umami.replay)
              await deps.startReplay(url, websiteId).catch(() => {})
          }
          await errors
        } catch {
          /* Missing/unavailable config leaves both integrations off. */
        } finally {
          ready = true
          if (!fetchErrors) earlyErrors = []
          const queued = pending
          pending = []
          if (enabled) for (const payload of queued) send(payload)
        }
      })()
      return started
    },
    track(name: string, properties: Payload = {}) {
      const data = eventProperties(name, properties)
      if (data) send({ name, data, url: view })
    },
    page(path: ViewPath) {
      if (pageSent && view === path) return
      pageSent = true
      view = path
      send({ url: path })
    },
  }
}

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const telemetry = createTelemetry({
  config: async () => {
    const response = await fetch('/api/client-config', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error('Telemetry config unavailable')
    return response.json() as Promise<ClientConfig>
  },
  async loadScript(url, attributes) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = url
      script.async = true
      script.referrerPolicy = 'no-referrer'
      for (const [key, value] of Object.entries(attributes)) script.setAttribute(key, value)
      const timer = window.setTimeout(() => {
        script.remove()
        reject(new Error('Tracker unavailable'))
      }, 5000)
      script.onload = () => {
        window.clearTimeout(timer)
        resolve()
      }
      script.onerror = () => {
        window.clearTimeout(timer)
        script.remove()
        reject(new Error('Tracker unavailable'))
      }
      document.head.append(script)
    })
  },
  startErrors: async (config) => {
    await (await import('./errors.ts')).startErrors(config)
  },
  startReplay: async (url, websiteId) => {
    const { guardRecorder } = await import('./telemetry-replay.ts')
    guardRecorder(url, websiteId)
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `${url}/recorder.js`
      script.async = true
      script.referrerPolicy = 'no-referrer'
      script.setAttribute('data-website-id', websiteId)
      script.setAttribute('data-host-url', url)
      script.onload = () => resolve()
      script.onerror = () => {
        script.remove()
        reject(new Error('Recorder unavailable'))
      }
      document.head.append(script)
    })
  },
  tracker: () => window.umami,
  hostname: typeof location === 'undefined' ? '' : location.hostname,
  beforeSend: (hook) => {
    window.inboxWalkBeforeSend = hook
  },
})

export const track = telemetry.track
export const pageView = telemetry.page
export const startTelemetry = telemetry.start

export function reportBrowserError(error: unknown) {
  if (fetchErrors) fetchErrors(error)
  else if (earlyErrors.length < 5) {
    // A render can fail before the lazy SDK arrives. Keep only a bounded error stack,
    // never the original object, React props or component state.
    const safe = new Error('Application render failure')
    if (error instanceof Error && error.stack) safe.stack = error.stack.slice(0, 8192)
    earlyErrors.push(safe)
  }
}
let fetchErrors: ((error: unknown) => void) | undefined
let earlyErrors: Error[] = []
export function setErrorReporter(reporter: (error: unknown) => void) {
  fetchErrors = reporter
  for (const error of earlyErrors) reporter(error)
  earlyErrors = []
}

let interaction: 'keyboard' | 'click' | 'automatic' = 'automatic'
export function interactionType() {
  return interaction
}
export function watchInteractions() {
  document.addEventListener(
    'keydown',
    () => {
      interaction = 'keyboard'
    },
    true,
  )
  document.addEventListener(
    'pointerdown',
    () => {
      interaction = 'click'
    },
    true,
  )
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return
      const link = event.target.closest<HTMLAnchorElement>('a[data-telemetry-outbound]')
      if (!link) return
      try {
        track('outbound_link', { hostname: new URL(link.href).hostname })
      } catch {
        /* Drop malformed links. */
      }
    },
    true,
  )
}

export function failureCategory(error: unknown) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(code)) return 'network'
  if (/AUTH|LOGIN/.test(code)) return 'authentication'
  if (/ATTACHMENT|BUDGET/.test(code)) return 'attachment'
  if (/TIMEOUT/.test(code)) return 'timeout'
  if (isRecord(error) && typeof error.status === 'number' && error.status >= 500) return 'server'
  return 'unknown'
}
