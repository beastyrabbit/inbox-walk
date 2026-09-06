import type {
  MailAddress,
  MailboxOption,
  MailIdentity,
  MailResource,
  ReviewEmail,
  ReviewEmailSummary,
  ReviewFilters,
  ThreadMessage,
} from '../src/shared.ts'
import { abortable, ioSignal, readBoundedBody } from './io.ts'

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'
const SUBMISSION = 'urn:ietf:params:jmap:submission'
const SESSION_URL = 'https://api.fastmail.com/jmap/session'
const EXCLUDED_MAILBOX_ROLES = new Set(['drafts', 'sent', 'trash'])
const QUERY_PAGE_SIZE = 250
const THREAD_LIMIT = 100

interface JmapSession {
  apiUrl: string
  downloadUrl: string
  primaryAccounts: Record<string, string>
  capabilities: Record<string, { maxObjectsInGet?: number; maxObjectsInSet?: number }>
  username?: string
}

interface Mailbox extends MailboxOption {
  myRights?: { mayAddItems?: boolean; mayReadItems?: boolean; maySetSeen?: boolean }
}

interface BodyPart {
  blobId?: string
  cid?: string
  disposition?: string | null
  name?: string | null
  partId?: string
  size?: number
  subParts?: BodyPart[]
  type: string
}

interface JmapMailAddress {
  email: string
  name?: string | null
}

interface JmapEmail {
  keywords?: Record<string, boolean>
  attachments?: BodyPart[]
  bodyStructure?: BodyPart
  bodyValues?: Record<string, { isTruncated?: boolean; value: string }>
  cc?: JmapMailAddress[] | null
  from?: JmapMailAddress[] | null
  hasAttachment?: boolean
  htmlBody?: BodyPart[]
  id: string
  inReplyTo?: string[] | null
  mailboxIds: Record<string, boolean>
  messageId?: string[] | null
  preview?: string
  receivedAt: string
  references?: string[] | null
  replyTo?: JmapMailAddress[] | null
  sentAt?: string | null
  subject?: string | null
  textBody?: BodyPart[]
  threadId: string
  to?: JmapMailAddress[] | null
  'header:List-Id:asText'?: string | null
  'header:List-Unsubscribe:asURLs'?: string[] | null
  'header:List-Unsubscribe-Post:asText'?: string | null
}

interface JmapIdentity extends MailIdentity {
  mayDelete?: boolean
}

interface MethodResponse<T> {
  accountId?: string
  created?: Record<string, T>
  ids?: string[]
  list?: T[]
  newState?: string
  notCreated?: Record<string, { description?: string; type: string }>
  notFound?: string[]
  notUpdated?: Record<string, { description?: string; type: string }>
  queryState?: string
  total?: number
  updated?: Record<string, null>
}

type ResponseTuple<T> = [string, MethodResponse<T>, string]

export interface MailAccountContext {
  accountId: string
  apiUrl: string
  downloadUrl: string
  maxObjectsInGet: number
  maxObjectsInSet: number
  username: string
}

export interface LiveSnapshotData {
  context: MailAccountContext
  emails: ReviewEmailSummary[]
  filters: ReviewFilters
  mailboxes: MailboxOption[]
  missingIds: string[]
  totalBeforeLimit: number
  truncated: boolean
}

export interface MarkReadResult {
  failed: Array<{ id: string; reason: string }>
  markedIds: string[]
}

export interface MailboxActionResult {
  failed: Array<{ id: string; reason: string }>
  succeededIds: string[]
}

export interface DraftInput {
  bodyHtml: string
  bodyText: string
  cc: MailAddress[]
  from: MailAddress
  inReplyTo: string[]
  references: string[]
  subject: string
  threadId: string
  to: MailAddress[]
}

export interface DraftCreateResult {
  draftId: string
  recovered: boolean
  threadId: string
  verified: boolean
}

export class JmapError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: { confirmedIds: string[]; unknownIds: string[]; unattemptedIds: string[] },
  ) {
    super(message)
  }
}

async function getSession(token: string, signal?: AbortSignal): Promise<JmapSession> {
  signal = ioSignal(30_000, signal)
  const response = await abortable(
    fetch(SESSION_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }),
    signal,
  )
  if (!response.ok) {
    const code = response.status === 401 ? 'FASTMAIL_AUTH_EXPIRED' : 'FASTMAIL_SESSION_FAILED'
    throw new JmapError(`Fastmail session failed (${response.status})`, code, response.status)
  }
  return JSON.parse(
    (await readBoundedBody(response, 32 * 1024 * 1024, signal)).toString('utf8'),
  ) as JmapSession
}

async function accountContext(token: string, signal?: AbortSignal): Promise<MailAccountContext> {
  const session = await getSession(token, signal)
  const accountId = session.primaryAccounts[MAIL]
  if (!accountId)
    throw new JmapError('Fastmail session has no primary mail account', 'NO_MAIL_ACCOUNT')
  return {
    accountId,
    apiUrl: session.apiUrl,
    downloadUrl: session.downloadUrl,
    maxObjectsInGet: Math.max(1, session.capabilities[CORE]?.maxObjectsInGet ?? 256),
    maxObjectsInSet: Math.max(1, session.capabilities[CORE]?.maxObjectsInSet ?? 256),
    username: session.username ?? '',
  }
}

async function callJmap<T>(
  apiUrl: string,
  token: string,
  methodCalls: unknown[][],
  includeSubmission = false,
  signal?: AbortSignal,
): Promise<ResponseTuple<T>[]> {
  signal = ioSignal(30_000, signal)
  if (methodCalls.some(([name]) => String(name).startsWith('EmailSubmission/'))) {
    throw new JmapError('Email submission is not supported by Inbox Walk', 'SUBMISSION_FORBIDDEN')
  }
  const response = await abortable(
    fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: includeSubmission ? [CORE, MAIL, SUBMISSION] : [CORE, MAIL],
        methodCalls,
      }),
      signal,
    }),
    signal,
  )
  if (!response.ok) {
    const code = response.status === 401 ? 'FASTMAIL_AUTH_EXPIRED' : 'FASTMAIL_REQUEST_FAILED'
    throw new JmapError(`Fastmail request failed (${response.status})`, code, response.status)
  }
  const payload = JSON.parse(
    (await readBoundedBody(response, 32 * 1024 * 1024, signal)).toString('utf8'),
  ) as { methodResponses?: ResponseTuple<T>[] }
  if (!payload.methodResponses)
    throw new JmapError('Fastmail returned no responses', 'INVALID_JMAP')
  const error = payload.methodResponses.find(([name]) => name === 'error')
  if (error) {
    const details = error[1] as { description?: string; type?: string }
    throw new JmapError(
      details.description ?? details.type ?? 'Unknown JMAP error',
      details.type ?? 'JMAP_ERROR',
    )
  }
  return payload.methodResponses
}

function responseFor<T>(responses: ResponseTuple<T>[], callId: string): MethodResponse<T> {
  const found = responses.find(([, , id]) => id === callId)
  if (!found) throw new JmapError(`Fastmail response ${callId} is missing`, 'INVALID_JMAP')
  return found[1]
}

export function unreadFilter(
  filters: ReviewFilters = {
    hideReviewed: false,
    mailboxId: null,
    newsletter: 'all',
    spam: 'exclude',
    timeRange: 'all',
  },
  junkMailboxId?: string,
) {
  const conditions: Array<Record<string, unknown>> = [
    { notKeyword: '$seen' },
    { notKeyword: '$draft' },
  ]
  if (filters.mailboxId) conditions.push({ inMailbox: filters.mailboxId })
  if (junkMailboxId) {
    conditions.push(
      filters.spam === 'only'
        ? { inMailbox: junkMailboxId }
        : { operator: 'NOT', conditions: [{ inMailbox: junkMailboxId }] },
    )
  }
  const duration =
    filters.timeRange === 'all' ? 0 : { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[filters.timeRange]
  if (duration)
    conditions.push({ after: new Date(Date.now() - duration * 3_600_000).toISOString() })
  return { operator: 'AND', conditions }
}

async function fetchMailboxes(
  context: MailAccountContext,
  token: string,
  signal?: AbortSignal,
): Promise<Mailbox[]> {
  const responses = await callJmap<Mailbox>(
    context.apiUrl,
    token,
    [
      [
        'Mailbox/get',
        { accountId: context.accountId, properties: ['id', 'name', 'role', 'myRights'] },
        'mailboxes',
      ],
    ],
    false,
    signal,
  )
  return responseFor(responses, 'mailboxes').list ?? []
}

function assignedMailboxes(email: JmapEmail, mailboxes: Map<string, Mailbox>) {
  return Object.keys(email.mailboxIds)
    .filter((id) => email.mailboxIds[id])
    .map((id) => mailboxes.get(id))
    .filter((mailbox): mailbox is Mailbox => Boolean(mailbox))
}

function isIncoming(email: JmapEmail, mailboxes: Map<string, Mailbox>) {
  const assigned = assignedMailboxes(email, mailboxes)
  return (
    assigned.length === 0 ||
    assigned.some((mailbox) => !mailbox.role || !EXCLUDED_MAILBOX_ROLES.has(mailbox.role))
  )
}

function isNewsletter(email: JmapEmail) {
  return Boolean(
    email['header:List-Id:asText']?.trim() || email['header:List-Unsubscribe:asURLs']?.length,
  )
}

function normalizeJmapAddresses(
  addresses: readonly JmapMailAddress[] | null | undefined,
): MailAddress[] {
  return (addresses ?? []).map((address) => ({
    email: address.email,
    name: address.name ?? '',
  }))
}

function summary(email: JmapEmail, mailboxes: Map<string, Mailbox>): ReviewEmailSummary {
  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject?.trim() || '(Kein Betreff)',
    receivedAt: email.receivedAt,
    from: normalizeJmapAddresses(email.from),
    to: normalizeJmapAddresses(email.to),
    preview: email.preview ?? '',
    mailboxNames: assignedMailboxes(email, mailboxes).map((mailbox) => mailbox.name),
    hasAttachment: Boolean(email.hasAttachment),
    isNewsletter: isNewsletter(email),
  }
}

const SUMMARY_PROPERTIES = [
  'id',
  'threadId',
  'mailboxIds',
  'receivedAt',
  'from',
  'to',
  'subject',
  'preview',
  'hasAttachment',
  'header:List-Id:asText',
  'header:List-Unsubscribe:asURLs',
]

const DETAIL_PROPERTIES = [
  ...SUMMARY_PROPERTIES,
  'cc',
  'replyTo',
  'messageId',
  'inReplyTo',
  'references',
  'sentAt',
  'htmlBody',
  'textBody',
  'bodyValues',
  'bodyStructure',
  'attachments',
]

async function getEmails(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
  detail: boolean,
  signal?: AbortSignal,
) {
  const list: JmapEmail[] = []
  const missing: string[] = []
  for (let start = 0; start < ids.length; start += context.maxObjectsInGet) {
    signal?.throwIfAborted()
    const responses = await callJmap<JmapEmail>(
      context.apiUrl,
      token,
      [
        [
          'Email/get',
          {
            accountId: context.accountId,
            ids: ids.slice(start, start + context.maxObjectsInGet),
            properties: detail ? DETAIL_PROPERTIES : SUMMARY_PROPERTIES,
            ...(detail
              ? {
                  bodyProperties: [
                    'partId',
                    'blobId',
                    'size',
                    'name',
                    'type',
                    'charset',
                    'disposition',
                    'cid',
                  ],
                  fetchHTMLBodyValues: true,
                  fetchTextBodyValues: true,
                  maxBodyValueBytes: 2_000_000,
                }
              : {}),
          },
          'emails',
        ],
      ],
      false,
      signal,
    )
    const result = responseFor(responses, 'emails')
    list.push(...(result.list ?? []))
    missing.push(...(result.notFound ?? []))
  }
  return { list, missing }
}

function newsletterMatches(email: ReviewEmailSummary, filter: ReviewFilters['newsletter']) {
  if (filter === 'all') return true
  return filter === 'only' ? email.isNewsletter : !email.isNewsletter
}

function spamMatches(
  email: JmapEmail,
  mailboxes: Map<string, Mailbox>,
  filter: ReviewFilters['spam'],
) {
  const isSpam = assignedMailboxes(email, mailboxes).some((mailbox) => mailbox.role === 'junk')
  return filter === 'only' ? isSpam : !isSpam
}

export async function fetchReviewOptions(token: string) {
  const context = await accountContext(token)
  const mailboxes = await fetchMailboxes(context, token)
  return {
    context,
    mailboxes: mailboxes
      .filter((mailbox) => mailbox.myRights?.mayReadItems !== false)
      .map(({ id, name, role }) => ({ id, name, role }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export async function fetchUnreadEmailIds(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
) {
  const unreadIds = new Set<string>()
  for (let start = 0; start < ids.length; start += context.maxObjectsInGet) {
    const responses = await callJmap<{ id: string; keywords?: Record<string, boolean> }>(
      context.apiUrl,
      token,
      [
        [
          'Email/get',
          {
            accountId: context.accountId,
            ids: ids.slice(start, start + context.maxObjectsInGet),
            properties: ['id', 'keywords'],
          },
          'history-emails',
        ],
      ],
    )
    for (const email of responseFor(responses, 'history-emails').list ?? []) {
      if (email.keywords?.$seen !== true) unreadIds.add(email.id)
    }
  }
  return unreadIds
}

export async function fetchUnreadSnapshot(
  token: string,
  filters: ReviewFilters = {
    hideReviewed: false,
    mailboxId: null,
    newsletter: 'all',
    spam: 'exclude',
    timeRange: 'all',
  },
  retainedIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<LiveSnapshotData> {
  signal?.throwIfAborted()
  const context = await accountContext(token, signal)
  const mailboxList = await fetchMailboxes(context, token, signal)
  const mailboxes = new Map(mailboxList.map((mailbox) => [mailbox.id, mailbox]))
  const junkMailboxId = mailboxList.find((mailbox) => mailbox.role === 'junk')?.id
  if (filters.spam === 'only' && !junkMailboxId) {
    return {
      context,
      emails: [],
      filters,
      mailboxes: mailboxList.map(({ id, name, role }) => ({ id, name, role })),
      missingIds: [],
      totalBeforeLimit: 0,
      truncated: false,
    }
  }
  const queryArguments = {
    accountId: context.accountId,
    calculateTotal: true,
    filter: unreadFilter(filters, junkMailboxId),
    sort: [{ property: 'receivedAt', isAscending: false }],
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let position = 0
    let queryState: string | undefined
    let candidateTotal = 0
    let exhausted = false
    let changed = false
    const selected: ReviewEmailSummary[] = []
    const missingIds: string[] = []

    while (!exhausted) {
      signal?.throwIfAborted()
      const pageResponses = await callJmap<never>(
        context.apiUrl,
        token,
        [['Email/query', { ...queryArguments, position, limit: QUERY_PAGE_SIZE }, 'query']],
        false,
        signal,
      )
      const page = responseFor(pageResponses, 'query')
      if (queryState === undefined) queryState = page.queryState
      else if (page.queryState !== queryState) {
        changed = true
        break
      }
      const ids = page.ids ?? []
      candidateTotal = page.total ?? Math.max(candidateTotal, position + ids.length)
      if (ids.length === 0) {
        exhausted = true
        break
      }
      const fetched = await getEmails(context, token, ids, false, signal)
      missingIds.push(...fetched.missing)
      const byId = new Map(fetched.list.map((email) => [email.id, email]))
      selected.push(
        ...ids
          .map((id) => byId.get(id))
          .filter((email): email is JmapEmail => Boolean(email))
          .filter((email) => isIncoming(email, mailboxes))
          .filter((email) => spamMatches(email, mailboxes, filters.spam))
          .filter((email) => !filters.hideReviewed || !retainedIds.has(email.id))
          .map((email) => summary(email, mailboxes))
          .filter((email) => newsletterMatches(email, filters.newsletter)),
      )
      position += ids.length
      if (position >= candidateTotal) {
        exhausted = true
        break
      }
    }
    if (changed) continue
    signal?.throwIfAborted()
    const secondResponses = await callJmap<never>(
      context.apiUrl,
      token,
      [['Email/query', { ...queryArguments, position: 0, limit: 1 }, 'query-check']],
      false,
      signal,
    )
    const second = responseFor(secondResponses, 'query-check')
    if (queryState !== second.queryState) continue
    return {
      context,
      emails: selected,
      filters,
      mailboxes: mailboxList.map(({ id, name, role }) => ({ id, name, role })),
      missingIds,
      totalBeforeLimit: selected.length,
      truncated: false,
    }
  }
  throw new JmapError(
    'Das Postfach hat sich während des Ladens wiederholt verändert. Bitte erneut versuchen.',
    'SNAPSHOT_CHANGED',
  )
}

export async function resumeSnapshot(
  token: string,
  ids: readonly string[],
  filters: ReviewFilters,
) {
  const context = await accountContext(token)
  const mailboxList = await fetchMailboxes(context, token)
  const mailboxes = new Map(mailboxList.map((mailbox) => [mailbox.id, mailbox]))
  const fetched = await getEmails(context, token, ids, false)
  const byId = new Map(fetched.list.map((email) => [email.id, email]))
  const missingIds = [...fetched.missing]
  const emails: ReviewEmailSummary[] = []
  for (const id of ids) {
    const email = byId.get(id)
    if (!email || !isIncoming(email, mailboxes) || !spamMatches(email, mailboxes, filters.spam)) {
      if (!missingIds.includes(id)) missingIds.push(id)
      continue
    }
    emails.push(summary(email, mailboxes))
  }
  return {
    context,
    emails,
    filters,
    mailboxes: mailboxList.map(({ id, name, role }) => ({ id, name, role })),
    missingIds,
    totalBeforeLimit: ids.length,
    truncated: false,
  } satisfies LiveSnapshotData
}

function partValue(parts: BodyPart[] | undefined, values: JmapEmail['bodyValues']) {
  return (parts ?? [])
    .map((part) => (part.partId ? values?.[part.partId]?.value : ''))
    .filter(Boolean)
    .join('\n')
}

function toResource(part: BodyPart): MailResource | null {
  if (!part.blobId) return null
  return {
    blobId: part.blobId,
    cid: part.cid?.replace(/^<|>$/g, ''),
    disposition: part.disposition,
    name: part.name || 'attachment',
    type: part.type || 'application/octet-stream',
    size: part.size ?? 0,
  }
}

function uniqueResources(parts: BodyPart[]) {
  const resources = new Map<string, MailResource>()
  for (const part of parts) {
    const resource = toResource(part)
    if (resource) resources.set(resource.blobId, resource)
  }
  return [...resources.values()]
}

function detail(email: JmapEmail, mailboxes: Map<string, Mailbox>): ReviewEmail {
  const resources = uniqueResources(email.attachments ?? [])
  const bodyPartIds = [...(email.htmlBody ?? []), ...(email.textBody ?? [])]
    .map((part) => part.partId)
    .filter((partId): partId is string => Boolean(partId))
  return {
    ...summary(email, mailboxes),
    cc: normalizeJmapAddresses(email.cc),
    replyTo: normalizeJmapAddresses(email.replyTo),
    messageId: email.messageId ?? [],
    inReplyTo: email.inReplyTo ?? [],
    references: email.references ?? [],
    html: partValue(email.htmlBody, email.bodyValues) || null,
    text: partValue(email.textBody, email.bodyValues),
    bodyTruncated: bodyPartIds.some((partId) => email.bodyValues?.[partId]?.isTruncated),
    inlineResources: resources.filter((resource) => Boolean(resource.cid)),
    attachments: resources.filter((resource) => !resource.cid),
  }
}

export async function fetchEmailDetail(
  context: MailAccountContext,
  token: string,
  id: string,
  knownMailboxes?: MailboxOption[],
) {
  const mailboxList = knownMailboxes ?? (await fetchMailboxes(context, token))
  const mailboxes = new Map(mailboxList.map((mailbox) => [mailbox.id, mailbox as Mailbox]))
  const fetched = await getEmails(context, token, [id], true)
  const email = fetched.list[0]
  if (!email) throw new JmapError('Nachricht wurde nicht gefunden.', 'EMAIL_NOT_FOUND', 404)
  return detail(email, mailboxes)
}

export async function fetchThread(
  context: MailAccountContext,
  token: string,
  threadId: string,
  knownMailboxes?: MailboxOption[],
): Promise<ThreadMessage[]> {
  const responses = await callJmap<{ id: string; emailIds: string[] }>(context.apiUrl, token, [
    ['Thread/get', { accountId: context.accountId, ids: [threadId] }, 'thread'],
  ])
  const thread = responseFor(responses, 'thread').list?.[0]
  if (!thread) throw new JmapError('Thread wurde nicht gefunden.', 'THREAD_NOT_FOUND', 404)
  if (thread.emailIds.length > THREAD_LIMIT) {
    throw new JmapError(
      `Der Thread enthält mehr als ${THREAD_LIMIT} Nachrichten und kann nicht vollständig verarbeitet werden.`,
      'THREAD_TOO_LARGE',
    )
  }
  const mailboxList = knownMailboxes ?? (await fetchMailboxes(context, token))
  const mailboxes = new Map(mailboxList.map((mailbox) => [mailbox.id, mailbox as Mailbox]))
  const fetched = await getEmails(context, token, thread.emailIds, true)
  if (fetched.missing.length > 0) {
    throw new JmapError(
      'Mindestens eine Thread-Nachricht ist nicht mehr verfügbar.',
      'THREAD_INCOMPLETE',
    )
  }
  return fetched.list
    .map((email) => ({ ...detail(email, mailboxes), sentAt: email.sentAt ?? null }))
    .sort((a, b) => Date.parse(a.sentAt ?? a.receivedAt) - Date.parse(b.sentAt ?? b.receivedAt))
}

export async function fetchIdentities(context: MailAccountContext, token: string) {
  const responses = await callJmap<JmapIdentity>(
    context.apiUrl,
    token,
    [
      [
        'Identity/get',
        {
          accountId: context.accountId,
          properties: ['id', 'name', 'email', 'textSignature', 'htmlSignature'],
        },
        'identities',
      ],
    ],
    true,
  )
  return (responseFor(responses, 'identities').list ?? [])
    .filter(({ email }) => !email.trim().startsWith('*@'))
    .map(({ id, name, email, textSignature, htmlSignature }) => ({
      id,
      name: name ?? '',
      email,
      textSignature: textSignature ?? '',
      htmlSignature: htmlSignature ?? '',
    }))
}

export async function markEmailsRead(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
  onProgress?: (result: MarkReadResult) => void,
): Promise<MarkReadResult> {
  const failed: MarkReadResult['failed'] = []
  const markedIds: string[] = []
  for (let start = 0; start < ids.length; start += context.maxObjectsInSet) {
    const batch = ids.slice(start, start + context.maxObjectsInSet)
    const update = Object.fromEntries(batch.map((id) => [id, { 'keywords/$seen': true }]))
    let responses: ResponseTuple<never>[]
    try {
      responses = await callJmap<never>(context.apiUrl, token, [
        ['Email/set', { accountId: context.accountId, update }, 'mark-read'],
      ])
    } catch (error) {
      const reconciled = await reconcileMutation(
        context,
        token,
        batch,
        (email) => email.keywords?.$seen === true,
        (confirmed) => {
          markedIds.push(...confirmed)
          onProgress?.({ failed: [...failed], markedIds: [...markedIds] })
        },
      )
      throw new JmapError(
        'Fastmail hat nicht alle Änderungen bestätigt. Bestätigte Änderungen bleiben gespeichert; prüfe unklare Ergebnisse vor einem erneuten Versuch.',
        error instanceof JmapError ? error.code : 'JMAP_MUTATION_UNCONFIRMED',
        error instanceof JmapError ? error.status : 502,
        {
          confirmedIds: [...markedIds],
          unknownIds: batch.filter((id) => !reconciled.includes(id)),
          unattemptedIds: ids.slice(start + batch.length),
        },
      )
    }
    const result = responseFor(responses, 'mark-read')
    const notUpdated = result.notUpdated ?? {}
    const updated = new Set(Object.keys(result.updated ?? {}))
    for (const id of batch) {
      if (updated.has(id)) markedIds.push(id)
      else if (notUpdated[id])
        failed.push({ id, reason: notUpdated[id].description ?? notUpdated[id].type })
      else failed.push({ id, reason: 'Fastmail hat die Änderung nicht bestätigt.' })
    }
    onProgress?.({ failed: [...failed], markedIds: [...markedIds] })
  }
  return { failed, markedIds }
}

function patchPathSegment(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

async function reconcileMutation(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
  matches: (email: JmapEmail) => boolean,
  onConfirmed: (ids: string[]) => void,
) {
  const confirmed = new Set<string>()
  for (let start = 0; start < ids.length; start += context.maxObjectsInGet) {
    const batch = ids.slice(start, start + context.maxObjectsInGet)
    let emails: JmapEmail[]
    try {
      const result = await callJmap<JmapEmail>(context.apiUrl, token, [
        [
          'Email/get',
          {
            accountId: context.accountId,
            ids: batch,
            properties: ['id', 'keywords', 'mailboxIds'],
          },
          'reconcile',
        ],
      ])
      emails = responseFor(result, 'reconcile').list ?? []
    } catch {
      // Preserve earlier confirmations; unreadable outcomes remain pending.
      break
    }
    const requested = new Set(batch)
    const newlyConfirmed: string[] = []
    for (const email of emails) {
      if (requested.has(email.id) && !confirmed.has(email.id) && matches(email)) {
        confirmed.add(email.id)
        newlyConfirmed.push(email.id)
      }
    }
    // Persistence failures must propagate, rather than being treated as failed reads.
    if (newlyConfirmed.length) onConfirmed(newlyConfirmed)
  }
  return [...confirmed]
}

async function updateMailboxMembership(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
  patch: Record<string, boolean | null>,
  callId: string,
  onProgress?: (result: MailboxActionResult) => void,
): Promise<MailboxActionResult> {
  const failed: MailboxActionResult['failed'] = []
  const succeededIds: string[] = []
  for (let start = 0; start < ids.length; start += context.maxObjectsInSet) {
    const batch = ids.slice(start, start + context.maxObjectsInSet)
    const update = Object.fromEntries(batch.map((id) => [id, patch]))
    let responses: ResponseTuple<never>[]
    try {
      responses = await callJmap<never>(context.apiUrl, token, [
        ['Email/set', { accountId: context.accountId, update }, callId],
      ])
    } catch (error) {
      const reconciled = await reconcileMutation(
        context,
        token,
        batch,
        (email) =>
          Object.entries(patch).every(([key, value]) => {
            const mailboxId = key
              .slice('mailboxIds/'.length)
              .replaceAll('~1', '/')
              .replaceAll('~0', '~')
            return value === true
              ? email.mailboxIds[mailboxId] === true
              : !email.mailboxIds[mailboxId]
          }),
        (confirmed) => {
          succeededIds.push(...confirmed)
          onProgress?.({ failed: [...failed], succeededIds: [...succeededIds] })
        },
      )
      throw new JmapError(
        'Fastmail hat nicht alle Postfachänderungen bestätigt. Bestätigte Änderungen bleiben gespeichert; prüfe unklare Ergebnisse vor einem erneuten Versuch.',
        error instanceof JmapError ? error.code : 'JMAP_MUTATION_UNCONFIRMED',
        error instanceof JmapError ? error.status : 502,
        {
          confirmedIds: [...succeededIds],
          unknownIds: batch.filter((id) => !reconciled.includes(id)),
          unattemptedIds: ids.slice(start + batch.length),
        },
      )
    }
    const result = responseFor(responses, callId)
    const notUpdated = result.notUpdated ?? {}
    const updated = new Set(Object.keys(result.updated ?? {}))
    for (const id of batch) {
      if (updated.has(id)) succeededIds.push(id)
      else if (notUpdated[id])
        failed.push({ id, reason: notUpdated[id].description ?? notUpdated[id].type })
      else failed.push({ id, reason: 'Fastmail hat die Änderung nicht bestätigt.' })
    }
    onProgress?.({ failed: [...failed], succeededIds: [...succeededIds] })
  }
  return { failed, succeededIds }
}

export async function moveEmailsOutOfSpam(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
  onProgress?: (result: MailboxActionResult) => void,
): Promise<MailboxActionResult> {
  if (ids.length === 0) return { failed: [], succeededIds: [] }
  const mailboxes = await fetchMailboxes(context, token)
  const junk = mailboxes.find((mailbox) => mailbox.role === 'junk')
  const inbox = mailboxes.find((mailbox) => mailbox.role === 'inbox')
  if (!junk || !inbox) {
    throw new JmapError(
      'Fastmail stellt kein Spam- oder Inbox-Postfach bereit.',
      'MAILBOX_ROLE_MISSING',
    )
  }
  return updateMailboxMembership(
    context,
    token,
    ids,
    {
      [`mailboxIds/${patchPathSegment(junk.id)}`]: null,
      [`mailboxIds/${patchPathSegment(inbox.id)}`]: true,
    },
    'not-spam',
    onProgress,
  )
}

const DEFERRED_UNSUBSCRIBE_MAILBOX = 'Newsletter abmelden'

async function deferredUnsubscribeMailboxId(context: MailAccountContext, token: string) {
  const mailboxes = await fetchMailboxes(context, token)
  const existing = mailboxes.find(
    (mailbox) =>
      mailbox.name.trim().toLocaleLowerCase('de-DE') ===
      DEFERRED_UNSUBSCRIBE_MAILBOX.toLocaleLowerCase('de-DE'),
  )
  if (existing) return existing.id
  const responses = await callJmap<Mailbox>(context.apiUrl, token, [
    [
      'Mailbox/set',
      {
        accountId: context.accountId,
        create: {
          deferredUnsubscribe: {
            name: DEFERRED_UNSUBSCRIBE_MAILBOX,
            parentId: null,
            isSubscribed: true,
          },
        },
      },
      'create-unsubscribe-mailbox',
    ],
  ])
  const result = responseFor(responses, 'create-unsubscribe-mailbox')
  const created = result.created?.deferredUnsubscribe
  if (created?.id) return created.id
  const failure = result.notCreated?.deferredUnsubscribe
  throw new JmapError(
    failure?.description ?? failure?.type ?? 'Fastmail konnte das Abmelde-Label nicht anlegen.',
    'UNSUBSCRIBE_MAILBOX_CREATE_FAILED',
  )
}

export async function tagEmailsForLaterUnsubscribe(
  context: MailAccountContext,
  token: string,
  ids: readonly string[],
  onProgress?: (result: MailboxActionResult) => void,
): Promise<MailboxActionResult> {
  if (ids.length === 0) return { failed: [], succeededIds: [] }
  const mailboxId = await deferredUnsubscribeMailboxId(context, token)
  return updateMailboxMembership(
    context,
    token,
    ids,
    { [`mailboxIds/${patchPathSegment(mailboxId)}`]: true },
    'tag-unsubscribe',
    onProgress,
  )
}

function downloadUrl(context: MailAccountContext, blobId: string, name: string, type: string) {
  const encoded = (value: string) => encodeURIComponent(value)
  return context.downloadUrl
    .replace('{accountId}', encoded(context.accountId))
    .replace('{blobId}', encoded(blobId))
    .replace('{type}', encoded(type))
    .replace('{name}', encoded(name))
    .replace('{/name}', `/${encoded(name)}`)
}

export async function downloadBlob(
  context: MailAccountContext,
  token: string,
  resource: MailResource,
  signal?: AbortSignal,
) {
  signal = ioSignal(120_000, signal)
  const response = await abortable(
    fetch(downloadUrl(context, resource.blobId, resource.name, resource.type), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }),
    signal,
  )
  if (!response.ok) {
    throw new JmapError(
      `Fastmail download failed (${response.status})`,
      'BLOB_DOWNLOAD_FAILED',
      response.status,
    )
  }
  return response
}

function normalizedAddresses(addresses: readonly { email: string }[]) {
  return addresses
    .map((address) => address.email.trim().toLowerCase())
    .sort()
    .join(',')
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, '\n').trim()
}

async function getDraftMailbox(context: MailAccountContext, token: string) {
  const mailboxes = await fetchMailboxes(context, token)
  const drafts = mailboxes.find((mailbox) => mailbox.role === 'drafts')
  if (!drafts)
    throw new JmapError('Fastmail hat keinen Drafts-Ordner gemeldet.', 'NO_DRAFTS_MAILBOX')
  if (drafts.myRights?.mayAddItems === false) {
    throw new JmapError(
      'Im Drafts-Ordner dürfen keine Nachrichten erstellt werden.',
      'DRAFT_FORBIDDEN',
    )
  }
  return drafts.id
}

function matchesDraft(email: JmapEmail, input: DraftInput) {
  const text = partValue(email.textBody, email.bodyValues)
  return (
    email.threadId === input.threadId &&
    (email.subject?.trim() ?? '') === input.subject.trim() &&
    normalizedAddresses(email.from ?? []) === normalizedAddresses([input.from]) &&
    normalizedAddresses(email.to ?? []) === normalizedAddresses(input.to) &&
    normalizedAddresses(email.cc ?? []) === normalizedAddresses(input.cc) &&
    normalizeText(text) === normalizeText(input.bodyText)
  )
}

async function verifyDraft(
  context: MailAccountContext,
  token: string,
  draftId: string,
  input: DraftInput,
) {
  const fetched = await getEmails(context, token, [draftId], true)
  const email = fetched.list[0]
  return Boolean(email && matchesDraft(email, input))
}

async function recoverDraft(
  context: MailAccountContext,
  token: string,
  draftsMailboxId: string,
  input: DraftInput,
) {
  const responses = await callJmap<{ id: string; emailIds: string[] }>(context.apiUrl, token, [
    ['Thread/get', { accountId: context.accountId, ids: [input.threadId] }, 'draft-thread'],
  ])
  const thread = responseFor(responses, 'draft-thread').list?.[0]
  if (!thread) {
    throw new JmapError('Der Thread für den Draft wurde nicht gefunden.', 'THREAD_NOT_FOUND', 404)
  }
  if (thread.emailIds.length > THREAD_LIMIT) {
    throw new JmapError(
      `Der Thread enthält mehr als ${THREAD_LIMIT} Nachrichten. Die Draft-Prüfung wurde sicher abgebrochen.`,
      'THREAD_TOO_LARGE',
    )
  }
  const fetched = await getEmails(context, token, thread.emailIds, true)
  if (fetched.missing.length > 0) {
    throw new JmapError(
      'Der Thread hat sich während der Draft-Prüfung geändert. Bitte versuche es erneut.',
      'DRAFT_PREFLIGHT_INCOMPLETE',
    )
  }
  return fetched.list.find(
    (email) => email.mailboxIds[draftsMailboxId] === true && matchesDraft(email, input),
  )
}

export async function createAndVerifyDraft(
  context: MailAccountContext,
  token: string,
  input: DraftInput,
): Promise<DraftCreateResult> {
  const draftsMailboxId = await getDraftMailbox(context, token)
  const existing = await recoverDraft(context, token, draftsMailboxId, input)
  if (existing) {
    return {
      draftId: existing.id,
      recovered: true,
      threadId: existing.threadId,
      verified: true,
    }
  }
  const createId = 'draft'
  const draft = {
    mailboxIds: { [draftsMailboxId]: true },
    keywords: { $seen: true, $draft: true },
    from: [input.from],
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    receivedAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    inReplyTo: input.inReplyTo,
    references: input.references,
    bodyStructure: {
      type: 'multipart/alternative',
      subParts: [
        { partId: 'text', type: 'text/plain' },
        { partId: 'html', type: 'text/html' },
      ],
    },
    bodyValues: {
      text: { value: input.bodyText, isTruncated: false },
      html: { value: input.bodyHtml, isTruncated: false },
    },
  }
  try {
    const responses = await callJmap<{ id: string; threadId: string }>(context.apiUrl, token, [
      ['Email/set', { accountId: context.accountId, create: { [createId]: draft } }, 'draft'],
    ])
    const result = responseFor(responses, 'draft')
    const error = result.notCreated?.[createId]
    if (error) throw new JmapError(error.description ?? error.type, error.type)
    const created = result.created?.[createId]
    if (!created) throw new JmapError('Fastmail hat den Draft nicht bestätigt.', 'DRAFT_AMBIGUOUS')
    const verified = await verifyDraft(context, token, created.id, input)
    if (!verified)
      throw new JmapError(
        'Der erstellte Draft stimmt nicht mit der Vorschau überein.',
        'DRAFT_MISMATCH',
      )
    return { draftId: created.id, recovered: false, threadId: created.threadId, verified }
  } catch (error) {
    if (
      error instanceof JmapError &&
      !['FASTMAIL_REQUEST_FAILED', 'DRAFT_AMBIGUOUS', 'DRAFT_MISMATCH'].includes(error.code)
    ) {
      throw error
    }
    const recovered = await recoverDraft(context, token, draftsMailboxId, input)
    if (recovered) {
      return {
        draftId: recovered.id,
        recovered: true,
        threadId: recovered.threadId,
        verified: true,
      }
    }
    throw new JmapError(
      'Fastmail hat die Erstellung nicht eindeutig bestätigt. Der Text bleibt erhalten; vor einem erneuten Versuch bitte Drafts prüfen.',
      'DRAFT_AMBIGUOUS',
    )
  }
}

export const jmapCapabilities = { CORE, MAIL, SUBMISSION }
