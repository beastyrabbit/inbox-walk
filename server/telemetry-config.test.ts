import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { release, serveClientConfig, telemetryConfig, telemetryCsp } from './telemetry-config.ts'

const configured = {
  UMAMI_URL: 'https://analytics.example',
  UMAMI_WEBSITE_ID: '11111111-1111-4111-8111-111111111111',
  GLITCHTIP_DSN: 'https://public@errors.example/17',
}
let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
})

describe('runtime telemetry config', () => {
  it('is off without env and never exposes server-only secrets', () => {
    expect(
      telemetryConfig({ FASTMAIL_JMAP_TOKEN: 'private', GLITCHTIP_AUTH_TOKEN: 'private' }),
    ).toEqual({ release })
    expect(release).toBe('inbox-walk@0.11.1')
  })
  it('validates targets, DSNs, website IDs and defaults', () => {
    expect(telemetryConfig(configured)).toEqual({
      release,
      umami: { url: configured.UMAMI_URL, websiteId: configured.UMAMI_WEBSITE_ID, replay: true },
      glitchtip: {
        dsn: configured.GLITCHTIP_DSN,
        environment: 'production',
        tracesSampleRate: 0.1,
      },
    })
    for (const url of [
      'http://analytics.example',
      'javascript:alert(1)',
      'https://a:secret@analytics.example',
      'https://analytics.example/?secret=x',
      'https://analytics.example/path',
      'invalid',
    ]) {
      expect(telemetryConfig({ ...configured, UMAMI_URL: url }).umami).toBeUndefined()
    }
    for (const dsn of [
      'https://errors.example/17',
      'https://key:secret@errors.example/17',
      'https://public@errors.example/17?secret=x',
      'https://public@errors.example/anything',
    ]) {
      expect(telemetryConfig({ GLITCHTIP_DSN: dsn }).glitchtip).toBeUndefined()
    }
    expect(
      telemetryConfig({ ...configured, UMAMI_WEBSITE_ID: 'private-mail-id' }).umami,
    ).toBeUndefined()
    expect(telemetryConfig({ ...configured, UMAMI_REPLAY: 'off' }).umami?.replay).toBe(false)
    expect(
      telemetryConfig({ ...configured, GLITCHTIP_TRACES_SAMPLE_RATE: '1' }).glitchtip
        ?.tracesSampleRate,
    ).toBe(1)
    expect(
      telemetryConfig({ ...configured, GLITCHTIP_TRACES_SAMPLE_RATE: '-1' }).glitchtip
        ?.tracesSampleRate,
    ).toBe(0.1)
  })
  it('allows HTTP only on loopback in tests', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      const env = {
        NODE_ENV: 'test',
        UMAMI_URL: `http://${host}:1234`,
        UMAMI_WEBSITE_ID: configured.UMAMI_WEBSITE_ID,
        GLITCHTIP_DSN: `http://public@${host}:1234/17`,
      }
      expect(telemetryConfig(env).umami).toBeDefined()
      expect(telemetryConfig(env).glitchtip).toBeDefined()
      expect(telemetryConfig({ ...env, NODE_ENV: 'production' })).toEqual({ release })
    }
    expect(
      telemetryConfig({ NODE_ENV: 'test', GLITCHTIP_DSN: 'http://public@external.test/17' })
        .glitchtip,
    ).toBeUndefined()
  })
  it('adds precisely the configured CSP origins and no inline scripts or workers', () => {
    const off = telemetryCsp(telemetryConfig({}))
    expect(off).toContain("connect-src 'self';")
    expect(off).toContain("script-src 'self';")
    const on = telemetryCsp(telemetryConfig(configured))
    expect(on).toContain("connect-src 'self' https://analytics.example https://errors.example;")
    expect(on).toContain("script-src 'self' https://analytics.example;")
    expect(on).toContain("worker-src 'none'")
    expect(on).not.toMatch(/public@|unsafe-eval|script-src[^;]*unsafe-inline/)
  })
  it('serves a same-origin no-store GET endpoint without app authentication', async () => {
    server = createServer((req, res) => {
      if (!serveClientConfig(req, res, telemetryConfig(configured))) {
        res.statusCode = 404
        res.end()
      }
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (!bound || typeof bound === 'string') throw new Error('Server did not bind')
    const url = `http://127.0.0.1:${bound.port}/api/client-config`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(telemetryConfig(configured))
    expect((await fetch(url, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${url}/unknown`)).status).toBe(404)
  })
})
