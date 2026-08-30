import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
  ReviewAnalysisState,
  ReviewBundleRun,
  ReviewEmail,
  ReviewEmailSummary,
  ReviewFilters,
  ReviewFinalizationState,
  ReviewRoundUserState,
  ReviewSnapshot,
  ThreadMessage,
} from '../src/shared.ts'
import { defaultReviewFilters, isCodexModelId } from '../src/shared.ts'
import { createCheckpointedBundleDecider } from './bundle-checkpoint.ts'
import type { BundleStore } from './bundle-store.ts'
import {
  type BundleBuildProgress,
  type BundleExample,
  buildReviewBundles,
  type DecideBundle,
  learningSignalsFor,
  singletonBundleRun,
  validateBundlePartition,
} from './bundles.ts'
import {
  CodexAuthenticationError,
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
import {
  cleanBundleExamples,
  type RoundFinalizationUpdate,
  RoundNotFoundError,
  RoundRevisionConflictError,
  type RoundStore,
  type StoredReviewRound,
} from './round-store.ts'
import { fetchRemoteImage, SafeHttpError } from './safe-http.ts'

const MAX_JSON_BYTES = 256 * 1024
const MAX_SELECTION_JSON_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOTS = 20
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_PRUNE_INTERVAL_MS = 60 * 1000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const INLINE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const REVIEW_CONFIRMED_BUNDLE_REASON = 'Vom Nutzer im Review bestätigt.'

const filtersSchema = z.object({
  hideReviewed: z.boolean().default(false),
  mailboxId: z.string().min(1).nullable(),
  newsletter: z.enum(['all', 'exclude', 'only']),
  spam: z.enum(['exclude', 'only']).default('exclude'),
  timeRange: z.enum(['all', '24h', '7d', '30d']),
})

const codexModelSchema = z.object({ model: z.custom<CodexModelId>(isCodexModelId) })

const addressSchema = z.object({ name: z.string().max(320), email: z.string().email().max(320) })

const replyEditorSchema = z.object({
  bodyText: z.string().max(256_000),
  cc: z.array(addressSchema).max(100),
  draftRequestId: z.string().uuid().optional(),
  identityId: z.string().max(512),
  revisionInstruction: z.string().max(64_000),
  roughNotes: z.string().max(64_000),
  subject: z.string().max(998),
  to: z.array(addressSchema).max(100),
})

interface StoredSnapshot {
  analysis: ReviewAnalysisState
  blobMetadata: Map<string, MailResource>
  bundleCallLimit: number
  bundleExamples: BundleExample[]
  bundleRun?: ReviewBundleRun
  context?: MailAccountContext
  createdAt: number
  csrfToken: string
  detailCache: Map<string, ReviewEmail>
  draftRequestFingerprints: Map<string, string>
  draftResults: Map<string, DraftResult>
  draftWork: Map<string, Promise<DraftResult>>
  emailIds: string[]
  filters: ReviewFilters
  finalEmailIds?: Set<string>
  finalKeepIds?: Set<string>
  finalSecondaryActionIds?: Set<string>
  finalizationState: 'active' | 'finalized' | 'finalizing'
  finalizationResult: FinalizeResult | null
  identities?: MailIdentity[]
  imageToken: string
  lastAccessedAt: number
  mailboxes: MailboxOption[]
  missingIds: string[]
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
  totalBeforeLimit: number
  truncated: boolean
  userState: ReviewRoundUserState
}

export interface ApiOptions {
  autoStartBundles?: boolean
  bundleCallLimit?: number
  bundleDecider?: DecideBundle
  bundleStore?: Pick<BundleStore, 'examples' | 'record'>
  codexAuthStatus?: () => CodexAuthStatus
  codexAuthStorage?: () => Pick<ReturnType<typeof getCodexAuthStorage>, 'login'>
  codexModelSelect?: (model: CodexModelId) => CodexAuthStatus
  demoMessages?: ReviewEmail[]
  fastmailToken?: string
  forceDemo?: boolean
  markRead?: typeof markEmailsRead
  moveOutOfSpam?: typeof moveEmailsOutOfSpam
  reviewHistory?: ReviewHistory
  resumeMailSnapshot?: typeof resumeSnapshot
  roundStore?: RoundStore
  tagForLaterUnsubscribe?: typeof tagEmailsForLaterUnsubscribe
}

const snapshots = new Map<string, StoredSnapshot>()
const bundleJobs = new Map<string, Promise<void>>()
interface CodexLoginRecord extends CodexLoginState {
  controller: AbortController
  createdAt: number
}
const codexLogins = new Map<string, CodexLoginRecord>()

function autoStartBundles(options: ApiOptions) {
  return options.autoStartBundles ?? !process.env.VITEST
}

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
    if (
      snapshot.lastAccessedAt < cutoff &&
      !bundleJobs.has(id) &&
      snapshot.finalizationState !== 'finalizing'
    )
      snapshots.delete(id)
  }
  if (snapshots.size <= MAX_SNAPSHOTS) return
  const oldest = [...snapshots.entries()].sort(
    ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt,
  )
  let remaining = snapshots.size - MAX_SNAPSHOTS
  for (const [id] of oldest) {
    if (remaining <= 0) break
    const snapshot = snapshots.get(id)
    if (bundleJobs.has(id) || snapshot?.finalizationState === 'finalizing') continue
    snapshots.delete(id)
    remaining -= 1
  }
}

const snapshotPruneTimer = setInterval(pruneSnapshots, SNAPSHOT_PRUNE_INTERVAL_MS)
snapshotPruneTimer.unref()

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

function initialAnalysis(
  mode: 'demo' | 'live',
  totalEmailCount: number,
  options: ApiOptions,
): ReviewAnalysisState {
  const auth =
    mode === 'live' ? (options.codexAuthStatus ?? codexAuthStatus)() : { configured: false }
  const usesCodex = Boolean(options.bundleDecider) || (mode === 'live' && auth.configured)
  return {
    callCount: 0,
    engine: usesCodex ? 'codex' : 'heuristic',
    ...(usesCodex && 'model' in auth && auth.model ? { model: auth.model } : {}),
    phase: 'waiting',
    processedEmailCount: 0,
    progress: 0,
    status: 'pending',
    totalEmailCount,
  }
}

function bundleExamplesForNewRound(options: ApiOptions) {
  try {
    return cleanBundleExamples(options.bundleStore?.examples() ?? [])
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'bundle_examples_snapshot_failed',
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`,
    )
    return []
  }
}

function storeSnapshot(
  data: Pick<LiveSnapshotData, 'emails' | 'filters' | 'mailboxes'> & {
    analysis: ReviewAnalysisState
    bundleCallLimit: number
    bundleExamples: BundleExample[]
    context?: MailAccountContext
    mode: 'demo' | 'live'
    details?: ReviewEmail[]
    missingIds?: string[]
    totalBeforeLimit?: number
    truncated?: boolean
  },
) {
  pruneSnapshots()
  const snapshotId = randomUUID()
  const csrfToken = randomBytes(24).toString('base64url')
  const imageToken = randomBytes(24).toString('base64url')
  const details = new Map((data.details ?? []).map((email) => [email.id, email]))
  const snapshot: StoredSnapshot = {
    analysis: data.analysis,
    blobMetadata: new Map(),
    bundleCallLimit: data.bundleCallLimit,
    bundleExamples: data.bundleExamples,
    context: data.context,
    createdAt: Date.now(),
    csrfToken,
    detailCache: details,
    draftRequestFingerprints: new Map(),
    draftResults: new Map(),
    draftWork: new Map(),
    emailIds: data.emails.map((email) => email.id),
    filters: data.filters,
    finalizationState: 'active',
    finalizationResult: null,
    imageToken,
    lastAccessedAt: Date.now(),
    mailboxes: data.mailboxes,
    missingIds: data.missingIds ?? [],
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
    totalBeforeLimit: data.totalBeforeLimit ?? data.emails.length,
    truncated: data.truncated ?? false,
    userState: {
      bundleGroups: [],
      index: 0,
      keptUnreadIds: [],
      processedIds: [],
      replyDrafts: {},
      revision: 0,
      secondaryActionIds: [],
      selectedMemberId: null,
    },
  }
  for (const email of details.values()) registerResources(snapshot, email)
  snapshots.set(snapshotId, snapshot)
  return { snapshotId, csrfToken, snapshot }
}

function persistNewRound(
  id: string,
  snapshot: StoredSnapshot,
  roundStore: RoundStore | undefined,
  metadata: { missingIds?: string[]; totalBeforeLimit?: number; truncated?: boolean } = {},
) {
  roundStore?.create({
    analysis: snapshot.analysis,
    bundleCallLimit: snapshot.bundleCallLimit,
    bundleExamples: snapshot.bundleExamples,
    csrfToken: snapshot.csrfToken,
    emails: snapshot.emailIds
      .map((emailId) => snapshot.summaries.get(emailId))
      .filter((email): email is ReviewEmailSummary => Boolean(email)),
    filters: snapshot.filters,
    id,
    imageToken: snapshot.imageToken,
    mailboxes: snapshot.mailboxes,
    missingIds: metadata.missingIds ?? snapshot.missingIds,
    mode: snapshot.mode,
    totalBeforeLimit: metadata.totalBeforeLimit ?? snapshot.totalBeforeLimit,
    truncated: metadata.truncated ?? snapshot.truncated,
  })
}

function storedSnapshot(round: StoredReviewRound, details: ReviewEmail[]) {
  const detailCache = new Map(details.map((email) => [email.id, email]))
  const hasFinalizationSelection =
    round.finalization.state !== 'active' ||
    round.finalization.finalizeIds.length > 0 ||
    round.finalization.keepUnreadIds.length > 0 ||
    round.finalization.secondaryActionIds.length > 0
  const snapshot: StoredSnapshot = {
    analysis: {
      callCount: round.analysis.callCount,
      engine: round.analysis.engine,
      ...(round.analysis.error ? { error: round.analysis.error } : {}),
      ...(round.analysis.model ? { model: round.analysis.model } : {}),
      phase: round.analysis.phase,
      processedEmailCount: round.analysis.processedEmailCount,
      progress: round.analysis.progress,
      status: round.analysis.status,
      totalEmailCount: round.analysis.totalEmailCount,
    },
    blobMetadata: new Map(),
    bundleCallLimit: round.bundleCallLimit,
    bundleExamples: round.bundleExamples,
    ...(round.bundleRun ? { bundleRun: round.bundleRun } : {}),
    createdAt: Date.parse(round.createdAt),
    csrfToken: round.csrfToken,
    detailCache,
    draftRequestFingerprints: new Map(),
    draftResults: new Map(),
    draftWork: new Map(),
    emailIds: round.emails.map((email) => email.id),
    filters: round.filters,
    finalEmailIds: hasFinalizationSelection ? new Set(round.finalization.finalizeIds) : undefined,
    finalKeepIds: hasFinalizationSelection ? new Set(round.finalization.keepUnreadIds) : undefined,
    finalSecondaryActionIds: hasFinalizationSelection
      ? new Set(round.finalization.secondaryActionIds)
      : undefined,
    finalizationResult: round.finalization.result,
    finalizationState:
      round.finalization.state === 'finalizing' ? 'active' : round.finalization.state,
    imageToken: round.imageToken,
    lastAccessedAt: Date.now(),
    mailboxes: round.mailboxes,
    missingIds: round.missingIds,
    mode: round.mode,
    replyCache: new Map(),
    replyInFlight: new Set(),
    remoteImageIds: new Map(),
    remoteImageSources: new Map(),
    secondaryActionFailures: new Map(
      round.finalization.actionFailed.map((failure) => [failure.id, failure.reason]),
    ),
    secondaryActionSucceededIds: new Set(round.finalization.secondaryActionSucceededIds),
    succeededIds: new Set(round.finalization.succeededIds),
    summaries: new Map(round.emails.map((email) => [email.id, email])),
    threadCache: new Map(),
    totalBeforeLimit: round.totalBeforeLimit,
    truncated: round.truncated,
    userState: round.userState,
  }
  for (const email of details) registerResources(snapshot, email)
  return snapshot
}

async function ensureSnapshot(id: string, apiOptions: ApiOptions) {
  const existing = snapshots.get(id)
  if (existing) {
    existing.lastAccessedAt = Date.now()
    return
  }
  const round = apiOptions.roundStore?.get(id)
  if (!round) return
  let details: ReviewEmail[] = []
  if (round.mode === 'demo') {
    const byId = new Map((apiOptions.demoMessages ?? demoEmails).map((email) => [email.id, email]))
    details = round.emails
      .map((email) => byId.get(email.id))
      .filter((email): email is ReviewEmail => Boolean(email))
  }
  if (round.analysis.status === 'running') {
    round.analysis.status = 'pending'
    round.analysis.phase = 'waiting'
    apiOptions.roundStore?.updateAnalysis(id, { phase: 'waiting', status: 'pending' })
  }
  if (round.finalization.state === 'finalizing') {
    apiOptions.roundStore?.saveFinalization(id, { state: 'active' })
  }
  const snapshot = storedSnapshot(round, details)
  snapshots.set(id, snapshot)
  if (snapshot.analysis.status !== 'complete' && autoStartBundles(apiOptions)) {
    startBundleJob(id, snapshot, apiOptions)
  }
}

async function ensureMailContext(snapshot: StoredSnapshot, apiOptions: ApiOptions) {
  if (snapshot.mode === 'demo' || snapshot.context) return
  const token = apiOptions.fastmailToken?.trim()
  if (!token)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
  const resumed = await (apiOptions.resumeMailSnapshot ?? resumeSnapshot)(
    token,
    snapshot.emailIds,
    snapshot.filters,
  )
  snapshot.context = resumed.context
  snapshot.mailboxes = resumed.mailboxes
}

function snapshotPayload(
  id: string,
  snapshot: StoredSnapshot,
  metadata: { missingIds?: string[]; totalBeforeLimit?: number; truncated?: boolean } = {},
): ReviewSnapshot {
  const userState: ReviewRoundUserState = snapshot.finalEmailIds
    ? {
        ...snapshot.userState,
        keptUnreadIds: [...(snapshot.finalKeepIds ?? [])],
        processedIds: [...snapshot.finalEmailIds],
        secondaryActionIds: [...(snapshot.finalSecondaryActionIds ?? [])],
      }
    : snapshot.userState
  return {
    analysis: snapshot.analysis,
    ...(snapshot.bundleRun ? { bundleRun: snapshot.bundleRun } : {}),
    csrfToken: snapshot.csrfToken,
    imageToken: snapshot.imageToken,
    emails: snapshot.emailIds
      .map((emailId) => snapshot.summaries.get(emailId))
      .filter((email): email is ReviewEmailSummary => Boolean(email)),
    filters: snapshot.filters,
    finalization: {
      result: snapshot.finalizationResult,
      selectionLocked: Boolean(snapshot.finalEmailIds),
      status: snapshot.finalizationState,
    } satisfies ReviewFinalizationState,
    missingIds: metadata.missingIds ?? snapshot.missingIds,
    mode: snapshot.mode,
    snapshotId: id,
    totalBeforeLimit: metadata.totalBeforeLimit ?? snapshot.totalBeforeLimit,
    truncated: metadata.truncated ?? snapshot.truncated,
    userState,
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

function requireMutableRoundState(snapshot: StoredSnapshot) {
  if (snapshot.finalizationState === 'active' && !snapshot.finalEmailIds) return
  throw new ApiHttpError(
    409,
    snapshot.finalizationState === 'finalized'
      ? 'ROUND_FINALIZED'
      : snapshot.finalEmailIds
        ? 'FINALIZE_SELECTION_LOCKED'
        : 'FINALIZE_IN_PROGRESS',
    snapshot.finalizationState === 'finalized'
      ? 'Diese Runde ist bereits abgeschlossen.'
      : snapshot.finalEmailIds
        ? 'Die Abschlussauswahl ist bereits festgeschrieben.'
        : 'Der Review wird bereits abgeschlossen.',
  )
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
      analysis: initialAnalysis('demo', emails.length, options),
      bundleCallLimit: codexBundleCallLimit(options.bundleCallLimit),
      bundleExamples: bundleExamplesForNewRound(options),
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
    persistNewRound(stored.snapshotId, stored.snapshot, options.roundStore)
    if (autoStartBundles(options)) startBundleJob(stored.snapshotId, stored.snapshot, options)
    return json(res, 201, snapshotPayload(stored.snapshotId, stored.snapshot))
  }
  const token = options.fastmailToken?.trim()
  if (!token)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht konfiguriert.')
  const data = await fetchUnreadSnapshot(token, filters, retainedIds)
  const stored = storeSnapshot({
    ...data,
    analysis: initialAnalysis('live', data.emails.length, options),
    bundleCallLimit: codexBundleCallLimit(options.bundleCallLimit),
    bundleExamples: bundleExamplesForNewRound(options),
    mode: 'live',
  })
  persistNewRound(stored.snapshotId, stored.snapshot, options.roundStore, {
    missingIds: data.missingIds,
    totalBeforeLimit: data.totalBeforeLimit,
    truncated: data.truncated,
  })
  if (autoStartBundles(options)) startBundleJob(stored.snapshotId, stored.snapshot, options)
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
      analysis: initialAnalysis('demo', ordered.length, options),
      bundleCallLimit: codexBundleCallLimit(options.bundleCallLimit),
      bundleExamples: bundleExamplesForNewRound(options),
      emails: summariesFor(ordered),
      filters,
      mailboxes: [
        { id: 'Inbox', name: 'Inbox', role: 'inbox' },
        { id: 'Spam', name: 'Spam', role: 'junk' },
      ],
      mode: 'demo',
      details: ordered,
      missingIds,
      totalBeforeLimit: emailIds.data.length,
    })
    persistNewRound(stored.snapshotId, stored.snapshot, options.roundStore, { missingIds })
    if (autoStartBundles(options)) startBundleJob(stored.snapshotId, stored.snapshot, options)
    return json(res, 201, snapshotPayload(stored.snapshotId, stored.snapshot, { missingIds }))
  }
  const token = options.fastmailToken?.trim()
  if (!token)
    throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht konfiguriert.')
  const data = await resumeSnapshot(token, emailIds.data, filters)
  const stored = storeSnapshot({
    ...data,
    analysis: initialAnalysis('live', data.emails.length, options),
    bundleCallLimit: codexBundleCallLimit(options.bundleCallLimit),
    bundleExamples: bundleExamplesForNewRound(options),
    mode: 'live',
  })
  persistNewRound(stored.snapshotId, stored.snapshot, options.roundStore, {
    missingIds: data.missingIds,
    totalBeforeLimit: data.totalBeforeLimit,
    truncated: data.truncated,
  })
  if (autoStartBundles(options)) startBundleJob(stored.snapshotId, stored.snapshot, options)
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
    await ensureMailContext(snapshot, apiOptions)
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

async function loadThread(snapshot: StoredSnapshot, threadId: string, apiOptions: ApiOptions) {
  const cached = snapshot.threadCache.get(threadId)
  if (cached) return cached
  if (snapshot.mode === 'demo') {
    const messages = (apiOptions.demoMessages ?? demoEmails)
      .filter((email) => email.threadId === threadId)
      .map((email) => ({ ...email, sentAt: null }))
    snapshot.threadCache.set(threadId, messages)
    return messages
  }
  await ensureMailContext(snapshot, apiOptions)
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
  await ensureMailContext(snapshot, apiOptions)
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

function publicBundleFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/call budget exhausted/i.test(message)) {
    return 'Das Codex-Aufruflimit dieser Runde wurde erreicht. Die Nachrichten werden sicher einzeln angezeigt.'
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return 'Codex hat nicht rechtzeitig geantwortet. Die Nachrichten werden einzeln angezeigt.'
  }
  if (/network|fetch|connect|econn|dns/i.test(message)) {
    return 'Codex war nicht erreichbar. Die Nachrichten werden einzeln angezeigt.'
  }
  return 'Die Zusammenhänge konnten nicht sicher bestimmt werden. Die Nachrichten werden einzeln angezeigt.'
}

export function codexBundleCallLimit(override: number | undefined) {
  const raw = override ?? process.env.CODEX_BUNDLE_MAX_CALLS
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return 64
  const configured = Number(raw)
  return Number.isFinite(configured) ? Math.min(512, Math.max(1, Math.floor(configured))) : 64
}

function persistAnalysisUpdate(event: string, action: () => unknown) {
  try {
    const result = action()
    if (result === null || result === false) throw new Error('The round store rejected the update.')
    return true
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event,
        message: error instanceof Error ? error.message : 'unknown',
      })}\n`,
    )
    return false
  }
}

function markAnalysisPersistenceFailure(snapshot: StoredSnapshot) {
  snapshot.analysis = {
    ...snapshot.analysis,
    error:
      'Das Analyseergebnis konnte nicht dauerhaft gespeichert werden. Lass diese Ansicht geöffnet und prüfe den App-Speicher.',
  }
}

function persistFinalizationOrThrow(
  store: RoundStore | undefined,
  roundId: string,
  update: RoundFinalizationUpdate,
) {
  if (!store) return
  try {
    const saved = store.saveFinalization(roundId, update)
    if (!saved) throw new Error('The review round disappeared before finalization.')
  } catch {
    throw new ApiHttpError(
      503,
      'ROUND_PERSIST_FAILED',
      'Der Abschluss konnte nicht dauerhaft gespeichert werden. Bitte versuche dieselbe Auswahl erneut.',
      true,
    )
  }
}

function applyBundleProgress(
  snapshotId: string,
  snapshot: StoredSnapshot,
  progress: BundleBuildProgress,
  roundStore: RoundStore | undefined,
) {
  snapshot.analysis = {
    callCount: progress.codexCallCount,
    engine: progress.engine,
    ...(progress.model ? { model: progress.model } : {}),
    phase: progress.phase,
    processedEmailCount: progress.processedEmailCount,
    progress: progress.progress,
    status: 'running',
    totalEmailCount: progress.totalEmailCount,
    ...(snapshot.analysis.error ? { error: snapshot.analysis.error } : {}),
  }
  if (roundStore) {
    persistAnalysisUpdate('bundle_progress_persist_failed', () =>
      roundStore.updateAnalysis(snapshotId, snapshot.analysis),
    )
  }
}

function startBundleJob(snapshotId: string, snapshot: StoredSnapshot, apiOptions: ApiOptions) {
  if (snapshot.bundleRun || bundleJobs.has(snapshotId)) return
  const emails = snapshot.emailIds
    .map((id) => snapshot.summaries.get(id))
    .filter((email): email is ReviewEmailSummary => Boolean(email))
  const auth =
    snapshot.mode === 'demo'
      ? { configured: false as const }
      : (apiOptions.codexAuthStatus ?? codexAuthStatus)()
  const mustResumeWithCodex =
    snapshot.mode === 'live' && snapshot.analysis.engine === 'codex' && !apiOptions.bundleDecider
  if (mustResumeWithCodex && !auth.configured) {
    snapshot.analysis = {
      ...snapshot.analysis,
      error: 'Codex muss erneut verbunden werden, bevor diese Analyse fortgesetzt werden kann.',
      phase: 'waiting_for_codex',
      status: 'pending',
    }
    if (apiOptions.roundStore) {
      persistAnalysisUpdate('bundle_waiting_for_codex_persist_failed', () =>
        apiOptions.roundStore?.updateAnalysis(snapshotId, snapshot.analysis),
      )
    }
    return
  }
  const configuredModel = 'model' in auth ? auth.model : undefined
  const persistedModel = snapshot.analysis.model
  const frozenModel = isCodexModelId(persistedModel) ? persistedModel : configuredModel
  const providerDecide =
    apiOptions.bundleDecider ??
    (snapshot.mode === 'live' && snapshot.analysis.engine === 'codex' && auth.configured
      ? (input: Parameters<typeof runCodexBundleDecision>[0]) =>
          runCodexBundleDecision(input, frozenModel ?? auth.model)
      : undefined)
  const checkpointed =
    providerDecide && apiOptions.roundStore
      ? createCheckpointedBundleDecider({
          decide: providerDecide,
          initialCallCount: snapshot.analysis.callCount,
          maxCallCount: snapshot.bundleCallLimit,
          ...(frozenModel ? { model: frozenModel } : {}),
          onCallStarted: (callCount) => {
            snapshot.analysis = { ...snapshot.analysis, callCount }
            const updated = apiOptions.roundStore?.updateAnalysis(snapshotId, snapshot.analysis)
            if (!updated) throw new Error('The review round disappeared before a Codex decision.')
          },
          onCallRolledBack: (callCount) => {
            snapshot.analysis = { ...snapshot.analysis, callCount }
            const updated = apiOptions.roundStore?.updateAnalysis(snapshotId, snapshot.analysis)
            if (!updated) throw new Error('The review round disappeared after Codex auth failed.')
          },
          roundId: snapshotId,
          shouldRollbackCall: (error) => error instanceof CodexAuthenticationError,
          store: apiOptions.roundStore,
        })
      : undefined
  const decide = checkpointed?.decide ?? providerDecide
  const codexCallCount = () => checkpointed?.callCount() ?? snapshot.analysis.callCount
  const engine = decide ? ('codex' as const) : ('heuristic' as const)
  const model = frozenModel
  const { error: _previousAnalysisError, ...previousAnalysis } = snapshot.analysis
  snapshot.analysis = {
    ...previousAnalysis,
    engine,
    ...(model ? { model } : {}),
    phase: 'indexing',
    status: 'running',
  }
  if (apiOptions.roundStore) {
    const persisted = persistAnalysisUpdate('bundle_start_persist_failed', () =>
      apiOptions.roundStore?.updateAnalysis(snapshotId, { ...snapshot.analysis, error: null }),
    )
    if (!persisted) {
      snapshot.analysis = {
        ...snapshot.analysis,
        error: 'Die Analyse konnte nicht sicher gestartet werden. Prüfe den App-Speicher.',
        phase: 'waiting',
        status: 'pending',
      }
      return
    }
  }
  const work = (async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      const run = await buildReviewBundles(snapshotId, emails, decide, snapshot.bundleExamples, {
        codexCallCount: codexCallCount(),
        engine,
        ...(checkpointed ? { getCodexCallCount: checkpointed.callCount } : {}),
        ...(model ? { model } : {}),
        onProgress: (progress) =>
          applyBundleProgress(snapshotId, snapshot, progress, apiOptions.roundStore),
      })
      snapshot.bundleRun = run
      snapshot.analysis = {
        ...snapshot.analysis,
        engine:
          engine === 'codex' && snapshot.analysis.callCount === 0
            ? 'heuristic'
            : snapshot.analysis.engine,
        phase: 'complete',
        progress: 1,
        status: 'complete',
      }
      if (apiOptions.roundStore) {
        const persisted = persistAnalysisUpdate('bundle_result_persist_failed', () =>
          apiOptions.roundStore?.saveBundleRun(snapshotId, run, {
            ...snapshot.analysis,
            error: null,
          }),
        )
        if (!persisted) markAnalysisPersistenceFailure(snapshot)
      }
    } catch (error) {
      if (
        error instanceof CodexAuthenticationError &&
        engine === 'codex' &&
        snapshot.mode === 'live'
      ) {
        snapshot.bundleRun = undefined
        snapshot.analysis = {
          ...snapshot.analysis,
          callCount: codexCallCount(),
          engine: 'codex',
          error: 'Codex muss erneut verbunden werden, bevor diese Analyse fortgesetzt werden kann.',
          phase: 'waiting_for_codex',
          status: 'pending',
        }
        if (apiOptions.roundStore) {
          const persisted = persistAnalysisUpdate('bundle_auth_wait_persist_failed', () =>
            apiOptions.roundStore?.updateAnalysis(snapshotId, snapshot.analysis),
          )
          if (!persisted) markAnalysisPersistenceFailure(snapshot)
        }
        return
      }
      process.stderr.write(
        `${JSON.stringify({
          event: 'bundle_fallback',
          message: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      )
      snapshot.analysis = { ...snapshot.analysis, error: publicBundleFailure(error) }
      snapshot.bundleRun = singletonBundleRun(snapshotId, emails, {
        codexCallCount: snapshot.analysis.callCount,
        ...(model ? { model } : {}),
        onProgress: (progress) =>
          applyBundleProgress(snapshotId, snapshot, progress, apiOptions.roundStore),
      })
      snapshot.analysis = {
        ...snapshot.analysis,
        phase: 'complete',
        progress: 1,
        status: 'complete',
      }
      if (apiOptions.roundStore) {
        const persisted = persistAnalysisUpdate('bundle_fallback_persist_failed', () =>
          apiOptions.roundStore?.saveBundleRun(
            snapshotId,
            snapshot.bundleRun as ReviewBundleRun,
            snapshot.analysis,
          ),
        )
        if (!persisted) markAnalysisPersistenceFailure(snapshot)
      }
    }
  })()
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({
          event: 'bundle_job_failed',
          message: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      )
      snapshot.analysis = {
        ...snapshot.analysis,
        engine: 'fallback',
        error: publicBundleFailure(error),
        phase: 'complete',
        progress: 1,
        status: 'complete',
      }
      snapshot.bundleRun = singletonBundleRun(snapshotId, emails)
      if (apiOptions.roundStore) {
        const persisted = persistAnalysisUpdate('bundle_emergency_fallback_persist_failed', () =>
          apiOptions.roundStore?.saveBundleRun(
            snapshotId,
            snapshot.bundleRun as ReviewBundleRun,
            snapshot.analysis,
          ),
        )
        if (!persisted) markAnalysisPersistenceFailure(snapshot)
      }
    })
    .finally(() => bundleJobs.delete(snapshotId))
  bundleJobs.set(snapshotId, work)
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
  startBundleJob(snapshotId, snapshot, apiOptions)
  return json(
    res,
    snapshot.analysis.status === 'complete' ? 200 : 202,
    snapshotPayload(snapshotId, snapshot),
  )
}

async function updateRoundState(
  req: IncomingMessage,
  res: ServerResponse,
  snapshotId: string,
  apiOptions: ApiOptions,
) {
  const snapshot = getSnapshot(snapshotId)
  requireCsrf(req, snapshot)
  requireMutableRoundState(snapshot)
  const body = await readJson(req, MAX_SELECTION_JSON_BYTES)
  const parsed = z
    .object({
      revision: z.number().int().nonnegative(),
      state: z.object({
        bundleGroups: z.array(z.array(z.string().min(1)).min(1)),
        index: z.number().int().nonnegative(),
        keptUnreadIds: z.array(z.string().min(1)),
        processedIds: z.array(z.string().min(1)),
        replyDrafts: z.record(z.string(), replyEditorSchema),
        secondaryActionIds: z.array(z.string().min(1)),
        selectedMemberId: z.string().min(1).nullable(),
      }),
    })
    .safeParse(body)
  if (!parsed.success) throw new ApiHttpError(400, 'INVALID_ROUND_STATE', 'Ungültiger Rundenstand.')
  if (!apiOptions.roundStore && parsed.data.revision !== snapshot.userState.revision) {
    throw new ApiHttpError(
      409,
      'ROUND_REVISION_CONFLICT',
      'Diese Runde wurde bereits in einem anderen Tab geändert. Bitte neu laden.',
    )
  }
  const known = new Set(snapshot.emailIds)
  const state = parsed.data.state
  const referencedIds = [
    ...state.keptUnreadIds,
    ...state.processedIds,
    ...state.secondaryActionIds,
    ...Object.keys(state.replyDrafts),
    ...(state.selectedMemberId ? [state.selectedMemberId] : []),
  ]
  if (referencedIds.some((id) => !known.has(id))) {
    throw new ApiHttpError(
      400,
      'UNKNOWN_EMAIL',
      'Der Rundenstand enthält eine unbekannte Nachricht.',
    )
  }
  for (const ids of [state.keptUnreadIds, state.processedIds, state.secondaryActionIds]) {
    if (new Set(ids).size !== ids.length) {
      throw new ApiHttpError(400, 'INVALID_ROUND_STATE', 'Der Rundenstand enthält doppelte IDs.')
    }
  }
  if (state.bundleGroups.length > 0) {
    try {
      validateBundlePartition(
        snapshot.emailIds,
        state.bundleGroups.map((emailIds) => ({ emailIds })),
      )
    } catch {
      throw new ApiHttpError(
        400,
        'INVALID_BUNDLE_GROUPS',
        'Die gespeicherten Storys bilden die Runde nicht vollständig ab.',
      )
    }
  }
  if (
    snapshot.filters.spam === 'exclude' &&
    state.secondaryActionIds.some((id) => !snapshot.summaries.get(id)?.isNewsletter)
  ) {
    throw new ApiHttpError(
      400,
      'UNSUBSCRIBE_UNAVAILABLE',
      'Nur erkannte Newsletter können für eine spätere Abmeldung markiert werden.',
    )
  }
  // The request body can arrive slowly while another tab finalizes the round.
  // Recheck immediately before the synchronous revision-guarded write.
  requireMutableRoundState(snapshot)
  if (apiOptions.roundStore) {
    try {
      snapshot.userState = apiOptions.roundStore.updateUserState(
        snapshotId,
        parsed.data.revision,
        state,
      ).userState
    } catch (error) {
      if (error instanceof RoundRevisionConflictError) {
        throw new ApiHttpError(
          409,
          'ROUND_REVISION_CONFLICT',
          'Diese Runde wurde bereits in einem anderen Tab geändert. Bitte neu laden.',
          false,
          { actualRevision: error.actualRevision },
        )
      }
      if (error instanceof RoundNotFoundError) {
        throw new ApiHttpError(404, 'ROUND_NOT_FOUND', 'Diese Runde wurde nicht gefunden.')
      }
      throw error
    }
  } else {
    snapshot.userState = {
      ...state,
      revision: snapshot.userState.revision + 1,
    }
  }
  return json(res, 200, snapshot.userState)
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
      reason: z.string().max(2_000).optional(),
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
    reason: REVIEW_CONFIRMED_BUNDLE_REASON,
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
  const revision = z.number().int().nonnegative().safeParse(body.revision)
  const finalized = z.array(z.string().min(1)).min(1).safeParse(body.finalizeIds)
  const kept = z.array(z.string().min(1)).safeParse(body.keepUnreadIds)
  const secondaryAction = z
    .array(z.string().min(1))
    .safeParse(body.secondaryActionIds ?? body.unsubscribeIds ?? [])
  if (!revision.success || !finalized.success || !kept.success || !secondaryAction.success)
    throw new ApiHttpError(400, 'INVALID_SELECTION', 'Ungültige Auswahl.')
  const requireCurrentRevision = () => {
    const actualRevision =
      apiOptions.roundStore?.get(snapshotId)?.userState.revision ?? snapshot.userState.revision
    if (revision.data !== actualRevision) {
      throw new ApiHttpError(
        409,
        'ROUND_REVISION_CONFLICT',
        'Diese Runde wurde bereits in einem anderen Tab geändert. Bitte neu laden.',
        false,
        { actualRevision },
      )
    }
  }
  const requireFinalizeAvailable = () => {
    if (snapshot.finalizationState === 'finalizing') {
      throw new ApiHttpError(
        409,
        'FINALIZE_IN_PROGRESS',
        'Der Review wird bereits abgeschlossen.',
        true,
      )
    }
  }
  requireCurrentRevision()
  requireFinalizeAvailable()
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
  let selectionWasLocked = Boolean(snapshot.finalEmailIds)
  const requireSameLockedSelection = () => {
    const same = (requested: ReadonlySet<string>, locked: ReadonlySet<string> | undefined) =>
      !locked || (requested.size === locked.size && [...requested].every((id) => locked.has(id)))
    if (!same(requestedFinalize, snapshot.finalEmailIds)) {
      throw new ApiHttpError(
        409,
        'FINALIZE_SELECTION_LOCKED',
        'Die Abschlussauswahl ist bereits festgeschrieben.',
      )
    }
    if (!same(requestedKeep, snapshot.finalKeepIds)) {
      throw new ApiHttpError(
        409,
        'FINALIZE_SELECTION_LOCKED',
        'Die Auswahl ist bereits festgeschrieben.',
      )
    }
    if (!same(requestedSecondaryAction, snapshot.finalSecondaryActionIds)) {
      throw new ApiHttpError(
        409,
        'FINALIZE_SELECTION_LOCKED',
        'Die Aktionsauswahl ist bereits festgeschrieben.',
      )
    }
  }
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
  requireSameLockedSelection()

  if (snapshot.mode === 'live') {
    await ensureMailContext(snapshot, apiOptions)
    const token = apiOptions.fastmailToken?.trim()
    if (!token || !snapshot.context)
      throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
  }
  // Loading the live mailbox context can yield long enough for another tab to save
  // a newer revision or lock a different final selection. Recheck immediately before
  // the synchronous durable lock, which then runs without another await.
  requireCurrentRevision()
  requireFinalizeAvailable()
  requireSameLockedSelection()
  selectionWasLocked ||= Boolean(snapshot.finalEmailIds)
  snapshot.finalEmailIds ??= requestedFinalize
  snapshot.finalKeepIds ??= requestedKeep
  snapshot.finalSecondaryActionIds ??= requestedSecondaryAction

  const toMark = [...requestedFinalize].filter(
    (id) => !requestedKeep.has(id) && !snapshot.succeededIds.has(id),
  )
  const untouched = snapshot.emailIds.length - requestedFinalize.size
  snapshot.finalizationState = 'finalizing'
  try {
    persistFinalizationOrThrow(apiOptions.roundStore, snapshotId, {
      actionFailed: [...snapshot.secondaryActionFailures].map(([id, reason]) => ({ id, reason })),
      finalizeIds: [...requestedFinalize],
      keepUnreadIds: [...requestedKeep],
      secondaryActionIds: [...requestedSecondaryAction],
      secondaryActionSucceededIds: [...snapshot.secondaryActionSucceededIds],
      state: 'finalizing',
      succeededIds: [...snapshot.succeededIds],
    })
  } catch (error) {
    snapshot.finalizationState = 'active'
    if (!selectionWasLocked) {
      snapshot.finalEmailIds = undefined
      snapshot.finalKeepIds = undefined
      snapshot.finalSecondaryActionIds = undefined
    }
    throw error
  }
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
      snapshot.finalizationResult = result
      persistFinalizationOrThrow(apiOptions.roundStore, snapshotId, {
        actionFailed: result.actionFailed,
        failed: result.failed,
        result,
        secondaryActionSucceededIds: [...snapshot.secondaryActionSucceededIds],
        state: 'finalized',
        succeededIds: [...snapshot.succeededIds],
      })
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
          ? await (apiOptions.moveOutOfSpam ?? moveEmailsOutOfSpam)(
              snapshot.context,
              token,
              pendingSecondaryActions,
            )
          : await (apiOptions.tagForLaterUnsubscribe ?? tagEmailsForLaterUnsubscribe)(
              snapshot.context,
              token,
              pendingSecondaryActions,
            )
      for (const id of action.succeededIds) {
        snapshot.secondaryActionSucceededIds.add(id)
        snapshot.secondaryActionFailures.delete(id)
      }
      for (const failure of action.failed) {
        snapshot.secondaryActionFailures.set(failure.id, failure.reason)
      }
    }
    const update = await (apiOptions.markRead ?? markEmailsRead)(snapshot.context, token, toMark)
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
    snapshot.finalizationResult = result
    persistFinalizationOrThrow(apiOptions.roundStore, snapshotId, {
      actionFailed: result.actionFailed,
      failed: result.failed,
      result,
      secondaryActionSucceededIds: [...snapshot.secondaryActionSucceededIds],
      state: snapshot.finalizationState,
      succeededIds: [...snapshot.succeededIds],
    })
    return json(res, remaining > 0 ? 207 : 200, result)
  } catch (error) {
    snapshot.finalizationState = 'active'
    if (apiOptions.roundStore) {
      persistAnalysisUpdate('finalization_rollback_persist_failed', () =>
        apiOptions.roundStore?.saveFinalization(snapshotId, {
          actionFailed: [...snapshot.secondaryActionFailures].map(([id, reason]) => ({
            id,
            reason,
          })),
          secondaryActionSucceededIds: [...snapshot.secondaryActionSucceededIds],
          state: 'active',
          succeededIds: [...snapshot.succeededIds],
        }),
      )
    }
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
  res.setHeader('Cache-Control', 'private, no-store')
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
  const { requestId, ...draftPayload } = parsed.data
  const fingerprint = createHash('sha256').update(JSON.stringify(draftPayload)).digest('hex')
  const existingFingerprint = snapshot.draftRequestFingerprints.get(requestId)
  if (existingFingerprint && existingFingerprint !== fingerprint) {
    throw new ApiHttpError(
      409,
      'DRAFT_REQUEST_CONFLICT',
      'Diese Draft-Anfrage wurde bereits mit anderem Inhalt verwendet. Bitte versuche es erneut.',
    )
  }
  snapshot.draftRequestFingerprints.set(requestId, fingerprint)
  const cached = snapshot.draftResults.get(parsed.data.requestId)
  if (cached) return json(res, 200, cached)
  const inFlight = snapshot.draftWork.get(parsed.data.requestId)
  if (inFlight) return json(res, 200, await inFlight)
  const work = (async (): Promise<DraftResult> => {
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
      return {
        draftId: `demo-draft-${parsed.data.requestId}`,
        recovered: false,
        threadId: summary.threadId,
        verified: true,
      }
    }
    const token = apiOptions.fastmailToken?.trim()
    if (!token || !snapshot.context)
      throw new ApiHttpError(503, 'FASTMAIL_NOT_CONFIGURED', 'Fastmail ist nicht verfügbar.')
    const references = [...new Set([...latest.references, ...latest.messageId])]
    return await createAndVerifyDraft(snapshot.context, token, {
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
  snapshot.draftWork.set(parsed.data.requestId, work)
  try {
    const result = await work
    snapshot.draftResults.set(parsed.data.requestId, result)
    return json(res, 201, result)
  } catch (error) {
    snapshot.draftRequestFingerprints.delete(requestId)
    throw error
  } finally {
    snapshot.draftWork.delete(parsed.data.requestId)
  }
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
        await ensureSnapshot(snapshotId, apiOptions)
        if (req.method === 'GET' && !parts[3]) {
          validateOrigin(req)
          const snapshot = getSnapshot(snapshotId)
          return json(res, 200, snapshotPayload(snapshotId, snapshot))
        }
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
        if (req.method === 'POST' && parts[3] === 'state') {
          return await updateRoundState(req, res, snapshotId, apiOptions)
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
  bundleJobs.clear()
  for (const state of codexLogins.values()) state.controller.abort()
  codexLogins.clear()
}

export async function waitForApiJobs() {
  await Promise.allSettled([...bundleJobs.values()])
}
