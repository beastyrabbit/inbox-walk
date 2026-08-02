import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 3

export class SafeHttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

function ipv4Number(address: string) {
  const parts = address.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null
  }
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  )
}

function inV4Range(value: number, base: number, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (base & mask)
}

function isBlockedAddress(address: string) {
  if (isIP(address) === 4) {
    const value = ipv4Number(address)
    if (value === null) return true
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(value, ipv4Number(String(base)) ?? 0, Number(bits)))
  }

  const normalized = address.toLowerCase()
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mapped) return isBlockedAddress(mapped)
  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  )
}

function parsePublicHttpsUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SafeHttpError('Die Zieladresse ist ungültig.', 'INVALID_URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    ['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase()) ||
    /\.(?:localhost|local|internal)$/i.test(url.hostname)
  ) {
    throw new SafeHttpError('Die Zieladresse ist nicht freigegeben.', 'URL_FORBIDDEN')
  }
  return url
}

async function publicAddress(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  const publicAddresses = addresses.filter(({ address }) => !isBlockedAddress(address))
  if (publicAddresses.length === 0) {
    throw new SafeHttpError('Die Zieladresse verweist auf ein internes Netz.', 'ADDRESS_FORBIDDEN')
  }
  return publicAddresses[0]
}

interface PinnedResponse {
  body: Buffer
  headers: import('node:http').IncomingHttpHeaders
  status: number
}

async function pinnedRequest(
  url: URL,
  options: {
    body?: Buffer
    headers?: Record<string, string>
    maxBytes: number
    method: 'GET' | 'POST'
  },
): Promise<PinnedResponse> {
  const resolved = await publicAddress(url.hostname)
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        family: resolved?.family,
        headers: { Host: url.host, ...options.headers },
        hostname: resolved?.address,
        method: options.method,
        path: `${url.pathname}${url.search}`,
        port: 443,
        servername: url.hostname,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        const declaredSize = Number(response.headers['content-length'] ?? 0)
        if (declaredSize > options.maxBytes) {
          response.destroy()
          reject(new SafeHttpError('Die Antwort ist zu groß.', 'RESPONSE_TOO_LARGE'))
          return
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxBytes) {
            response.destroy(new SafeHttpError('Die Antwort ist zu groß.', 'RESPONSE_TOO_LARGE'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () =>
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            status: response.statusCode ?? 502,
          }),
        )
        response.on('error', reject)
      },
    )
    req.on('timeout', () =>
      req.destroy(new SafeHttpError('Der Abruf hat zu lange gedauert.', 'TIMEOUT')),
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function safeSvg(body: Buffer) {
  const source = body
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  const withoutDeclaration = source.replace(/^<\?xml\s[^?]*\?>\s*/i, '')
  if (!/^<svg(?:\s|>)/i.test(withoutDeclaration)) return false
  return ![
    /<!doctype/i,
    /<!entity/i,
    /<\?(?!xml\s)/i,
    /<(?:script|foreignObject|iframe|object|embed|audio|video)\b/i,
    /\son[a-z]+\s*=/i,
    /\b(?:href|xlink:href)\s*=\s*["']\s*(?!#)[^"']+/i,
    /\burl\s*\(/i,
    /@import/i,
    /data\s*:\s*text\/html/i,
  ].some((pattern) => pattern.test(withoutDeclaration))
}

export function detectSafeImageType(body: Buffer) {
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (
    body.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    body.subarray(0, 6).toString('ascii') === 'GIF89a'
  )
    return 'image/gif'
  if (
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  if (
    body.subarray(4, 12).toString('ascii').includes('ftypavif') ||
    body.subarray(4, 12).toString('ascii').includes('ftypavis')
  )
    return 'image/avif'
  if (
    body.length >= 4 &&
    body[0] === 0x00 &&
    body[1] === 0x00 &&
    body[2] === 0x01 &&
    body[3] === 0x00
  )
    return 'image/x-icon'
  if (body[0] === 0x42 && body[1] === 0x4d) return 'image/bmp'
  if (safeSvg(body)) return 'image/svg+xml'
  return null
}

export async function fetchRemoteImage(value: string) {
  let url = parsePublicHttpsUrl(value)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await pinnedRequest(url, {
      headers: {
        Accept:
          'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/x-icon,image/bmp,*/*;q=0.1',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
      },
      maxBytes: MAX_IMAGE_BYTES,
      method: 'GET',
    })
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirect === MAX_REDIRECTS)
        throw new SafeHttpError('Zu viele Weiterleitungen.', 'TOO_MANY_REDIRECTS')
      url = parsePublicHttpsUrl(new URL(response.headers.location, url).toString())
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SafeHttpError(
        `Der Bildserver antwortete mit ${response.status}.`,
        'UPSTREAM_FAILED',
      )
    }
    const contentType = detectSafeImageType(response.body)
    if (!contentType)
      throw new SafeHttpError('Die Antwort ist kein unterstütztes Bild.', 'UNSUPPORTED_IMAGE')
    return { body: response.body, contentType }
  }
  throw new SafeHttpError('Zu viele Weiterleitungen.', 'TOO_MANY_REDIRECTS')
}

export async function postOneClickUnsubscribe(value: string) {
  const url = parsePublicHttpsUrl(value)
  const body = Buffer.from('List-Unsubscribe=One-Click')
  const response = await pinnedRequest(url, {
    body,
    headers: {
      Accept: 'text/plain, */*;q=0.1',
      'Content-Length': String(body.length),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    maxBytes: 64 * 1024,
    method: 'POST',
  })
  if (response.status < 200 || response.status >= 300) {
    throw new SafeHttpError(
      `Der Abmeldedienst antwortete mit ${response.status}.`,
      'UNSUBSCRIBE_FAILED',
    )
  }
}
