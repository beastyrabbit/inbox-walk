import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ClientConfig } from '../src/telemetry-contract.ts'

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }
export const release = `inbox-walk@${version}`

function publicUrl(raw: string | undefined, test: boolean, dsn = false) {
  if (!raw?.trim()) return undefined
  try {
    const url = new URL(raw.trim())
    if (
      url.protocol !== 'https:' &&
      !(test && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      return undefined
    if (url.password || url.search || url.hash) return undefined
    if (dsn) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(url.username) || !/^\/\d+$/.test(url.pathname))
        return undefined
    } else if (url.username || !['', '/'].includes(url.pathname)) return undefined
    return url
  } catch {
    return undefined
  }
}

export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const test = env.NODE_ENV === 'test'
  const config: ClientConfig = { release }
  const umami = publicUrl(env.UMAMI_URL, test)
  const websiteId = env.UMAMI_WEBSITE_ID?.trim()
  if (
    umami &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(websiteId ?? '')
  ) {
    config.umami = {
      url: umami.origin,
      websiteId: websiteId as string,
      replay: !['0', 'false', 'off'].includes(env.UMAMI_REPLAY ?? ''),
    }
  }
  const dsn = publicUrl(env.GLITCHTIP_DSN, test, true)
  if (dsn) {
    const rate = Number(env.GLITCHTIP_TRACES_SAMPLE_RATE ?? '0.1')
    const environment = env.GLITCHTIP_ENVIRONMENT ?? 'production'
    config.glitchtip = {
      dsn: dsn.toString(),
      environment: /^[a-z][a-z0-9_-]{0,31}$/.test(environment) ? environment : 'production',
      tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.1,
    }
  }
  return config
}

export function telemetryCsp(config: ClientConfig) {
  const umami = config.umami ? ` ${new URL(config.umami.url).origin}` : ''
  const glitchtip = config.glitchtip ? ` ${new URL(config.glitchtip.dsn).origin}` : ''
  return [
    "default-src 'self'",
    "base-uri 'none'",
    `connect-src 'self'${umami}${glitchtip}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-src 'self' blob:",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    `script-src 'self'${umami}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'none'",
  ].join('; ')
}

export function serveClientConfig(req: IncomingMessage, res: ServerResponse, config: ClientConfig) {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/client-config') return false
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method !== 'GET') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET')
    res.end()
  } else {
    res.statusCode = 200
    res.end(JSON.stringify(config))
  }
  return true
}
