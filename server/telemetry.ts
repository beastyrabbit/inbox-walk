import { captureException, getClient, startSpan } from '@sentry/node'
import { telemetryPath } from '../src/telemetry-contract.ts'

export function reportServerError(error: unknown) {
  if (getClient()) captureException(error)
}

export function traceApi<T>(url: string, work: () => T): T {
  if (!url.startsWith('/api/') || !getClient()) return work()
  return startSpan({ name: telemetryPath(url), op: 'http.server' }, work)
}
