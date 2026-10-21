import {
  breadcrumbsIntegration,
  browserTracingIntegration,
  captureConsoleIntegration,
  captureException,
  init,
} from '@sentry/react'
import { setErrorReporter } from './telemetry.ts'
import type { ClientConfig } from './telemetry-contract.ts'
import { scrubBreadcrumb, scrubEvent } from './telemetry-scrub.ts'

export function startErrors(config: ClientConfig) {
  if (!config.glitchtip) return
  const api = new RegExp(`^${location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api(?:/|$)`)
  init({
    ...config.glitchtip,
    release: config.release,
    sendDefaultPii: false,
    sendClientReports: false,
    tracePropagationTargets: [/^\/api(?:\/|$)/, api],
    integrations: (defaults) => [
      ...defaults.filter(
        (item) => !['BrowserSession', 'Breadcrumbs', 'HttpContext'].includes(item.name),
      ),
      breadcrumbsIntegration({
        console: false,
        dom: false,
        fetch: false,
        xhr: false,
        history: false,
      }),
      captureConsoleIntegration({ levels: ['error'] }),
      browserTracingIntegration({
        shouldCreateSpanForRequest: (url) => /^\/api(?:\/|$)/.test(url) || api.test(url),
      }),
    ],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  })
  setErrorReporter(captureException)
}
