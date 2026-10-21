import { afterEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  onUncaughtExceptionIntegration: vi.fn(),
  onUnhandledRejectionIntegration: vi.fn(),
}))
vi.mock('@sentry/node', () => sentry)
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('server instrumentation preload', () => {
  it('does not initialize with an unset or invalid DSN', async () => {
    for (const dsn of ['', 'not-a-dsn']) {
      vi.stubEnv('GLITCHTIP_DSN', dsn)
      vi.resetModules()
      await import('./instrument.ts')
      expect(sentry.init).not.toHaveBeenCalled()
    }
  })
  it('sets release, scrubbers and only process error integrations when configured', async () => {
    vi.stubEnv('GLITCHTIP_DSN', 'https://public@errors.example/17')
    vi.resetModules()
    await import('./instrument.ts')
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        release: 'inbox-walk@0.12.0',
        sendDefaultPii: false,
        sendClientReports: false,
        defaultIntegrations: false,
        registerEsmLoaderHooks: false,
        tracePropagationTargets: [],
        beforeSend: expect.any(Function),
        beforeSendTransaction: expect.any(Function),
        beforeBreadcrumb: expect.any(Function),
      }),
    )
    expect(sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: 'strict' })
  })
})
