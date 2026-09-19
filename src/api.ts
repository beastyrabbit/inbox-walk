import type {
  ApiError,
  CodexAuthStatus,
  CodexLoginState,
  DraftResult,
  MailAddress,
  ReplyEditorState,
  ReplyProposal,
  ReviewEmail,
  ThreadContext,
  TriageActionResult,
  TriageMemory,
  TriageSnapshot,
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

async function send<T>(
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
  csrfToken?: string,
  persistOnUnload = false,
) {
  const serialized = JSON.stringify(body)
  const keepalive = persistOnUnload && new TextEncoder().encode(serialized).byteLength <= 60 * 1024
  return request<T>(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-Inbox-Walk-CSRF': csrfToken } : {}),
    },
    body: serialized,
    keepalive,
  })
}

type MessageAction = 'done' | 'park' | 'unpark' | 'newsletter' | 'retry'

const encoded = encodeURIComponent

export const api = {
  async codexStatus() {
    return request<CodexAuthStatus>('/api/auth/codex/status')
  },
  async startCodexLogin() {
    return send<{ id: string }>('POST', '/api/auth/codex/start', {})
  },
  async codexLoginState(id: string) {
    return request<CodexLoginState>(`/api/auth/codex/${encoded(id)}`)
  },
  async todo() {
    return request<TriageSnapshot>('/api/todo')
  },
  async refresh(csrfToken: string) {
    return send<TriageSnapshot>('POST', '/api/todo/refresh', {}, csrfToken)
  },
  async messageAction(action: MessageAction, emailIds: string[], csrfToken: string) {
    return send<TriageActionResult>(
      'POST',
      `/api/todo/messages/${action}`,
      { emailIds },
      csrfToken,
      true,
    )
  },
  async email(emailId: string) {
    return request<ReviewEmail>(`/api/todo/emails/${encoded(emailId)}`)
  },
  async thread(threadId: string, emailId: string) {
    const params = new URLSearchParams({ emailId })
    return request<ThreadContext>(`/api/todo/threads/${encoded(threadId)}?${params}`)
  },
  async replyEditor(emailId: string) {
    return request<{ editor: ReplyEditorState | null }>(
      `/api/todo/emails/${encoded(emailId)}/editor`,
    )
  },
  async saveReplyEditor(emailId: string, editor: ReplyEditorState, csrfToken: string) {
    return send<{ editor: ReplyEditorState }>(
      'PUT',
      `/api/todo/emails/${encoded(emailId)}/editor`,
      { editor },
      csrfToken,
      true,
    )
  },
  async reply(
    emailId: string,
    body: {
      currentDraft?: string
      requestId: string
      revisionInstruction?: string
      roughNotes: string
    },
    csrfToken: string,
  ) {
    return send<ReplyProposal>(
      'POST',
      `/api/todo/emails/${encoded(emailId)}/replies`,
      body,
      csrfToken,
    )
  },
  async draft(
    emailId: string,
    body: {
      bodyText: string
      cc: MailAddress[]
      identityId: string
      requestId: string
      subject: string
      to: MailAddress[]
    },
    csrfToken: string,
  ) {
    return send<DraftResult>('POST', `/api/todo/emails/${encoded(emailId)}/drafts`, body, csrfToken)
  },
  async saveMemory(notes: string, csrfToken: string) {
    return send<TriageMemory>('PUT', '/api/todo/memory', { notes }, csrfToken)
  },
  async decideProposal(id: string, accept: boolean, csrfToken: string) {
    return send<TriageMemory>(
      'POST',
      `/api/todo/memory/proposals/${encoded(id)}/${accept ? 'accept' : 'reject'}`,
      {},
      csrfToken,
    )
  },
}

export function blobUrl(blobId: string, inline = false) {
  return `/api/todo/blobs/${encoded(blobId)}${inline ? '?inline=1' : ''}`
}

export function remoteImageUrl(emailId: string, imageId: string, imageToken: string) {
  const params = new URLSearchParams({ token: imageToken })
  return `/api/todo/emails/${encoded(emailId)}/images/${encoded(imageId)}?${params}`
}
