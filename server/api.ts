import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type {
  ApiError,
  CodexAuthStatus,
  CodexLoginState,
  CodexModelId,
  DraftResult,
  FinalizeResult,
  MailboxOption,
  MailIdentity,
  MailResource,
  ReplyProposal,
  ReviewBundleRun,
  ReviewEmail,
  ReviewEmailSummary,
  ReviewFilters,
  ReviewSnapshot,
  ThreadMessage,
} from '../src/shared.ts'
import { defaultReviewFilters } from '../src/shared.ts'
import type { BundleStore } from './bundle-store.ts'
import {
  buildReviewBundles,
  type DecideBundle,
  learningSignalsFor,
  singletonBundleRun,
} from './bundles.ts'
import {
  codexAuthStatus,
  getCodexAuthStorage,
  runCodexBundleDecision,
  selectCodexModel,
} from './codex.ts'
import { demoEmails } from './demo.ts'
import {
  createAndVerifyDraft,
  downloadBlob,
  fetchEmailDetail,
  fetchIdentities,
  fetchReviewOptions,
  fetchThread,
  fetchUnreadEmailIds,
  fetchUnreadSnapshot,
  JmapError,
  type LiveSnapshotData,
  type MailAccountContext,
  markEmailsRead,
  moveEmailsOutOfSpam,
  resumeSnapshot,
  tagEmailsForLaterUnsubscribe,
} from './jmap.ts'
import {
  appendSignature,
  computeReplyRecipients,
  escapeDraftHtml,
  generateReply,
  ReplyError,
  type ReplyRequest,
} from './reply.ts'
import type { ReviewHistory } from './review-history.ts'
import { fetchRemoteImage, SafeHttpError } from './safe-http.ts'

const MAX_JSON_BYTES = 256 * 1024
const MAX_SELECTION_JSON_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOTS = 20
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const INLINE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

const filtersSchema = z.object({
  hideReviewed: z.boolean().default(false),
  mailboxId: z.string().min(1).nullable(),
  newsletter: z.enum(['all', 'exclude', 'only']),
  spam: z.enum(['exclude', 'only']).default('exclude'),
  timeRange: z.enum(['all', '24h', '7d', '30d']),
})

const codexModelSchema = z.object({
  model: z.enum(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
})

const addressSchema = z.object({ name: z.string().max(320), email: z.string().email().max(320) })

interface StoredSnapshot {
  blobMetadata: Map<string, MailResource>
  bundleRun?: ReviewBundleRun
  bundleWork?: Promise<ReviewBundleRun>
  context?: MailAccountContext
  createdAt: number
  csrfToken: string
  detailCache: Map<string, ReviewEmail>
  draftResults: Map<string, DraftResult>
  emailIds: string[]
  filters: ReviewFilters
  finalEmailIds?: Set<string>
  finalKeepIds?: Set<string>
  finalSecondaryActionIds?: Set<string>
  finalizationState: 'active' | 'finalized' | 'finalizing'
  identities?: MailIdentity[]
  imageToken: string
  lastAccessedAt: number
  mailboxes: MailboxOption[]
  mode: 'demo' | 'live'
  replyCache: Map<string, Promise<ReplyProposal>>
  replyInFlight: Set<string>
  remoteImageIds: Map<string, Map<string, string>>
  remoteImageSources: Map<string, string>
  summaries: Map<string, ReviewEmailSummary>
  secondaryActionFailures: Map<string, string>
  secondaryActionSucceededIds: Set<string>
  succeededIds: Set<string>
  threadCache: Map<string, ThreadMessage[]>
}

export interface ApiOptions {
  bundleDecider?: DecideBundle
  bundleStore?: Pick<BundleStore, 'examples' | 'record'>
  codexAuthStatus?: () => CodexAuthStatus
  codexAuthStorage?: () => Pick<ReturnType<typeof getCodexAuthStorage>, 'login'>
  codexModelSelect?: (model: CodexModelId) => CodexAuthStatus
  demoMessages?: ReviewEmail[]
  fastmailToken?: string
  forceDemo?: boolean
  reviewHistory?: ReviewHistory
}

const snapshots = new Map<string, StoredSnapshot>()
interface CodexLoginRecord extends CodexLoginState {
  controller: AbortController
  createdAt: number
}
const codexLogins = new Map<string, CodexLoginRecord>()

function securityHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
}

function uniqueResources(messages: ThreadMessage[]) {
  const resources = new Map<string, MailResource>()
  for (const message of messages) {
    for (const resource of [...message.inlineResources, ...message.attachments]) {
      resources.set(resource.blobId, resource)
    }
  }
  return [...resources.values()]
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

function pruneSnapshots() {
  const cutoff = Date.now() - SNAPSHOT_TTL_MS
  for (const [id, snapshot] of snapshots) {
    if (snapshot.lastAccessedAt < cutoff) snapshots.delete(id)
  }
  if (snapshots.size <= MAX_SNAPSHOTS) return
  const oldest = [...snapshots.entries()].sort(
    ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt,
  )
  for (const [id] of oldest.slice(0, snapshots.size - MAX_SNAPSHOTS)) snapshots.delete(id)
}

function filterDemoEmails(
  filters: ReviewFilters,
  retainedIds: ReadonlySet<string>,
  messages = demoEmails,
) {
  const hours =
    filters.timeRange === 'all' ? 0 : { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[filters.timeRange]
  const cutoff = hours ? Date.now() - hours * 3_600_000 : 0
  return messages.filter((email) => {
    if (filters.hideReviewed && retainedIds.has(email.id)) return false
    const isSpam = email.mailboxNames.includes('Spam')
    if ((filters.spam === 'only') !== isSpam) return false
    if (filters.mailboxId && !email.mailboxNames.includes(filters.mailboxId)) return false
    if (cutoff && Date.parse(email.receivedAt) < cutoff) return false
    if (filters.newsletter === 'only' && !email.isNewsletter) return false
    if (filters.newsletter === 'exclude' && email.isNewsletter) return false
    return true
  })
}

function summariesFor(emails: ReviewEmail[]) {
  return emails.map(
    ({
      html: _html,
      text: _text,
      bodyTruncated: _truncated,
      inlineResources: _inline,
      attachments: _attachments,
      cc: _cc,
      replyTo: _replyTo,
      messageId: _messageId,
      inReplyTo: _inReplyTo,
      references: _references,
      ...summary
    }) => summary,
  )
}

function storeSnapshot(
  data: Pick<LiveSnapshotData, 'emails' | 'filters' | 'mailboxes'> & {
    context?: MailAccountContext
    mode: 'demo' | 'live'
    details?: ReviewEmail[]
  },
) {
  pruneSnapshots()
  const snapshotId = randomUUID()
  const csrfToken = randomBytes(24).toString('base64url')
  const imageToken = randomBytes(24).toString('base64url')
  const details = new Map((data.details ?? []).map((email) => [email.id, email]))
  const snapshot: StoredSnapshot = {
    blobMetadata: new Map(),
    context: data.context,
    createdAt: Date.now(),
    csrfToken,
    detailCache: details,
    draftResults: new Map(),
    emailIds: data.emails.map((email) => email.id),
    filters: data.filters,
    finalizationState: 'active',
    imageToken,
    lastAccessedAt: Date.now(),
    mailboxes: data.mailboxes,
    mode: data.mode,
    replyCache: new Map(),
    replyInFlight: new Set(),
    remoteImageIds: new Map(),
    remoteImageSources: new Map(),
    secondaryActionFailures: new Map(),
    secondaryActionSucceededIds: new Set(),
    succeededIds: new Set(),
    summaries: new Map(data.emails.map((email) => [email.id, email])),
    threadCache: new Map(),
  }
  for (const email of details.values()) registerResources(snapshot, email)
  snapshots.set(snapshotId, snapshot)
  return { snapshotId, csrfToken, snapshot }
}

function snapshotPayload(
  id: string,
  snapshot: StoredSnapshot,
  metadata: { missingIds?: string[]; totalBeforeLimit?: number; truncated?: boolean } = {},
): ReviewSnapshot {
  return {
    csrfToken: snapshot.csrfToken,
    imageToken: snapshot.imageToken,
    emails: snapshot.emailIds
      .map((emailId) => snapshot.summaries.get(emailId))
      .filter((email): email is ReviewEmailSummary => Boolean(email)),
    filters: snapshot.filters,
    missingIds: metadata.missingIds ?? [],
    mode: snapshot.mode,
    snapshotId: id,
    totalBeforeLimit: metadata.totalBeforeLimit ?? snapshot.emailIds.length,
    truncated: metadata.truncated ?? false,
  }
}

function registerResources(snapshot: StoredSnapshot, email: ReviewEmail) {
  for (const resource of [...email.inlineResources, ...email.attachments]) {
    snapshot.blobMetadata.set(resource.blobId, resource)
  }
  const registered = snapshot.remoteImageIds.get(email.id) ?? new Map<string, string>()
  for (const source of allowedRemoteImages(email)) {
    if (registered.has(source)) continue
    const imageId = randomBytes(18).toString('base64url')
    registered.set(source, imageId)
    snapshot.remoteImageSources.set(`${email.id}/${imageId}`, source)
  }
  snapshot.remoteImageIds.set(email.id, registered)
}

function emailPayload(snapshot: StoredSnapshot, email: ReviewEmail): ReviewEmail {
  return {
    ...email,
    remoteImageIds: Object.fromEntries(snapshot.remoteImageIds.get(email.id) ?? []),
  }
}

function getSnapshot(id: string) {
  pruneSnapshots()
  const snapshot = snapshots.get(id)
  if (!snapshot) throw new ApiHttpError(410, 'REVIEW_EXPIRED', 'Diese Sitzung ist abgelaufen.')
  snapshot.lastAccessedAt = Date.now()
  return snapshot
}

function requireCsrf(req: IncomingMessage, snapshot: StoredSnapshot) {
  validateOrigin(req)
  if (req.headers['x-inbox-walk-csrf'] !== snapshot.csrfToken) {
    throw new ApiHttpError(403, 'INVALID_CSRF', 'Ungültiger Sicherheitsschlüssel.')
  }
}

function parseFilters(value: unknown) {
  const parsed = filtersSchema.safeParse(value ?? defaultReviewFilters)
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_FILTERS', 'Ungültige Filter.')
  return parsed.data
}

function updateReviewHistory(
  history: ReviewHistory | undefined,
  keptUnreadIds: ReadonlySet<string>,
  markedReadIds: readonly string[],
) {
  if (!history) return
  try {
    history.rememberKeptUnread([...keptUnreadIds])
    history.forget(markedReadIds)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'review_history_update_failed',
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`,
    )
  }
}

async function createReview(
  res: ServerResponse,
  body: Record<string, unknown>,
  options: ApiOptions,
) {
  const filters = parseFilters(body.filters)
  const retainedIds = options.reviewHistory?.retainedIds() ?? new Set<string>()
  if (options.forceDemo) {
    const details = filterDemoEmails(filters, retainedIds, options.demoMessages)
    const emails = summariesFor(details)
    const stored = storeSnapshot({
      emails,
      filters,
      mailboxes: [
        { id: 'Inbox', name: 'Inbox', role: 'inbox' },
        { id: 'Newsletter', name: 'Newsletter' },
        { id: 'Reisen', name: 'Reisen' },
        { id: 'Spam', name: 'Spam', role: 'junk' },
      ],
      mode: 'demo',
      details,
    })
    return json(res, 201, snapshotPayload(stored.snapshotId, stored.snapshot))
  }
  const token = options.fastmailToken?.trim()
  if (!token)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht konfiguriert.')
  const data = await fetchUnreadSnapshot(token, filters, retainedIds)
  const stored = storeSnapshot({ ...data, mode: 'live' })
  return json(
    res,
    201,
    snapshotPayload(stored.snapshotId, stored.snapshot, {
      missingIds: data.missingIds,
      totalBeforeLimit: data.totalBeforeLimit,
      truncated: data.truncated,
    }),
  )
}

async function resumeReview(
  res: ServerResponse,
  body: Record<string, unknown>,
  options: ApiOptions,
) {
  const emailIds = z.array(z.string().min(1)).safeParse(body.emailIds)
  if (!emailIds.success) throw new ApiHttpError(400, 'INVALID_RESUME', 'Ungültiger Checkpoint.')
  const filters = parseFilters(body.filters)
  if (options.forceDemo) {
    const wanted = new Set(emailIds.data)
    const details = (options.demoMessages ?? demoEmails).filter((email) => wanted.has(email.id))
    const missingIds = emailIds.data.filter((id) => !details.some((email) => email.id === id))
    const ordered = emailIds.data
      .map((id) => details.find((email) => email.id === id))
      .filter((email): email is ReviewEmail => Boolean(email))
    const stored = storeSnapshot({
      emails: summariesFor(ordered),
      filters,
      mailboxes: [
        { id: 'Inbox', name: 'Inbox', role: 'inbox' },
        { id: 'Spam', name: 'Spam', role: 'junk' },
      ],
      mode: 'demo',
      details: ordered,
    })
    return json(res, 201, snapshotPayload(stored.snapshotId, stored.snapshot, { missingIds }))
  }
  const token = options.fastmailToken?.trim()
  if (!token)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht konfiguriert.')
  const data = await resumeSnapshot(token, emailIds.data, filters)
  const stored = storeSnapshot({ ...data, mode: 'live' })
  return json(
    res,
    201,
    snapshotPayload(stored.snapshotId, stored.snapshot, {
      missingIds: data.missingIds,
      totalBeforeLimit: data.totalBeforeLimit,
    }),
  )
}

async function options(res: ServerResponse, apiOptions: ApiOptions) {
  const codex = apiOptions.forceDemo
    ? { configured: false, model: 'gpt-5.6-sol' }
    : (apiOptions.codexAuthStatus ?? codexAuthStatus)()
  if (apiOptions.forceDemo) {
    return json(res, 200, {
      codex,
      mode: 'demo',
      reviewedCount: apiOptions.reviewHistory?.count() ?? 0,
      mailboxes: [
        { id: 'Inbox', name: 'Inbox', role: 'inbox' },
        { id: 'Newsletter', name: 'Newsletter' },
        { id: 'Reisen', name: 'Reisen' },
        { id: 'Spam', name: 'Spam', role: 'junk' },
      ],
    })
  }
  const token = apiOptions.fastmailToken?.trim()
  if (!token)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht konfiguriert.')
  const result = await fetchReviewOptions(token)
  const retainedIds = apiOptions.reviewHistory?.retainedIds() ?? new Set<string>()
  if (retainedIds.size > 0 && apiOptions.reviewHistory) {
    const unreadIds = await fetchUnreadEmailIds(result.context, token, [...retainedIds])
    apiOptions.reviewHistory.retainOnly(unreadIds)
  }
  return json(res, 200, {
    codex,
    mode: 'live',
    mailboxes: result.mailboxes,
    reviewedCount: apiOptions.reviewHistory?.count() ?? 0,
  })
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

async function emailDetail(
  res: ServerResponse,
  snapshotId: string,
  emailId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  if (!snapshot.summaries.has(emailId))
    throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht nicht gefunden.')
  let email = snapshot.detailCache.get(emailId)
  if (!email) {
    const token = apiOptions.fastmailToken?.trim()
    if (!token || !snapshot.context)
      throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
    email = await fetchEmailDetail(snapshot.context, token, emailId, snapshot.mailboxes)
    snapshot.detailCache.set(emailId, email)
    registerResources(snapshot, email)
  }
  return json(res, 200, emailPayload(snapshot, email))
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

async function remoteImage(
  res: ServerResponse,
  url: URL,
  snapshotId: string,
  emailId: string,
  imageId: string,
) {
  const snapshot = getSnapshot(snapshotId)
  if (url.searchParams.get('token') !== snapshot.imageToken) {
    throw new ApiHttpError(403, 'INVALID_IMAGE_TOKEN', 'Ungültiger Bildzugriff.')
  }
  if (!snapshot.summaries.has(emailId))
    throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht nicht gefunden.')
  if (!snapshot.detailCache.has(emailId))
    throw new ApiHttpError(409, 'EMAIL_NOT_LOADED', 'Nachricht wurde noch nicht geladen.')
  const source = snapshot.remoteImageSources.get(`${emailId}/${imageId}`)
  if (!source) {
    throw new ApiHttpError(403, 'IMAGE_FORBIDDEN', 'Dieses Bild gehört nicht zur Nachricht.')
  }
  try {
    const image = await fetchRemoteImage(source)
    securityHeaders(res)
    res.statusCode = 200
    res.setHeader('Content-Type', image.contentType)
    res.setHeader('Content-Length', image.body.length)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.end(image.body)
  } catch (error) {
    if (error instanceof SafeHttpError) {
      throw new ApiHttpError(502, error.code, error.message, true)
    }
    throw error
  }
}

async function loadThread(snapshot: StoredSnapshot, threadId: string, apiOptions: ApiOptions) {
  const cached = snapshot.threadCache.get(threadId)
  if (cached) return cached
  if (snapshot.mode === 'demo') {
    const messages = demoEmails
      .filter((email) => email.threadId === threadId)
      .map((email) => ({ ...email, sentAt: null }))
    snapshot.threadCache.set(threadId, messages)
    return messages
  }
  const token = apiOptions.fastmailToken?.trim()
  if (!token || !snapshot.context)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
  const messages = await fetchThread(snapshot.context, token, threadId, snapshot.mailboxes)
  for (const email of messages) registerResources(snapshot, email)
  snapshot.threadCache.set(threadId, messages)
  return messages
}

async function loadIdentities(snapshot: StoredSnapshot, apiOptions: ApiOptions) {
  if (snapshot.identities) return snapshot.identities
  if (snapshot.mode === 'demo') {
    snapshot.identities = [
      {
        id: 'demo-identity',
        name: 'Alex',
        email: 'alex@example.com',
        textSignature: 'Viele Grüße\nAlex',
        htmlSignature: '<div>Viele Grüße<br>Alex</div>',
      },
    ]
    return snapshot.identities
  }
  const token = apiOptions.fastmailToken?.trim()
  if (!token || !snapshot.context)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
  snapshot.identities = await fetchIdentities(snapshot.context, token)
  return snapshot.identities
}

async function threadContext(
  res: ServerResponse,
  snapshotId: string,
  threadId: string,
  emailId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  if (!snapshot.summaries.has(emailId))
    throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht nicht gefunden.')
  const messages = await loadThread(snapshot, threadId, apiOptions)
  const target = messages.find((message) => message.id === emailId)
  if (!target)
    throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht gehört nicht zu diesem Thread.')
  const identities = await loadIdentities(snapshot, apiOptions)
  const replyTarget = messages.at(-1)
  if (!replyTarget)
    throw new ApiHttpError(409, 'THREAD_EMPTY', 'Der Thread enthält keine Nachricht.')
  return json(res, 200, {
    messages,
    identities,
    recipients: computeReplyRecipients(replyTarget, identities),
    attachmentManifest: uniqueResources(messages),
  })
}

async function bundles(
  req: IncomingMessage,
  res: ServerResponse,
  snapshotId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  requireCsrf(req, snapshot)
  await readJson(req)
  if (snapshot.bundleRun) return json(res, 200, snapshot.bundleRun)
  if (!snapshot.bundleWork) {
    const emails = snapshot.emailIds
      .map((id) => snapshot.summaries.get(id))
      .filter((email): email is ReviewEmailSummary => Boolean(email))
    snapshot.bundleWork = (async () => {
      try {
        const auth =
          snapshot.mode === 'demo'
            ? { configured: false }
            : (apiOptions.codexAuthStatus ?? codexAuthStatus)()
        const decide =
          apiOptions.bundleDecider ??
          (snapshot.mode === 'live' && auth.configured ? runCodexBundleDecision : undefined)
        return await buildReviewBundles(
          snapshotId,
          emails,
          decide,
          apiOptions.bundleStore?.examples() ?? [],
        )
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'bundle_fallback',
            message: error instanceof Error ? error.message : 'unknown',
          })}\n`,
        )
        return singletonBundleRun(snapshotId, emails)
      }
    })()
  }
  try {
    snapshot.bundleRun = await snapshot.bundleWork
    return json(res, 200, snapshot.bundleRun)
  } finally {
    snapshot.bundleWork = undefined
  }
}

async function bundleLabel(
  req: IncomingMessage,
  res: ServerResponse,
  snapshotId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  requireCsrf(req, snapshot)
  const body = await readJson(req, MAX_SELECTION_JSON_BYTES)
  const parsed = z
    .object({
      anchorEmailIds: z.array(z.string().min(1)).min(1),
      candidateEmailIds: z.array(z.string().min(1)).min(1),
      label: z.enum(['merge', 'split']),
      reason: z.string().max(2_000).default('Vom Nutzer im Review bestätigt.'),
    })
    .safeParse(body)
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_BUNDLE_LABEL', 'Ungültige Korrektur.')
  const known = new Set(snapshot.emailIds)
  const ids = [...parsed.data.anchorEmailIds, ...parsed.data.candidateEmailIds]
  if (ids.some((id) => !known.has(id))) {
    throw new ApiHttpError(400, 'UNKNOWN_EMAIL', 'Die Korrektur enthält eine unbekannte Nachricht.')
  }
  const summaries = (wanted: readonly string[]) =>
    wanted
      .map((id) => snapshot.summaries.get(id))
      .filter((email): email is ReviewEmailSummary => Boolean(email))
  apiOptions.bundleStore?.record({
    anchorSignals: learningSignalsFor(summaries(parsed.data.anchorEmailIds)),
    candidateSignals: learningSignalsFor(summaries(parsed.data.candidateEmailIds)),
    label: parsed.data.label,
    reason: parsed.data.reason,
  })
  return json(res, 201, { recorded: Boolean(apiOptions.bundleStore) })
}

async function finalize(
  req: IncomingMessage,
  res: ServerResponse,
  snapshotId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  requireCsrf(req, snapshot)
  const body = await readJson(req, MAX_SELECTION_JSON_BYTES)
  const finalized = z.array(z.string().min(1)).min(1).safeParse(body.finalizeIds)
  const kept = z.array(z.string().min(1)).safeParse(body.keepUnreadIds)
  const secondaryAction = z
    .array(z.string().min(1))
    .safeParse(body.secondaryActionIds ?? body.unsubscribeIds ?? [])
  if (!finalized.success || !kept.success || !secondaryAction.success)
    throw new ApiHttpError(400, 'INVALID_SELECTION', 'Ungültige Auswahl.')
  if (snapshot.finalizationState === 'finalizing') {
    throw new ApiHttpError(
      409,
      'FINALIZE_IN_PROGRESS',
      'Der Review wird bereits abgeschlossen.',
      true,
    )
  }
  const known = new Set(snapshot.emailIds)
  if (finalized.data.some((id) => !known.has(id))) {
    throw new ApiHttpError(
      400,
      'UNKNOWN_EMAIL',
      'Die Abschlussauswahl enthält eine unbekannte Nachricht.',
    )
  }
  if (kept.data.some((id) => !known.has(id))) {
    throw new ApiHttpError(400, 'UNKNOWN_EMAIL', 'Die Auswahl enthält eine unbekannte Nachricht.')
  }
  if (secondaryAction.data.some((id) => !known.has(id))) {
    throw new ApiHttpError(
      400,
      'UNKNOWN_EMAIL',
      'Die Aktionsauswahl enthält eine unbekannte Nachricht.',
    )
  }
  if (
    snapshot.filters.spam === 'exclude' &&
    secondaryAction.data.some((id) => !snapshot.summaries.get(id)?.isNewsletter)
  ) {
    throw new ApiHttpError(
      400,
      'UNSUBSCRIBE_UNAVAILABLE',
      'Nur erkannte Newsletter können für eine spätere Abmeldung markiert werden.',
    )
  }
  const requestedFinalize = new Set(finalized.data)
  const requestedKeep = new Set(kept.data)
  const requestedSecondaryAction = new Set(secondaryAction.data)
  if ([...requestedKeep].some((id) => !requestedFinalize.has(id))) {
    throw new ApiHttpError(
      400,
      'INVALID_SELECTION',
      'Ungelesen geschützte Nachrichten müssen bereits bearbeitet sein.',
    )
  }
  if ([...requestedSecondaryAction].some((id) => !requestedFinalize.has(id))) {
    throw new ApiHttpError(
      400,
      'INVALID_SELECTION',
      'Zusatzaktionen müssen zu bereits bearbeiteten Nachrichten gehören.',
    )
  }
  if (snapshot.finalEmailIds) {
    const unchanged =
      requestedFinalize.size === snapshot.finalEmailIds.size &&
      [...requestedFinalize].every((id) => snapshot.finalEmailIds?.has(id))
    if (!unchanged)
      throw new ApiHttpError(
        409,
        'FINALIZE_SELECTION_LOCKED',
        'Die Abschlussauswahl ist bereits festgeschrieben.',
      )
  } else snapshot.finalEmailIds = requestedFinalize
  if (snapshot.finalKeepIds) {
    const unchanged =
      requestedKeep.size === snapshot.finalKeepIds.size &&
      [...requestedKeep].every((id) => snapshot.finalKeepIds?.has(id))
    if (!unchanged)
      throw new ApiHttpError(
        409,
        'FINALIZE_SELECTION_LOCKED',
        'Die Auswahl ist bereits festgeschrieben.',
      )
  } else snapshot.finalKeepIds = requestedKeep
  if (snapshot.finalSecondaryActionIds) {
    const unchanged =
      requestedSecondaryAction.size === snapshot.finalSecondaryActionIds.size &&
      [...requestedSecondaryAction].every((id) => snapshot.finalSecondaryActionIds?.has(id))
    if (!unchanged)
      throw new ApiHttpError(
        409,
        'FINALIZE_SELECTION_LOCKED',
        'Die Aktionsauswahl ist bereits festgeschrieben.',
      )
  } else snapshot.finalSecondaryActionIds = requestedSecondaryAction

  const toMark = [...requestedFinalize].filter(
    (id) => !requestedKeep.has(id) && !snapshot.succeededIds.has(id),
  )
  const untouched = snapshot.emailIds.length - requestedFinalize.size
  snapshot.finalizationState = 'finalizing'
  try {
    if (snapshot.mode === 'demo') {
      for (const id of toMark) snapshot.succeededIds.add(id)
      for (const id of requestedSecondaryAction) snapshot.secondaryActionSucceededIds.add(id)
      updateReviewHistory(apiOptions.reviewHistory, requestedKeep, [...snapshot.succeededIds])
      snapshot.finalizationState = 'finalized'
      const result: FinalizeResult = {
        actionFailed: [],
        failed: [],
        finalized: true,
        keptUnread: requestedKeep.size,
        markedRead: snapshot.succeededIds.size,
        mode: 'demo',
        processed: requestedFinalize.size,
        remaining: 0,
        rescuedFromSpam:
          snapshot.filters.spam === 'only' ? snapshot.secondaryActionSucceededIds.size : 0,
        taggedForUnsubscribe:
          snapshot.filters.spam === 'exclude' ? snapshot.secondaryActionSucceededIds.size : 0,
        untouched,
      }
      return json(res, 200, result)
    }
    const token = apiOptions.fastmailToken?.trim()
    if (!token || !snapshot.context)
      throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
    const pendingSecondaryActions = [...requestedSecondaryAction].filter(
      (id) => !snapshot.secondaryActionSucceededIds.has(id),
    )
    if (pendingSecondaryActions.length > 0) {
      const action =
        snapshot.filters.spam === 'only'
          ? await moveEmailsOutOfSpam(snapshot.context, token, pendingSecondaryActions)
          : await tagEmailsForLaterUnsubscribe(snapshot.context, token, pendingSecondaryActions)
      for (const id of action.succeededIds) {
        snapshot.secondaryActionSucceededIds.add(id)
        snapshot.secondaryActionFailures.delete(id)
      }
      for (const failure of action.failed) {
        snapshot.secondaryActionFailures.set(failure.id, failure.reason)
      }
    }
    const update = await markEmailsRead(snapshot.context, token, toMark)
    for (const id of update.markedIds) snapshot.succeededIds.add(id)
    updateReviewHistory(apiOptions.reviewHistory, requestedKeep, update.markedIds)
    const remainingRead = [...requestedFinalize].filter(
      (id) => !requestedKeep.has(id) && !snapshot.succeededIds.has(id),
    ).length
    const remainingActions = [...requestedSecondaryAction].filter(
      (id) => !snapshot.secondaryActionSucceededIds.has(id),
    ).length
    const remaining = remainingRead + remainingActions
    snapshot.finalizationState = remaining === 0 ? 'finalized' : 'active'
    const result: FinalizeResult = {
      actionFailed: [...snapshot.secondaryActionFailures].map(([id, reason]) => ({ id, reason })),
      failed: update.failed,
      finalized: remaining === 0,
      keptUnread: requestedKeep.size,
      markedRead: snapshot.succeededIds.size,
      mode: 'live',
      processed: requestedFinalize.size,
      remaining,
      rescuedFromSpam:
        snapshot.filters.spam === 'only' ? snapshot.secondaryActionSucceededIds.size : 0,
      taggedForUnsubscribe:
        snapshot.filters.spam === 'exclude' ? snapshot.secondaryActionSucceededIds.size : 0,
      untouched,
    }
    return json(res, remaining > 0 ? 207 : 200, result)
  } catch (error) {
    snapshot.finalizationState = 'active'
    throw error
  }
}

async function blob(
  res: ServerResponse,
  url: URL,
  snapshotId: string,
  blobId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  if (snapshot.mode !== 'live')
    throw new ApiHttpError(404, 'BLOB_NOT_FOUND', 'Datei nicht gefunden.')
  const resource = snapshot.blobMetadata.get(blobId)
  if (!resource) throw new ApiHttpError(403, 'BLOB_FORBIDDEN', 'Datei ist nicht freigegeben.')
  if (resource.size > MAX_DOWNLOAD_BYTES)
    throw new ApiHttpError(413, 'BLOB_TOO_LARGE', 'Datei ist größer als 100 MiB.')
  const token = apiOptions.fastmailToken?.trim()
  if (!token || !snapshot.context)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
  const upstream = await downloadBlob(snapshot.context, token, resource)
  if (!upstream.body)
    throw new ApiHttpError(502, 'EMPTY_BLOB', 'Fastmail hat keine Dateidaten geliefert.', true)
  const inline =
    url.searchParams.get('inline') === '1' && INLINE_TYPES.has(resource.type.toLowerCase())
  securityHeaders(res)
  res.statusCode = 200
  res.setHeader('Content-Type', inline ? resource.type : 'application/octet-stream')
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(resource.name.slice(0, 240))}`,
  )
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) res.setHeader('Content-Length', contentLength)
  try {
    await pipeline(Readable.fromWeb(upstream.body as never), res)
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
  snapshotId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  requireCsrf(req, snapshot)
  const body = await readJson(req)
  const parsed = z
    .object({
      emailId: z.string().min(1),
      requestId: z.string().uuid(),
      roughNotes: z.string().max(64_000),
      currentDraft: z.string().max(128_000).optional(),
      revisionInstruction: z.string().max(64_000).optional(),
    })
    .safeParse(body)
  if (!parsed.success)
    throw new ApiHttpError(400, 'INVALID_REPLY_REQUEST', 'Ungültige Entwurfsanfrage.')
  const { emailId, requestId } = parsed.data
  const summary = snapshot.summaries.get(emailId)
  if (!summary) throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht nicht gefunden.')
  const existing = snapshot.replyCache.get(requestId)
  if (existing) return json(res, 200, await existing)
  if (snapshot.replyInFlight.has(emailId)) {
    throw new ApiHttpError(
      409,
      'REPLY_IN_PROGRESS',
      'Für diese Nachricht wird bereits ein Entwurf erstellt.',
      true,
    )
  }
  snapshot.replyInFlight.add(emailId)
  const work = (async () => {
    const messages = await loadThread(snapshot, summary.threadId, apiOptions)
    if (snapshot.mode === 'demo') {
      const result: ReplyProposal = {
        attachmentManifest: uniqueResources(messages),
        bodyText:
          parsed.data.currentDraft?.trim() ||
          parsed.data.roughNotes.trim() ||
          'Danke für deine Nachricht. Ich melde mich dazu in Kürze noch einmal.',
        questions: [],
        requestId,
        supportedDetails: [],
        warnings: ['Demo-Modus: Es wurde keine Anfrage an Codex gesendet.'],
      }
      return result
    }
    const token = apiOptions.fastmailToken?.trim()
    if (!token || !snapshot.context)
      throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
    const auth = (apiOptions.codexAuthStatus ?? codexAuthStatus)()
    if (!auth.configured)
      throw new ApiHttpError(
        503,
        'CODEX_NOT_CONFIGURED',
        'Codex ist noch nicht mit dem ChatGPT-Abo angemeldet.',
      )
    const request: ReplyRequest = parsed.data
    return await generateReply(snapshot.context, token, messages, request)
  })()
  snapshot.replyCache.set(requestId, work)
  try {
    return json(res, 200, await work)
  } catch (error) {
    snapshot.replyCache.delete(requestId)
    throw error
  } finally {
    snapshot.replyInFlight.delete(emailId)
  }
}

async function draft(
  req: IncomingMessage,
  res: ServerResponse,
  snapshotId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  requireCsrf(req, snapshot)
  const body = await readJson(req)
  const parsed = z
    .object({
      requestId: z.string().uuid(),
      emailId: z.string().min(1),
      identityId: z.string().min(1),
      to: z.array(addressSchema).min(1).max(100),
      cc: z.array(addressSchema).max(100),
      subject: z.string().min(1).max(998),
      bodyText: z.string().min(1).max(256_000),
    })
    .safeParse(body)
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_DRAFT', 'Ungültige Draft-Daten.')
  const cached = snapshot.draftResults.get(parsed.data.requestId)
  if (cached) return json(res, 200, cached)
  const summary = snapshot.summaries.get(parsed.data.emailId)
  if (!summary) throw new ApiHttpError(404, 'EMAIL_NOT_FOUND', 'Nachricht nicht gefunden.')
  const messages = await loadThread(snapshot, summary.threadId, apiOptions)
  const identities = await loadIdentities(snapshot, apiOptions)
  const identity = identities.find((item) => item.id === parsed.data.identityId)
  if (!identity) throw new ApiHttpError(400, 'INVALID_IDENTITY', 'Unbekannte Absenderidentität.')
  const latest = messages.at(-1)
  if (!latest) throw new ApiHttpError(409, 'THREAD_EMPTY', 'Der Thread enthält keine Nachricht.')
  const bodyText = appendSignature(parsed.data.bodyText, identity)
  const htmlSignature = identity.htmlSignature.trim()
    ? identity.htmlSignature
    : escapeDraftHtml(identity.textSignature.trim())
  const bodyHtml = `${escapeDraftHtml(parsed.data.bodyText.trim())}${htmlSignature ? `<br><br>${htmlSignature}` : ''}`
  if (snapshot.mode === 'demo') {
    const result: DraftResult = {
      draftId: `demo-draft-${parsed.data.requestId}`,
      recovered: false,
      threadId: summary.threadId,
      verified: true,
    }
    snapshot.draftResults.set(parsed.data.requestId, result)
    return json(res, 201, result)
  }
  const token = apiOptions.fastmailToken?.trim()
  if (!token || !snapshot.context)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
  const references = [...new Set([...latest.references, ...latest.messageId])]
  const result = await createAndVerifyDraft(snapshot.context, token, {
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
  snapshot.draftResults.set(parsed.data.requestId, result)
  return json(res, 201, result)
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

function handleError(res: ServerResponse, error: unknown) {
  logApiError(error)
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy()
    return
  }
  if (error instanceof ApiHttpError) {
    return apiError(res, error.status, error.code, error.message, error.retryable, error.details)
  }
  if (error instanceof JmapError) {
    const status = error.status === 401 ? 401 : error.status === 404 ? 404 : 502
    return apiError(res, status, error.code, error.message, status >= 500)
  }
  if (error instanceof ReplyError) {
    return apiError(res, error.status, error.code, error.message, error.retryable, error.details)
  }
  return apiError(res, 500, 'INTERNAL_ERROR', 'Ein interner Fehler ist aufgetreten.', true)
}

export function createApiMiddleware(apiOptions: ApiOptions = {}) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next()
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      if (req.method === 'GET' && url.pathname === '/api/auth/codex/status') {
        return json(
          res,
          200,
          apiOptions.forceDemo
            ? { configured: false, model: 'gpt-5.6-sol' }
            : (apiOptions.codexAuthStatus ?? codexAuthStatus)(),
        )
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/codex/start') {
        validateOrigin(req)
        return await startCodexLogin(res, apiOptions)
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/codex/model') {
        validateOrigin(req)
        if (apiOptions.forceDemo)
          throw new ApiHttpError(403, 'DEMO_MODE', 'Das Codex-Modell ist im Demo-Modus fest.')
        const parsed = codexModelSchema.safeParse(await readJson(req))
        if (!parsed.success)
          throw new ApiHttpError(400, 'INVALID_CODEX_MODEL', 'Unbekanntes Codex-Modell.')
        return json(res, 200, (apiOptions.codexModelSelect ?? selectCodexModel)(parsed.data.model))
      }
      if (
        req.method === 'GET' &&
        parts[0] === 'api' &&
        parts[1] === 'auth' &&
        parts[2] === 'codex' &&
        parts[3]
      ) {
        return codexLoginState(res, parts[3])
      }
      if (req.method === 'GET' && url.pathname === '/api/review/options') {
        return await options(res, apiOptions)
      }
      if (req.method === 'POST' && url.pathname === '/api/reviews') {
        validateOrigin(req)
        return await createReview(res, await readJson(req), apiOptions)
      }
      if (req.method === 'POST' && url.pathname === '/api/reviews/resume') {
        validateOrigin(req)
        return await resumeReview(res, await readJson(req, MAX_SELECTION_JSON_BYTES), apiOptions)
      }
      if (parts[0] === 'api' && parts[1] === 'reviews' && parts[2]) {
        const snapshotId = parts[2]
        if (
          req.method === 'GET' &&
          parts[3] === 'emails' &&
          parts[4] &&
          parts[5] === 'images' &&
          parts[6]
        ) {
          return await remoteImage(res, url, snapshotId, parts[4], parts[6])
        }
        if (req.method === 'GET' && parts[3] === 'emails' && parts[4] && !parts[5]) {
          return await emailDetail(res, snapshotId, parts[4], apiOptions)
        }
        if (req.method === 'GET' && parts[3] === 'threads' && parts[4]) {
          return await threadContext(
            res,
            snapshotId,
            parts[4],
            url.searchParams.get('emailId') ?? '',
            apiOptions,
          )
        }
        if (req.method === 'GET' && parts[3] === 'blobs' && parts[4]) {
          return await blob(res, url, snapshotId, parts[4], apiOptions)
        }
        if (req.method === 'POST' && parts[3] === 'finalize') {
          return await finalize(req, res, snapshotId, apiOptions)
        }
        if (req.method === 'POST' && parts[3] === 'bundles') {
          return await bundles(req, res, snapshotId, apiOptions)
        }
        if (req.method === 'POST' && parts[3] === 'bundle-labels') {
          return await bundleLabel(req, res, snapshotId, apiOptions)
        }
        if (req.method === 'POST' && parts[3] === 'replies') {
          return await reply(req, res, snapshotId, apiOptions)
        }
        if (req.method === 'POST' && parts[3] === 'drafts') {
          return await draft(req, res, snapshotId, apiOptions)
        }
      }
      return apiError(res, 404, 'NOT_FOUND', 'Not found')
    } catch (error) {
      return handleError(res, error)
    }
  }
}

export function clearApiStateForTests() {
  snapshots.clear()
  for (const state of codexLogins.values()) state.controller.abort()
  codexLogins.clear()
}
