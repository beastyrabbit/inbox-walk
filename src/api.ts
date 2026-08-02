import type {
  ApiError,
  CodexAuthStatus,
  CodexLoginState,
  DraftResult,
  FinalizeResult,
  MailAddress,
  ReplyProposal,
  ReviewEmail,
  ReviewFilters,
  ReviewOptions,
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

async function payload<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ApiError
  if (!response.ok && response.status !== 207) {
    const error = (body as ApiError).error
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

async function post<T>(url: string, body: unknown, csrfToken?: string) {
  return payload<T>(
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-Inbox-Walk-CSRF': csrfToken } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

export const api = {
  async codexStatus() {
    return payload<CodexAuthStatus>(await fetch('/api/auth/codex/status'))
  },
  async startCodexLogin() {
    return post<{ id: string }>('/api/auth/codex/start', {})
  },
  async codexLoginState(id: string) {
    return payload<CodexLoginState>(await fetch(`/api/auth/codex/${encodeURIComponent(id)}`))
  },
  async options() {
    return payload<ReviewOptions>(await fetch('/api/review/options'))
  },
  async createReview(filters: ReviewFilters) {
    return post<ReviewSnapshot>('/api/reviews', { filters })
  },
  async resumeReview(emailIds: string[], filters: ReviewFilters) {
    return post<ReviewSnapshot>('/api/reviews/resume', { emailIds, filters })
  },
  async email(snapshotId: string, emailId: string) {
    return payload<ReviewEmail>(
      await fetch(
        `/api/reviews/${encodeURIComponent(snapshotId)}/emails/${encodeURIComponent(emailId)}`,
      ),
    )
  },
  async thread(snapshotId: string, threadId: string, emailId: string) {
    const params = new URLSearchParams({ emailId })
    return payload<ThreadContext>(
      await fetch(
        `/api/reviews/${encodeURIComponent(snapshotId)}/threads/${encodeURIComponent(threadId)}?${params}`,
      ),
    )
  },
  async finalize(
    snapshot: ReviewSnapshot,
    finalizeIds: string[],
    keepUnreadIds: string[],
    unsubscribeIds: string[],
  ) {
    return post<FinalizeResult>(
      `/api/reviews/${encodeURIComponent(snapshot.snapshotId)}/finalize`,
      { finalizeIds, keepUnreadIds, unsubscribeIds },
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
  source: string,
  imageToken: string,
) {
  const params = new URLSearchParams({ token: imageToken, url: source })
  return `/api/reviews/${encodeURIComponent(snapshotId)}/emails/${encodeURIComponent(emailId)}/images?${params}`
}
