import type {
  ApiError,
  CodexAuthStatus,
  CodexLoginState,
  CodexModelId,
  DraftResult,
  FinalizeResult,
  MailAddress,
  ReplyProposal,
  ReviewEmail,
  ReviewFilters,
  ReviewOptions,
  ReviewRoundUserState,
  ReviewSnapshot,
  ThreadContext,
} from './shared.ts'

export class ClientApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: unknown,
    readonly status?: number,
  ) {
    super(message)
  }
}

const gatewayStatuses = new Set([502, 503, 504])

function gatewayError(status: number) {
  return new ClientApiError(
    'Der Server ist vorübergehend nicht erreichbar. Bitte versuche es gleich erneut.',
    'SERVICE_UNAVAILABLE',
    true,
    undefined,
    status,
  )
}

function invalidResponseError(status: number) {
  return new ClientApiError(
    'Der Server hat eine ungültige Antwort geliefert.',
    'INVALID_RESPONSE',
    status >= 500,
    undefined,
    status,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function apiErrorFrom(body: unknown): ApiError['error'] | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined
  const { code, details, message, retryable } = body.error
  if (typeof code !== 'string' || typeof message !== 'string' || typeof retryable !== 'boolean') {
    return undefined
  }
  return { code, message, retryable, ...(details === undefined ? {} : { details }) }
}

async function payload<T>(response: Response): Promise<T> {
  let rawBody: string
  try {
    rawBody = await response.text()
  } catch {
    throw new ClientApiError(
      'Die Verbindung zum Server wurde unterbrochen. Bitte versuche es erneut.',
      'NETWORK_ERROR',
      true,
      undefined,
      response.status,
    )
  }

  const trimmedBody = rawBody.trim()
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const shouldParseJson =
    contentType.includes('/json') ||
    contentType.includes('+json') ||
    trimmedBody.startsWith('{') ||
    trimmedBody.startsWith('[')

  if (!shouldParseJson) {
    if (gatewayStatuses.has(response.status)) throw gatewayError(response.status)
    if (!response.ok && response.status !== 207) {
      throw new ClientApiError(
        'Die Anfrage ist fehlgeschlagen.',
        'REQUEST_FAILED',
        response.status >= 500,
        undefined,
        response.status,
      )
    }
    throw invalidResponseError(response.status)
  }

  let body: unknown
  try {
    body = JSON.parse(trimmedBody)
  } catch {
    if (gatewayStatuses.has(response.status)) throw gatewayError(response.status)
    throw invalidResponseError(response.status)
  }

  if (!response.ok && response.status !== 207) {
    const error = apiErrorFrom(body)
    throw new ClientApiError(
      error?.message || 'Die Anfrage ist fehlgeschlagen.',
      error?.code || 'REQUEST_FAILED',
      error?.retryable ?? response.status >= 500,
      error?.details,
      response.status,
    )
  }
  return body as T
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new ClientApiError(
      'Der Server ist nicht erreichbar. Bitte überprüfe deine Verbindung und versuche es erneut.',
      'NETWORK_ERROR',
      true,
    )
  }
  return payload<T>(response)
}

async function post<T>(url: string, body: unknown, csrfToken?: string, persistOnUnload = false) {
  const serialized = JSON.stringify(body)
  const keepalive = persistOnUnload && new TextEncoder().encode(serialized).byteLength <= 60 * 1024
  return request<T>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-Inbox-Walk-CSRF': csrfToken } : {}),
    },
    body: serialized,
    keepalive,
  })
}

export const api = {
  async codexStatus() {
    return request<CodexAuthStatus>('/api/auth/codex/status')
  },
  async startCodexLogin() {
    return post<{ id: string }>('/api/auth/codex/start', {})
  },
  async selectCodexModel(model: CodexModelId) {
    return post<CodexAuthStatus>('/api/auth/codex/model', { model })
  },
  async codexLoginState(id: string) {
    return request<CodexLoginState>(`/api/auth/codex/${encodeURIComponent(id)}`)
  },
  async options() {
    return request<ReviewOptions>('/api/review/options')
  },
  async createReview(filters: ReviewFilters) {
    return post<ReviewSnapshot>('/api/reviews', { filters })
  },
  async review(roundId: string) {
    return request<ReviewSnapshot>(`/api/reviews/${encodeURIComponent(roundId)}`)
  },
  async resumeReview(emailIds: string[], filters: ReviewFilters) {
    return post<ReviewSnapshot>('/api/reviews/resume', { emailIds, filters })
  },
  async email(snapshotId: string, emailId: string) {
    return request<ReviewEmail>(
      `/api/reviews/${encodeURIComponent(snapshotId)}/emails/${encodeURIComponent(emailId)}`,
    )
  },
  async bundles(snapshot: Pick<ReviewSnapshot, 'csrfToken' | 'snapshotId'>) {
    return post<ReviewSnapshot>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/bundles`,
      {},
      snapshot.csrfToken,
    )
  },
  async continueWithoutCodex(snapshot: Pick<ReviewSnapshot, 'csrfToken' | 'snapshotId'>) {
    return post<ReviewSnapshot>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/bundles/fallback`,
      {},
      snapshot.csrfToken,
    )
  },
  async updateReviewState(
    snapshot: ReviewSnapshot,
    revision: number,
    state: Omit<ReviewRoundUserState, 'revision'>,
  ) {
    return post<ReviewRoundUserState>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/state`,
      { revision, state },
      snapshot.csrfToken,
      true,
    )
  },
  async bundleLabel(
    snapshot: ReviewSnapshot,
    body: {
      anchorEmailIds: string[]
      candidateEmailIds: string[]
      label: 'merge' | 'split'
      reason?: string
    },
  ) {
    return post<{ recorded: boolean }>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/bundle-labels`,
      body,
      snapshot.csrfToken,
    )
  },
  async thread(snapshotId: string, threadId: string, emailId: string) {
    const params = new URLSearchParams({ emailId })
    return request<ThreadContext>(
      `/api/reviews/${encodeURIComponent(snapshotId)}/threads/${encodeURIComponent(threadId)}?${params}`,
    )
  },
  async finalize(
    snapshot: ReviewSnapshot,
    revision: number,
    finalizeIds: string[],
    keepUnreadIds: string[],
    secondaryActionIds: string[],
  ) {
    return post<FinalizeResult>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/finalize`,
      { finalizeIds, keepUnreadIds, revision, secondaryActionIds },
      snapshot.csrfToken,
    )
  },
  async reply(
    snapshot: ReviewSnapshot,
    body: {
      currentDraft?: string
      emailId: string
      requestId: string
      revisionInstruction?: string
      roughNotes: string
    },
  ) {
    return post<ReplyProposal>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/replies`,
      body,
      snapshot.csrfToken,
    )
  },
  async draft(
    snapshot: ReviewSnapshot,
    body: {
      bodyText: string
      cc: MailAddress[]
      emailId: string
      identityId: string
      requestId: string
      subject: string
      to: MailAddress[]
    },
  ) {
    return post<DraftResult>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/drafts`,
      body,
      snapshot.csrfToken,
    )
  },
}

export function blobUrl(snapshotId: string, blobId: string, inline = false) {
  const suffix = inline ? '?inline=1' : ''
  return `/api/reviews/${encodeURIComponent(snapshotId)}/blobs/${encodeURIComponent(blobId)}${suffix}`
}

export function remoteImageUrl(
  snapshotId: string,
  emailId: string,
  imageId: string,
  imageToken: string,
) {
  const params = new URLSearchParams({ token: imageToken })
  return `/api/reviews/${encodeURIComponent(snapshotId)}/emails/${encodeURIComponent(emailId)}/images/${encodeURIComponent(imageId)}?${params}`
}
