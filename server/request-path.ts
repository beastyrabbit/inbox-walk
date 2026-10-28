import type { IncomingMessage, ServerResponse } from 'node:http'
import { legalRoutes } from './legal/pages.ts'

/** Badger forwards Go's decoded URL.Path; Pangolin 1.24.0 decodes and resolves it again. */
export function pangolinView(rawPath: string): string | null {
  if (/%(?![\da-f]{2})/i.test(rawPath)) return null
  // Go unescapes bytes without requiring valid UTF-8. JSON replaces invalid UTF-8.
  const decodedPath = rawPath.replace(/(?:%[\da-f]{2})+/gi, (encoded) =>
    Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8'),
  )
  const resolved: string[] = []
  for (const rawPart of decodedPath.split('/').filter(Boolean)) {
    let part: string
    try {
      part = decodeURIComponent(rawPart)
    } catch {
      part = rawPart
    }
    for (const segment of part.split('/').filter(Boolean)) {
      if (segment === '.') continue
      if (segment === '..') resolved.pop()
      else resolved.push(segment)
    }
  }
  return `/${resolved.join('/')}`
}

/** Check the raw target before URL parsing can hide proxy/routing disagreements. */
export function isSafeRequestPath(target: string | undefined): boolean {
  const path = target?.split('?', 1)[0]
  if (!path?.startsWith('/') || /%25|%2f|%5c|\\|\/\//i.test(path)) return false
  const view = pangolinView(path)
  if (view === null || (Object.hasOwn(legalRoutes, view) && path !== view)) return false
  try {
    return path.split('/').every((part) => {
      const decoded = decodeURIComponent(part)
      return decoded !== '.' && decoded !== '..'
    })
  } catch {
    return false
  }
}

/** Must run before legal pages, API/session handling, telemetry and static routing. */
export function rejectUnsafeRequestPath(req: IncomingMessage, res: ServerResponse): boolean {
  if (isSafeRequestPath(req.url)) return false
  res.statusCode = 400
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.end('Bad request')
  return true
}
