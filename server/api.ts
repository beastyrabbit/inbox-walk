import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type {
  ApiError,
  CodexAuthStatus,
  CodexLoginState,
  DraftResult,
  MailResource,
  ReplyEditorState,
  ReplyProposal,
  ReviewEmail,
  TriageActionResult,
  TriageSnapshot,
} from '../src/shared.ts'
import { TRIAGE_MEMORY_MAX_LENGTH } from '../src/shared.ts'
import { codexAuthStatus, getCodexAuthStorage, selectedCodexSettings } from './codex.ts'
import { IoError, ioSignal, withIoDeadline } from './io.ts'
import { JmapError } from './jmap.ts'
import { type Mailbox, threadResources } from './mailbox.ts'
import { appendSignature, computeReplyRecipients, escapeDraftHtml, ReplyError } from './reply.ts'
import { fetchRemoteImage, SafeHttpError } from './safe-http.ts'
import type { TriageEngine } from './triage-engine.ts'
import { type TriageStore, TriageStoreError } from './triage-store.ts'

const MAX_JSON_BYTES = 256 * 1024
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const MAX_CACHED_DETAILS = 300
const MAX_CACHED_RESULTS = 100
const INLINE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

const addressSchema = z.object({ name: z.string().max(320), email: z.string().email().max(320) })
const replyEditorAddressSchema = z.object({
  name: z.string().max(320),
  email: z.string().max(320),
})
const replyEditorSchema = z.object({
  bodyText: z.string().max(256_000),
  cc: z.array(replyEditorAddressSchema).max(100),
  ccText: z.string().max(64_000).optional(),
  draftRequestId: z.string().uuid().optional(),
  identityId: z.string().max(512),
  revisionInstruction: z.string().max(64_000),
  roughNotes: z.string().max(64_000),
  subject: z.string().max(998),
  to: z.array(replyEditorAddressSchema).max(100),
  toText: z.string().max(64_000).optional(),
})
const emailIdsSchema = z.object({
  emailIds: z.array(z.string().min(1).max(512)).min(1).max(500),
})

export interface ApiOptions {
  codexAuthStatus?: () => CodexAuthStatus
  codexAuthStorage?: () => Pick<ReturnType<typeof getCodexAuthStorage>, 'login'>
  engine: TriageEngine
  mailbox: Mailbox
  store: TriageStore
}

/** Process-local caches for mail bodies and the resources they reference. */
interface MailCache {
  blobMetadata: Map<string, MailResource>
  details: Map<string, ReviewEmail>
  draftResults: Map<string, DraftResult>
  /** Emails whose resources are registered, oldest first, so eviction can drop them. */
  resourceOwners: Map<string, { blobIds: string[]; imageIds: string[] }>
  draftWork: Map<string, Promise<DraftResult>>
  identities?: TriageSnapshotIdentities
  remoteImageIds: Map<string, Map<string, string>>
  remoteImageSources: Map<string, string>
  replyInFlight: Set<string>
  replyResults: Map<string, ReplyProposal>
  replyWork: Map<string, Promise<ReplyProposal>>
}

type TriageSnapshotIdentities = Awaited<ReturnType<Mailbox['identities']>>

const codexLogins = new Map<
  string,
  CodexLoginState & { controller: AbortController; createdAt: number }
>()

function securityHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
}

function json(res: ServerResponse, status: number, value: unknown) {
  securityHeaders(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

function apiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable = false,
  details?: unknown,
) {
  const payload: ApiError = { error: { code, message, retryable, ...(details ? { details } : {}) } }
  return json(res, status, payload)
}

async function readJson(req: IncomingMessage, maximumBytes = MAX_JSON_BYTES) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximumBytes)
      throw new ApiHttpError(413, 'BODY_TOO_LARGE', 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
  } catch {
    throw new ApiHttpError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  }
}

class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

function validateOrigin(req: IncomingMessage) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiHttpError(403, 'CROSS_SITE_REQUEST', 'Cross-site requests are not allowed')
  }
  const origin = req.headers.origin
  if (!origin) return
  const expectedHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    ?.trim()
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    throw new ApiHttpError(403, 'INVALID_ORIGIN', 'Invalid request origin')
  }
  if (!expectedHost || originHost !== expectedHost) {
    throw new ApiHttpError(403, 'INVALID_ORIGIN', 'Request origin does not match this service')
  }
}

export function safeCodexLoginUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') {
    throw new Error('Die Codex-Anmeldung hat eine unerwartete Zieladresse geliefert.')
  }
  return url.toString()
}

function pruneCodexLogins() {
  const cutoff = Date.now() - 20 * 60 * 1000
  for (const [id, state] of codexLogins) {
    if (state.createdAt < cutoff) {
      state.controller.abort()
      codexLogins.delete(id)
    }
  }
}

function codexLoginFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
  if (/network|fetch|connect|econn|dns/i.test(message)) return 'network'
  if (/cancel/i.test(message)) return 'cancelled'
  return 'unexpected'
}

async function startCodexLogin(res: ServerResponse, apiOptions: ApiOptions) {
  pruneCodexLogins()
  for (const state of codexLogins.values()) {
    if (state.status === 'starting' || state.status === 'waiting') state.controller.abort()
  }
  const id = randomUUID()
  const createdAt = Date.now()
  const controller = new AbortController()
  codexLogins.set(id, {
    id,
    controller,
    createdAt,
    status: 'starting',
    message: 'Anmeldung wird vorbereitet …',
  })
  const authStorage = (apiOptions.codexAuthStorage ?? getCodexAuthStorage)()
  void authStorage
    .login('openai-codex', {
      onAuth: ({ url }) => {
        codexLogins.set(id, {
          id,
          controller,
          createdAt,
          status: 'waiting',
          message: 'Öffne die OpenAI-Anmeldeseite.',
          url: safeCodexLoginUrl(url),
        })
      },
      onDeviceCode: ({ userCode, verificationUri }) => {
        codexLogins.set(id, {
          id,
          controller,
          createdAt,
          status: 'waiting',
          message: 'Melde dich mit ChatGPT an und bestätige diesen Gerätecode.',
          url: safeCodexLoginUrl(verificationUri),
          userCode,
        })
      },
      onPrompt: async () => {
        throw new Error('Die Codex-Anmeldung benötigt unerwartet eine interaktive Eingabe.')
      },
      onManualCodeInput: async () => {
        throw new Error('Die Codex-Anmeldung benötigt unerwartet einen manuellen Rückgabecode.')
      },
      onSelect: async ({ options: loginOptions }) =>
        loginOptions.find((option) => option.id === 'device_code')?.id,
      onProgress: (message) => {
        const current = codexLogins.get(id)
        if (current)
          codexLogins.set(id, {
            ...current,
            message: message ? 'Anmeldung wird verarbeitet …' : current.message,
          })
      },
      signal: controller.signal,
    })
    .then(() => {
      if (!codexLogins.has(id)) return
      codexLogins.set(id, {
        id,
        controller,
        createdAt,
        status: 'completed',
        message: 'Codex ist mit dem ChatGPT-Abo angemeldet.',
      })
    })
    .catch((error) => {
      if (!codexLogins.has(id)) return
      const reason = codexLoginFailureReason(error)
      process.stderr.write(`${JSON.stringify({ event: 'codex_login_failed', reason })}\n`)
      codexLogins.set(id, {
        id,
        controller,
        createdAt,
        status: 'failed',
        message:
          reason === 'cancelled'
            ? 'Die Anmeldung wurde durch einen neuen Versuch ersetzt.'
            : 'Die Codex-Anmeldung ist fehlgeschlagen. Bitte versuche es erneut.',
      })
    })
  return json(res, 202, { id })
}

function codexLoginState(res: ServerResponse, id: string) {
  pruneCodexLogins()
  const state = codexLogins.get(id)
  if (!state) throw new ApiHttpError(404, 'CODEX_LOGIN_NOT_FOUND', 'Anmeldung nicht gefunden.')
  const { controller: _controller, createdAt: _createdAt, ...payload } = state
  return json(res, 200, payload)
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
}

function normalizedRemoteImageSource(value: string) {
  const decoded = decodeHtmlAttribute(value.trim())
  if (!/^https?:\/\//i.test(decoded) && !decoded.startsWith('//')) return null
  try {
    const url = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded)
    return url.toString()
  } catch {
    return null
  }
}

function allowedRemoteImages(email: ReviewEmail) {
  const sources = new Set<string>()
  const html = email.html ?? ''
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  for (const match of html.matchAll(pattern)) {
    const source = normalizedRemoteImageSource(match[1] ?? match[2] ?? match[3] ?? '')
    if (source?.startsWith('https://')) sources.add(source)
  }
  return sources
}

function createMailCache(): MailCache {
  return {
    blobMetadata: new Map(),
    details: new Map(),
    draftResults: new Map(),
    draftWork: new Map(),
    remoteImageIds: new Map(),
    remoteImageSources: new Map(),
    replyInFlight: new Set(),
    replyResults: new Map(),
    replyWork: new Map(),
    resourceOwners: new Map(),
  }
}

/** Keeps an insertion-ordered map at its bound by dropping the oldest entries. */
function bound<K, V>(map: Map<K, V>, maximum: number) {
  while (map.size > maximum) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function forgetResources(cache: MailCache, emailId: string) {
  const owned = cache.resourceOwners.get(emailId)
  cache.resourceOwners.delete(emailId)
  if (!owned) return
  cache.remoteImageIds.delete(emailId)
  for (const imageId of owned.imageIds) cache.remoteImageSources.delete(`${emailId}/${imageId}`)
  const stillOwned = new Set([...cache.resourceOwners.values()].flatMap((owner) => owner.blobIds))
  for (const blobId of owned.blobIds) {
    if (!stillOwned.has(blobId)) cache.blobMetadata.delete(blobId)
  }
}

/** Registers blobs and proxied image IDs for one email, bounded to the newest emails. */
function registerResources(cache: MailCache, email: ReviewEmail) {
  const blobIds: string[] = []
  for (const resource of [...email.inlineResources, ...email.attachments]) {
    cache.blobMetadata.set(resource.blobId, resource)
    blobIds.push(resource.blobId)
  }
  const registered = cache.remoteImageIds.get(email.id) ?? new Map<string, string>()
  for (const source of allowedRemoteImages(email)) {
    if (registered.has(source)) continue
    const imageId = randomBytes(18).toString('base64url')
    registered.set(source, imageId)
    cache.remoteImageSources.set(`${email.id}/${imageId}`, source)
  }
  cache.remoteImageIds.set(email.id, registered)
  cache.resourceOwners.delete(email.id)
  cache.resourceOwners.set(email.id, { blobIds, imageIds: [...registered.values()] })
  while (cache.resourceOwners.size > MAX_CACHED_DETAILS) {
    const oldest = cache.resourceOwners.keys().next().value
    if (oldest === undefined) break
    cache.details.delete(oldest)
    forgetResources(cache, oldest)
  }
}

function rememberDetail(cache: MailCache, email: ReviewEmail) {
  cache.details.delete(email.id)
  cache.details.set(email.id, email)
  registerResources(cache, email)
  bound(cache.details, MAX_CACHED_DETAILS)
}

function emailPayload(cache: MailCache, email: ReviewEmail): ReviewEmail {
  return {
    ...email,
    remoteImageIds: Object.fromEntries(cache.remoteImageIds.get(email.id) ?? []),
  }
}

function requireKnownEmail(store: TriageStore, emailId: string) {
  const message = store.message(emailId)
  if (!message) throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht nicht gefunden.')
  return message
}

function requireCsrf(req: IncomingMessage, store: TriageStore) {
  validateOrigin(req)
  const token = req.headers['x-inbox-walk-csrf']
  if (token !== store.tokens().csrfToken) {
    throw new ApiHttpError(403, 'INVALID_CSRF', 'Ungültiges Sitzungs-Token.')
  }
}

function snapshot(options: ApiOptions): TriageSnapshot {
  const { store, mailbox, engine } = options
  const codex =
    mailbox.mode === 'demo'
      ? { configured: false, ...selectedCodexSettings() }
      : (options.codexAuthStatus ?? codexAuthStatus)()
  return {
    buckets: store.todo(),
    codex,
    ...store.tokens(),
    memory: store.memory(),
    mode: mailbox.mode,
    parked: store.parked(),
    status: engine.status(),
  }
}

async function loadDetail(cache: MailCache, mailbox: Mailbox, emailId: string) {
  const cached = cache.details.get(emailId)
  if (cached) return cached
  const email = await mailbox.detail(emailId)
  rememberDetail(cache, email)
  return email
}

/** Threads are fetched fresh so a reply never misses mail that arrived later. */
async function loadThread(cache: MailCache, mailbox: Mailbox, threadId: string) {
  const messages = await mailbox.thread(threadId)
  for (const email of messages) registerResources(cache, email)
  return messages
}

async function loadIdentities(cache: MailCache, mailbox: Mailbox) {
  if (cache.identities) return cache.identities
  cache.identities = await mailbox.identities()
  return cache.identities
}

async function todo(res: ServerResponse, options: ApiOptions) {
  return json(res, 200, snapshot(options))
}

async function refresh(req: IncomingMessage, res: ServerResponse, options: ApiOptions) {
  requireCsrf(req, options.store)
  await options.engine.refresh()
  return json(res, 200, snapshot(options))
}

/** Demo mode only: returns the sample inbox to its initial unread state. */
async function demoReset(req: IncomingMessage, res: ServerResponse, options: ApiOptions) {
  const { mailbox, store, engine } = options
  if (mailbox.mode !== 'demo' || !mailbox.reset) {
    throw new ApiHttpError(404, 'NOT_FOUND', 'Not found')
  }
  requireCsrf(req, store)
  mailbox.reset()
  store.reset()
  await engine.refresh()
  return json(res, 200, snapshot(options))
}

/** Only an explicit user action marks mail read, and only the named IDs. */
async function markDone(store: TriageStore, mailbox: Mailbox, emailIds: readonly string[]) {
  let marked: Awaited<ReturnType<Mailbox['markRead']>>
  try {
    marked = await mailbox.markRead(emailIds)
  } catch (error) {
    // Fastmail may have applied part of the batch before the failure; keep those done locally.
    if (error instanceof JmapError && error.details?.confirmedIds.length) {
      store.markDone(error.details.confirmedIds)
      store.logEvent('user_done', { count: error.details.confirmedIds.length, partial: true })
    }
    throw error
  }
  store.markDone(marked.markedIds)
  store.logEvent('user_done', { count: marked.markedIds.length })
  return marked.failed
}

async function messageAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'done' | 'park' | 'unpark' | 'newsletter' | 'retry',
  options: ApiOptions,
) {
  const { store, mailbox, engine } = options
  requireCsrf(req, store)
  const parsed = emailIdsSchema.safeParse(await readJson(req))
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_IDS', 'Ungültige Nachrichten-IDs.')
  const emailIds = [...new Set(parsed.data.emailIds)]
  for (const emailId of emailIds) requireKnownEmail(store, emailId)
  let failed: TriageActionResult['failed'] = []
  if (action === 'done') {
    failed = await markDone(store, mailbox, emailIds)
  } else if (action === 'park') {
    store.park(emailIds)
  } else if (action === 'unpark') {
    store.unpark(emailIds)
  } else if (action === 'newsletter') {
    // The label is only for detected newsletters; the UI hides the action elsewhere.
    const plain = emailIds.filter((emailId) => !store.message(emailId)?.summary.isNewsletter)
    if (plain.length > 0) {
      throw new ApiHttpError(
        400,
        'NOT_A_NEWSLETTER',
        'Diese Nachricht wurde nicht als Newsletter erkannt.',
        false,
        { emailIds: plain },
      )
    }
    const tagged = await mailbox.tagNewsletter(emailIds)
    failed = tagged.failed
    store.logEvent('user_newsletter', { count: tagged.succeededIds.length })
  } else {
    store.resetAttempts(emailIds)
    void engine.sort()
  }
  const result: TriageActionResult = { failed, snapshot: snapshot(options) }
  return json(res, failed.length > 0 ? 207 : 200, result)
}

async function emailDetail(
  res: ServerResponse,
  cache: MailCache,
  emailId: string,
  options: ApiOptions,
) {
  requireKnownEmail(options.store, emailId)
  const email = await loadDetail(cache, options.mailbox, emailId)
  return json(res, 200, emailPayload(cache, email))
}

async function remoteImage(
  res: ServerResponse,
  url: URL,
  cache: MailCache,
  emailId: string,
  imageId: string,
  options: ApiOptions,
) {
  if (url.searchParams.get('token') !== options.store.tokens().imageToken) {
    throw new ApiHttpError(403, 'INVALID_IMAGE_TOKEN', 'Ungültiger Bildzugriff.')
  }
  requireKnownEmail(options.store, emailId)
  if (!cache.details.has(emailId))
    throw new ApiHttpError(409, 'EMAIL_NOT_LOADED', 'Nachricht wurde noch nicht geladen.')
  const source = cache.remoteImageSources.get(`${emailId}/${imageId}`)
  if (!source) {
    throw new ApiHttpError(403, 'IMAGE_FORBIDDEN', 'Dieses Bild gehört nicht zur Nachricht.')
  }
  try {
    const image = await fetchRemoteImage(source)
    securityHeaders(res)
    res.statusCode = 200
    res.setHeader('Content-Type', image.contentType)
    res.setHeader('Content-Length', image.body.length)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.end(image.body)
  } catch (error) {
    if (error instanceof SafeHttpError) {
      throw new ApiHttpError(502, error.code, error.message, true)
    }
    throw error
  }
}

async function threadContext(
  res: ServerResponse,
  cache: MailCache,
  threadId: string,
  emailId: string,
  options: ApiOptions,
) {
  requireKnownEmail(options.store, emailId)
  const messages = await loadThread(cache, options.mailbox, threadId)
  if (!messages.some((message) => message.id === emailId))
    throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht gehört nicht zu diesem Thread.')
  const identities = await loadIdentities(cache, options.mailbox)
  const replyTarget = messages.at(-1)
  if (!replyTarget)
    throw new ApiHttpError(409, 'THREAD_EMPTY', 'Der Thread enthält keine Nachricht.')
  return json(res, 200, {
    messages,
    identities,
    recipients: computeReplyRecipients(replyTarget, identities),
    attachmentManifest: threadResources(messages),
  })
}

async function blob(
  res: ServerResponse,
  url: URL,
  cache: MailCache,
  blobId: string,
  options: ApiOptions,
) {
  if (options.mailbox.mode !== 'live')
    throw new ApiHttpError(404, 'BLOB_NOT_FOUND', 'Datei nicht gefunden.')
  const resource = cache.blobMetadata.get(blobId)
  if (!resource) throw new ApiHttpError(403, 'BLOB_FORBIDDEN', 'Datei ist nicht freigegeben.')
  if (resource.size > MAX_DOWNLOAD_BYTES)
    throw new ApiHttpError(413, 'BLOB_TOO_LARGE', 'Datei ist größer als 100 MiB.')
  const signal = ioSignal(120_000)
  const upstream = await options.mailbox.downloadBlob(resource, signal)
  if (!upstream.body)
    throw new ApiHttpError(502, 'EMPTY_BLOB', 'Fastmail hat keine Dateidaten geliefert.', true)
  const inline =
    url.searchParams.get('inline') === '1' && INLINE_TYPES.has(resource.type.toLowerCase())
  securityHeaders(res)
  res.statusCode = 200
  res.setHeader('Content-Type', inline ? resource.type : 'application/octet-stream')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(resource.name.slice(0, 240))}`,
  )
  const contentLength = upstream.headers.get('content-length')
  if (Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    void upstream.body.cancel().catch(() => {})
    throw new ApiHttpError(413, 'BLOB_TOO_LARGE', 'Datei ist größer als 100 MiB.')
  }
  if (contentLength) res.setHeader('Content-Length', contentLength)
  try {
    let size = 0
    const bound = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        callback(
          size > MAX_DOWNLOAD_BYTES
            ? new IoError('Datei ist größer als 100 MiB.', 'BLOB_TOO_LARGE')
            : null,
          chunk,
        )
      },
    })
    await pipeline(Readable.fromWeb(upstream.body as never), bound, res, { signal })
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'blob_stream_error', message: error instanceof Error ? error.message : 'unknown' })}\n`,
    )
    if (!res.destroyed) res.destroy()
  }
}

async function reply(
  req: IncomingMessage,
  res: ServerResponse,
  cache: MailCache,
  emailId: string,
  options: ApiOptions,
) {
  const { store, mailbox } = options
  requireCsrf(req, store)
  const parsed = z
    .object({
      requestId: z.string().uuid(),
      roughNotes: z.string().max(64_000),
      currentDraft: z.string().max(128_000).optional(),
      revisionInstruction: z.string().max(64_000).optional(),
    })
    .safeParse(await readJson(req))
  if (!parsed.success)
    throw new ApiHttpError(400, 'INVALID_REPLY_REQUEST', 'Ungültige Entwurfsanfrage.')
  const { summary } = requireKnownEmail(store, emailId)
  // A request ID belongs to one message; reusing it elsewhere must not return this proposal.
  const requestId = `${emailId}:${parsed.data.requestId}`
  const finished = cache.replyResults.get(requestId)
  if (finished) return json(res, 200, finished)
  const existing = cache.replyWork.get(requestId)
  if (existing) return json(res, 200, await existing)
  if (cache.replyInFlight.has(emailId)) {
    throw new ApiHttpError(
      409,
      'REPLY_IN_PROGRESS',
      'Für diese Nachricht wird bereits ein Entwurf erstellt.',
      true,
    )
  }
  cache.replyInFlight.add(emailId)
  const work = (async () => {
    const messages = await loadThread(cache, mailbox, summary.threadId)
    if (mailbox.mode === 'live') {
      const auth = (options.codexAuthStatus ?? codexAuthStatus)()
      if (!auth.configured)
        throw new ApiHttpError(
          503,
          'CODEX_NOT_CONFIGURED',
          'Codex ist noch nicht mit dem ChatGPT-Abo angemeldet.',
        )
    }
    return await mailbox.generateReply(messages, parsed.data)
  })()
  cache.replyWork.set(requestId, work)
  try {
    const proposal = await work
    cache.replyResults.set(requestId, proposal)
    bound(cache.replyResults, MAX_CACHED_RESULTS)
    return json(res, 200, proposal)
  } finally {
    cache.replyWork.delete(requestId)
    cache.replyInFlight.delete(emailId)
  }
}

async function draft(
  req: IncomingMessage,
  res: ServerResponse,
  cache: MailCache,
  emailId: string,
  options: ApiOptions,
) {
  const { store, mailbox } = options
  requireCsrf(req, store)
  const parsed = z
    .object({
      requestId: z.string().uuid(),
      identityId: z.string().min(1),
      to: z.array(addressSchema).min(1).max(100),
      cc: z.array(addressSchema).max(100),
      subject: z.string().min(1).max(998),
      bodyText: z.string().min(1).max(256_000),
    })
    .safeParse(await readJson(req))
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_DRAFT', 'Ungültige Draft-Daten.')
  const { requestId, ...draftPayload } = parsed.data
  const fingerprint = createHash('sha256').update(JSON.stringify(draftPayload)).digest('hex')
  const key = `${emailId}:${requestId}:${fingerprint}`
  const cached = cache.draftResults.get(key)
  if (cached) return json(res, 200, cached)
  if (
    [...cache.draftResults.keys()].some((entry) => entry.startsWith(`${emailId}:${requestId}:`))
  ) {
    throw new ApiHttpError(
      409,
      'DRAFT_REQUEST_CONFLICT',
      'Diese Draft-Anfrage wurde bereits mit anderem Inhalt verwendet. Bitte versuche es erneut.',
    )
  }
  const inFlight = cache.draftWork.get(key)
  if (inFlight) return json(res, 200, await inFlight)
  const { summary } = requireKnownEmail(store, emailId)
  const work = (async (): Promise<DraftResult> => {
    const messages = await loadThread(cache, mailbox, summary.threadId)
    const identities = await loadIdentities(cache, mailbox)
    const identity = identities.find((item) => item.id === parsed.data.identityId)
    if (!identity) throw new ApiHttpError(400, 'INVALID_IDENTITY', 'Unbekannte Absenderidentität.')
    const latest = messages.at(-1)
    if (!latest) throw new ApiHttpError(409, 'THREAD_EMPTY', 'Der Thread enthält keine Nachricht.')
    const bodyText = appendSignature(parsed.data.bodyText, identity)
    const htmlSignature = identity.htmlSignature.trim()
      ? identity.htmlSignature
      : escapeDraftHtml(identity.textSignature.trim())
    const bodyHtml = `${escapeDraftHtml(parsed.data.bodyText.trim())}${htmlSignature ? `<br><br>${htmlSignature}` : ''}`
    const references = [...new Set([...latest.references, ...latest.messageId])]
    return await mailbox.createDraft({
      bodyHtml,
      bodyText,
      cc: parsed.data.cc,
      from: { name: identity.name, email: identity.email },
      inReplyTo: latest.messageId.slice(0, 1),
      references,
      subject: parsed.data.subject,
      threadId: summary.threadId,
      to: parsed.data.to,
    })
  })()
  cache.draftWork.set(key, work)
  try {
    const result = await work
    cache.draftResults.set(key, result)
    bound(cache.draftResults, MAX_CACHED_RESULTS)
    store.logEvent('user_draft', { threadId: summary.threadId })
    return json(res, 201, result)
  } finally {
    cache.draftWork.delete(key)
  }
}

function replyEditor(res: ServerResponse, emailId: string, options: ApiOptions) {
  requireKnownEmail(options.store, emailId)
  return json(res, 200, { editor: options.store.replyEditor(emailId) })
}

async function saveReplyEditor(
  req: IncomingMessage,
  res: ServerResponse,
  emailId: string,
  options: ApiOptions,
) {
  requireCsrf(req, options.store)
  requireKnownEmail(options.store, emailId)
  const parsed = z.object({ editor: replyEditorSchema }).safeParse(await readJson(req))
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_EDITOR', 'Ungültiger Entwurfsstand.')
  options.store.saveReplyEditor(emailId, parsed.data.editor as ReplyEditorState)
  return json(res, 200, { editor: parsed.data.editor })
}

async function saveMemory(req: IncomingMessage, res: ServerResponse, options: ApiOptions) {
  requireCsrf(req, options.store)
  const parsed = z
    .object({ notes: z.string().max(TRIAGE_MEMORY_MAX_LENGTH) })
    .safeParse(await readJson(req))
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_MEMORY', 'Ungültige Notizen.')
  return json(res, 200, options.store.setMemoryNotes(parsed.data.notes))
}

function decideProposal(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  accept: boolean,
  options: ApiOptions,
) {
  requireCsrf(req, options.store)
  if (accept) {
    const memory = options.store.acceptProposal(id)
    if (!memory) throw new ApiHttpError(404, 'PROPOSAL_NOT_FOUND', 'Vorschlag nicht gefunden.')
    return json(res, 200, memory)
  }
  options.store.rejectProposal(id)
  return json(res, 200, options.store.memory())
}

function logApiError(error: unknown) {
  if (error instanceof ApiHttpError && error.status < 500) return
  const code =
    error instanceof ApiHttpError || error instanceof JmapError || error instanceof ReplyError
      ? error.code
      : 'INTERNAL_ERROR'
  process.stderr.write(
    `${JSON.stringify({ event: 'api_error', code, message: error instanceof Error ? error.message : 'unknown' })}\n`,
  )
}

interface ErrorResponse {
  code: string
  details?: unknown
  message: string
  retryable: boolean
  status: number
}

const TIMEOUT_MESSAGE =
  'Der externe Abruf konnte nicht innerhalb der sicheren Grenzen abgeschlossen werden.'

function errorResponse(error: unknown): ErrorResponse {
  if (error instanceof ApiHttpError || error instanceof ReplyError) return error
  if (error instanceof JmapError) {
    const status = error.status === 401 || error.status === 404 ? error.status : 502
    return { ...error, message: error.message, retryable: status >= 500, status }
  }
  if (error instanceof TriageStoreError) {
    const status = error.code === 'INVALID_BUCKET' ? 400 : 404
    return { code: error.code, message: error.message, retryable: false, status }
  }
  if (error instanceof IoError) {
    return { code: error.code, message: TIMEOUT_MESSAGE, retryable: true, status: 504 }
  }
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return { code: 'IO_TIMEOUT', message: TIMEOUT_MESSAGE, retryable: true, status: 504 }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Ein interner Fehler ist aufgetreten.',
    retryable: true,
    status: 500,
  }
}

function handleError(res: ServerResponse, error: unknown) {
  logApiError(error)
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy()
    return
  }
  const response = errorResponse(error)
  return apiError(
    res,
    response.status,
    response.code,
    response.message,
    response.retryable,
    response.details,
  )
}

type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown

const MESSAGE_ACTIONS = new Set(['done', 'park', 'unpark', 'newsletter', 'retry'])

function authRoute(method: string | undefined, parts: string[], options: ApiOptions): Route | null {
  if (parts[1] !== 'auth' || parts[2] !== 'codex') return null
  if (method === 'GET' && parts[3] === 'status' && !parts[4]) {
    return (_req, res) =>
      json(
        res,
        200,
        options.mailbox.mode === 'demo'
          ? { configured: false, ...selectedCodexSettings() }
          : (options.codexAuthStatus ?? codexAuthStatus)(),
      )
  }
  if (method === 'POST' && parts[3] === 'start' && !parts[4]) {
    return (req, res) => {
      validateOrigin(req)
      return startCodexLogin(res, options)
    }
  }
  if (method === 'GET' && parts[3] && !parts[4]) {
    return (_req, res) => codexLoginState(res, parts[3] ?? '')
  }
  return null
}

function todoRoute(method: string | undefined, parts: string[], options: ApiOptions): Route | null {
  const [, , section, key, sub] = parts
  if (method === 'GET' && !section) {
    return (req, res) => {
      validateOrigin(req)
      return todo(res, options)
    }
  }
  if (method === 'POST' && section === 'refresh' && !key) {
    return (req, res) => refresh(req, res, options)
  }
  if (method === 'POST' && section === 'demo-reset' && !key) {
    return (req, res) => demoReset(req, res, options)
  }
  if (method === 'POST' && section === 'messages' && key && !sub && MESSAGE_ACTIONS.has(key)) {
    return (req, res) => messageAction(req, res, key as never, options)
  }
  if (method === 'PUT' && section === 'memory' && !key) {
    return (req, res) => saveMemory(req, res, options)
  }
  if (method === 'POST' && section === 'memory' && key === 'proposals' && sub) {
    const decision = parts[5]
    if (decision === 'accept' || decision === 'reject') {
      return (req, res) => decideProposal(req, res, sub, decision === 'accept', options)
    }
  }
  return null
}

function emailRoute(
  method: string | undefined,
  emailId: string,
  sub: string | undefined,
  extra: string | undefined,
  cache: MailCache,
  options: ApiOptions,
): Route | null {
  if (method === 'GET' && !sub) {
    return (_req, res) => emailDetail(res, cache, emailId, options)
  }
  if (method === 'GET' && sub === 'images' && extra) {
    return (_req, res, url) => remoteImage(res, url, cache, emailId, extra, options)
  }
  if (method === 'GET' && sub === 'editor') {
    return (_req, res) => replyEditor(res, emailId, options)
  }
  if (method === 'PUT' && sub === 'editor') {
    return (req, res) => saveReplyEditor(req, res, emailId, options)
  }
  if (method === 'POST' && sub === 'replies') {
    return (req, res) => reply(req, res, cache, emailId, options)
  }
  if (method === 'POST' && sub === 'drafts') {
    return (req, res) => draft(req, res, cache, emailId, options)
  }
  return null
}

function mailRoute(
  method: string | undefined,
  parts: string[],
  cache: MailCache,
  options: ApiOptions,
): Route | null {
  const [, , section, key, sub, extra] = parts
  if (section === 'emails' && key) return emailRoute(method, key, sub, extra, cache, options)
  if (method === 'GET' && section === 'threads' && key) {
    return (_req, res, url) =>
      threadContext(res, cache, key, url.searchParams.get('emailId') ?? '', options)
  }
  if (method === 'GET' && section === 'blobs' && key) {
    return (_req, res, url) => blob(res, url, cache, key, options)
  }
  return null
}

export function createApiMiddleware(apiOptions: ApiOptions) {
  const cache = createMailCache()
  return (req: IncomingMessage, res: ServerResponse, next: () => void) =>
    withIoDeadline(async () => {
      if (!req.url?.startsWith('/api/')) return next()
      const url = new URL(req.url, 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)
      try {
        const route =
          authRoute(req.method, parts, apiOptions) ??
          (parts[1] === 'todo'
            ? (todoRoute(req.method, parts, apiOptions) ??
              mailRoute(req.method, parts, cache, apiOptions))
            : null)
        if (!route) return apiError(res, 404, 'NOT_FOUND', 'Not found')
        return await route(req, res, url)
      } catch (error) {
        return handleError(res, error)
      }
    })
}

export function clearApiStateForTests() {
  for (const state of codexLogins.values()) state.controller.abort()
  codexLogins.clear()
}
