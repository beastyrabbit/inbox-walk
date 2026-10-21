import type { Breadcrumb, Event, StackFrame } from '@sentry/react'
import { telemetryPath } from './telemetry-contract.ts'

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Only build-owned filenames survive. Source text, locals and function names never do. */
function filename(value: unknown) {
  if (typeof value !== 'string') return undefined
  const asset = /(?:^|\/)assets\/((?:index|errors|telemetry-replay)-[a-zA-Z0-9_-]{8}\.js)$/.exec(
    value,
  )
  if (asset) return `~/assets/${asset[1]}`
  const server = /(?:^|\/)dist-server\/((?:index|instrument|chunk-[A-Z0-9]{8})\.js)$/.exec(value)
  return server ? `app:///dist-server/${server[1]}` : undefined
}

function frames(input: StackFrame[] | undefined): StackFrame[] | undefined {
  return input
    ?.flatMap((frame) => {
      const file = filename(frame.filename)
      if (!file) return []
      return [
        { filename: file, lineno: number(frame.lineno), colno: number(frame.colno), in_app: true },
      ]
    })
    .slice(-50)
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  const category = ['console', 'ui.click', 'navigation', 'fetch', 'xhr', 'http'].includes(
    crumb.category ?? '',
  )
    ? crumb.category
    : undefined
  if (!category) return null
  // No DOM selectors/text, console arguments, HTTP metadata, referrers or error messages.
  return { category, timestamp: number(crumb.timestamp) }
}

/**
 * Reconstruct from an allowlist. Redacting emails/tokens alone cannot catch subjects,
 * notes or reply text, so ALL arbitrary messages and metadata are discarded.
 */
export function scrubEvent<T extends Event>(event: T): T {
  const clean: Event = {
    event_id: /^[a-f0-9]{32}$/i.test(event.event_id ?? '') ? event.event_id : undefined,
    timestamp: number(event.timestamp),
    platform: event.platform === 'node' ? 'node' : 'javascript',
    level: ['fatal', 'error', 'warning', 'info', 'debug', 'log'].includes(event.level ?? '')
      ? event.level
      : undefined,
    release: /^inbox-walk@\d+\.\d+\.\d+$/.test(event.release ?? '') ? event.release : undefined,
    environment: /^[a-z][a-z0-9_-]{0,31}$/.test(event.environment ?? '')
      ? event.environment
      : undefined,
    request: event.request?.url ? { url: telemetryPath(event.request.url) } : undefined,
    breadcrumbs: event.breadcrumbs
      ?.map(scrubBreadcrumb)
      .filter((crumb): crumb is Breadcrumb => crumb !== null),
  }
  if (event.exception) {
    clean.exception = {
      values: event.exception.values?.slice(-5).map((exception) => ({
        type:
          [
            'Error',
            'TypeError',
            'RangeError',
            'ReferenceError',
            'SyntaxError',
            'URIError',
            'AggregateError',
            'UnhandledRejection',
          ].includes(exception.type ?? '') ||
          /^[A-Z][A-Za-z0-9]{0,63}(Error|Exception|Rejection)$/.test(exception.type ?? '')
            ? exception.type
            : 'Error',
        value: 'Application error (details withheld)',
        stacktrace: { frames: frames(exception.stacktrace?.frames) },
        mechanism: exception.mechanism
          ? { type: 'generic', handled: exception.mechanism.handled !== false }
          : undefined,
      })),
    }
  } else if (event.message || event.logentry) {
    clean.message = 'Application error (details withheld)'
  }
  // Debug IDs map to the injected build files. Never forward arbitrary image URLs.
  clean.debug_meta = event.debug_meta
    ? {
        images: event.debug_meta.images?.flatMap((image) => {
          if (image.type !== 'sourcemap') return []
          const file = filename(image.code_file)
          return file && /^[a-f0-9-]{36}$/i.test(image.debug_id ?? '')
            ? [{ type: 'sourcemap' as const, code_file: file, debug_id: image.debug_id }]
            : []
        }),
      }
    : undefined
  if (event.contexts?.trace) {
    const trace = event.contexts.trace
    if (
      /^[a-f0-9]{32}$/i.test(trace.trace_id ?? '') &&
      /^[a-f0-9]{16}$/i.test(trace.span_id ?? '')
    ) {
      clean.contexts = { trace: { trace_id: trace.trace_id, span_id: trace.span_id, op: 'app' } }
    }
  }
  if (event.type === 'transaction') {
    const transaction = event
    Object.assign(clean, {
      type: 'transaction',
      transaction: telemetryPath(transaction.transaction),
      start_timestamp: number(transaction.start_timestamp),
      spans: [],
      transaction_info: { source: 'route' },
    })
  }
  return clean as T
}
