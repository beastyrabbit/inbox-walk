import { scrubBreadcrumb, scrubEvent } from '../src/telemetry-scrub.ts'
import { telemetryConfig } from './telemetry-config.ts'

// Preloaded with --import before any application modules. Unset DSN does not initialize an SDK.
const config = telemetryConfig()
if (config.glitchtip) {
  const Sentry = await import('@sentry/node')
  Sentry.init({
    ...config.glitchtip,
    release: config.release,
    sendDefaultPii: false,
    sendClientReports: false,
    defaultIntegrations: false,
    // No HTTP/body/header/cookie, console, local-variable or provider auto-instrumentation.
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    tracePropagationTargets: [],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  })
}
