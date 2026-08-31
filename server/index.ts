import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { abortApiJobs, createApiMiddleware, waitForApiJobs } from './api.ts'
import { createBundleStore } from './bundle-store.ts'
import { ensureCodexStorageReady } from './codex.ts'
import { createReviewHistory } from './review-history.ts'
import { createRoundStore } from './round-store.ts'

const port = Number.parseInt(process.env.PORT || '3000', 10)
const host = process.env.HOST || '0.0.0.0'
const forceDemo = process.env.MAIL_REVIEW_DEMO === '1'
const fastmailToken = process.env.FASTMAIL_JMAP_TOKEN?.trim()
const tikaUrl = process.env.TIKA_URL?.trim()

if (!forceDemo && !fastmailToken) {
  throw new Error('FASTMAIL_JMAP_TOKEN is required unless MAIL_REVIEW_DEMO=1 is explicit')
}
if (!forceDemo && !tikaUrl) {
  throw new Error('TIKA_URL is required unless MAIL_REVIEW_DEMO=1 is explicit')
}
if (tikaUrl) {
  const parsedTikaUrl = new URL(tikaUrl)
  if (!['http:', 'https:'].includes(parsedTikaUrl.protocol)) {
    throw new Error('TIKA_URL must use http or https')
  }
}
if (!forceDemo) ensureCodexStorageReady()

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url))
const staticDirectory = resolve(moduleDirectory, '../dist')
if (!existsSync(join(staticDirectory, 'index.html'))) {
  throw new Error(`Production frontend was not found at ${staticDirectory}`)
}

const reviewHistory = createReviewHistory()
const bundleStore = createBundleStore()
const roundStore = createRoundStore()
const api = createApiMiddleware({
  bundleStore,
  fastmailToken,
  forceDemo,
  reviewHistory,
  roundStore,
})
const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-src 'self' blob:",
      "img-src 'self' data: blob: https:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  )
}

async function serveFile(req: IncomingMessage, res: ServerResponse, path: string) {
  const stats = statSync(path)
  setSecurityHeaders(res)
  res.statusCode = 200
  res.setHeader('Content-Type', mimeTypes[extname(path)] ?? 'application/octet-stream')
  res.setHeader('Content-Length', String(stats.size))
  res.setHeader(
    'Cache-Control',
    path.includes(`${join(staticDirectory, 'assets')}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  )
  if (req.method === 'HEAD') return res.end()
  try {
    await pipeline(createReadStream(path), res)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'static_stream_error', message: error instanceof Error ? error.message : 'unknown' })}\n`,
    )
    if (!res.destroyed) res.destroy()
  }
}

async function serveFrontend(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    return res.end('Method not allowed')
  }
  const url = new URL(req.url || '/', 'http://localhost')
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    res.statusCode = 400
    return res.end('Bad request')
  }
  const normalized = normalize(decodedPath).replace(/^[/\\]+/, '')
  const candidate = resolve(staticDirectory, normalized)
  if (!candidate.startsWith(`${staticDirectory}/`) && candidate !== staticDirectory) {
    res.statusCode = 400
    return res.end('Bad request')
  }
  if (existsSync(candidate) && statSync(candidate).isFile())
    return await serveFile(req, res, candidate)
  if (extname(normalized)) {
    res.statusCode = 404
    return res.end('Not found')
  }
  return await serveFile(req, res, join(staticDirectory, 'index.html'))
}

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    setSecurityHeaders(res)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    return res.end(JSON.stringify({ status: 'ok' }))
  }
  void api(req, res, () => {
    void serveFrontend(req, res).catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ event: 'frontend_error', message: error instanceof Error ? error.message : 'unknown' })}\n`,
      )
      if (!res.headersSent) {
        res.statusCode = 500
        res.end('Internal server error')
      } else if (!res.destroyed) res.destroy()
    })
  }).catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ event: 'api_middleware_error', message: error instanceof Error ? error.message : 'unknown' })}\n`,
    )
    if (!res.headersSent) {
      res.statusCode = 500
      res.end('Internal server error')
    } else if (!res.destroyed) res.destroy()
  })
})

server.listen(port, host, () => {
  process.stdout.write(`Inbox Walk listening on ${host}:${port}\n`)
})

let shuttingDown = false

function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`Inbox Walk received ${signal}; shutting down\n`)
  abortApiJobs()
  server.close((error) => {
    void waitForApiJobs().finally(() => {
      reviewHistory.close()
      bundleStore.close()
      roundStore.close()
      if (error) {
        process.stderr.write(`Shutdown failed: ${error.message}\n`)
        process.exitCode = 1
      }
    })
  })
  setTimeout(() => {
    process.stderr.write('Forced shutdown after timeout\n')
    process.exit(1)
  }, 10_000).unref()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
