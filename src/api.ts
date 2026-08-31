import type {
  ApiError,
  CodexAuthStatus,
  CodexLoginState,
  CodexModelId,
  CodexThinkingLevel,
  DraftResult,
  FinalizeResult,
  MailAddress,
  ReplyProposal,
  ReviewEmail,
  ReviewFilters,
  ReviewOptions,
  ReviewRoundUserState,
  ReviewRunSummary,
  ReviewSnapshot,
  ThreadContext,
} from './shared.ts'

export type CodexSettings = CodexAuthStatus

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
  if (response.status === 204 || response.status === 205) return undefined as T
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

async function put<T>(url: string, body: unknown) {
  return request<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function remove(url: string, csrfToken: string) {
  return request<void>(url, {
    method: 'DELETE',
    headers: { 'X-Inbox-Walk-CSRF': csrfToken },
  })
}

export const api = {
  async codexStatus() {
    return request<CodexAuthStatus>('/api/auth/codex/status')
  },
  async startCodexLogin() {
    return post<{ id: string }>('/api/auth/codex/start', {})
  },
  async codexSettings() {
    return request<CodexSettings>('/api/settings/codex')
  },
  async updateCodexSettings(model: CodexModelId, thinkingLevel: CodexThinkingLevel) {
    return put<CodexSettings>('/api/settings/codex', { model, thinkingLevel })
  },
  async codexLoginState(id: string) {
    return request<CodexLoginState>(`/api/auth/codex/${encodeURIComponent(id)}`)
  },
  async options() {
    return request<ReviewOptions>('/api/review/options')
  },
  async reviewRuns() {
    return request<{ runs: ReviewRunSummary[] }>('/api/reviews')
  },
  async createReview(id: string, filters: ReviewFilters) {
    return post<ReviewRunSummary>('/api/reviews', { id, filters }, undefined, true)
  },
  async resumeReview(id: string, emailIds: string[], filters: ReviewFilters) {
    return post<ReviewRunSummary>('/api/reviews/resume', { id, emailIds, filters })
  },
  async review(roundId: string) {
    return request<ReviewSnapshot>(`/api/reviews/${encodeURIComponent(roundId)}`)
  },
  async deleteReview(run: Pick<ReviewRunSummary, 'csrfToken' | 'id'>) {
    return remove(`/api/reviews/${encodeURIComponent(run.id)}`, run.csrfToken)
  },
  async reanalyzeReview(run: Pick<ReviewRunSummary, 'csrfToken' | 'id'>) {
    return post<ReviewRunSummary>(
      `/api/reviews/${encodeURIComponent(run.id)}/reanalyze`,
      {},
      run.csrfToken,
    )
  },
  async email(snapshotId: string, emailId: string) {
    return request<ReviewEmail>(
      `/api/reviews/${encodeURIComponent(snapshotId)}/emails/${encodeURIComponent(emailId)}`,
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
