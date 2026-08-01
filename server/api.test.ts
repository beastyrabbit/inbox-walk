import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  DraftResult,
  FinalizeResult,
  ReplyProposal,
  ReviewEmail,
  ReviewOptions,
  ReviewSnapshot,
  ThreadContext,
} from '../src/shared.ts'
import { clearApiStateForTests, createApiMiddleware } from './api.ts'

let server: Server
let baseUrl = ''

async function json<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init)
  return { response, body: (await response.json()) as T }
}

function post(body: unknown, csrfToken?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-Inbox-Walk-CSRF': csrfToken } : {}),
    },
    body: JSON.stringify(body),
  }
}

beforeAll(async () => {
  const middleware = createApiMiddleware({ forceDemo: true })
  server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

beforeEach(() => clearApiStateForTests())

describe('demo API contract', () => {
  it('creates a fixed review and lazily loads a detail', async () => {
    const options = await json<ReviewOptions>('/api/review/options')
    expect(options.response.status).toBe(200)
    expect(options.body.mode).toBe('demo')

    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    expect(review.response.status).toBe(201)
    expect(review.body.emails).toHaveLength(4)
    expect(review.body.emails[0]).not.toHaveProperty('html')

    const detail = await json<ReviewEmail>(
      `/api/reviews/${review.body.snapshotId}/emails/${review.body.emails[0]?.id}`,
    )
    expect(detail.response.status).toBe(200)
    expect(detail.body).toHaveProperty('text')
    expect(detail.body.attachments).toHaveLength(1)
  })

  it('resumes only exact IDs and reports missing messages', async () => {
    const resumed = await json<ReviewSnapshot>(
      '/api/reviews/resume',
      post({
        emailIds: ['demo-human', 'missing-id', 'demo-train'],
        filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' },
      }),
    )
    expect(resumed.body.emails.map((email) => email.id)).toEqual(['demo-human', 'demo-train'])
    expect(resumed.body.missingIds).toEqual(['missing-id'])
  })

  it('requires the snapshot CSRF token for mutations', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const rejected = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post({ keepUnreadIds: [] }),
    )
    expect(rejected.response.status).toBe(403)
    expect(rejected.body.error.code).toBe('INVALID_CSRF')
  })

  it('builds reply context, proposes text, saves a draft, and exposes no send route', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const email = review.body.emails.find((item) => item.id === 'demo-human')
    expect(email).toBeDefined()
    if (!email) return

    const context = await json<ThreadContext>(
      `/api/reviews/${review.body.snapshotId}/threads/${email.threadId}?emailId=${email.id}`,
    )
    expect(context.body.recipients.to[0]?.email).toBe('mara@example.com')

    const proposal = await json<ReplyProposal>(
      `/api/reviews/${review.body.snapshotId}/replies`,
      post(
        {
          emailId: email.id,
          requestId: crypto.randomUUID(),
          roughNotes: 'Donnerstag um 19 Uhr passt.',
        },
        review.body.csrfToken,
      ),
    )
    expect(proposal.response.status).toBe(200)
    expect(proposal.body.bodyText).toContain('Donnerstag')

    const draft = await json<DraftResult>(
      `/api/reviews/${review.body.snapshotId}/drafts`,
      post(
        {
          requestId: crypto.randomUUID(),
          emailId: email.id,
          identityId: context.body.recipients.identityId,
          to: context.body.recipients.to,
          cc: context.body.recipients.cc,
          subject: context.body.recipients.subject,
          bodyText: proposal.body.bodyText,
        },
        review.body.csrfToken,
      ),
    )
    expect(draft.response.status).toBe(201)
    expect(draft.body.verified).toBe(true)

    const send = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/send`,
      post({}, review.body.csrfToken),
    )
    expect(send.response.status).toBe(404)
    expect(send.body.error.code).toBe('NOT_FOUND')
  })

  it('locks the final selection and finalizes only the snapshot IDs', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'only', timeRange: 'all' } }),
    )
    const keptId = review.body.emails[0]?.id
    expect(keptId).toBeDefined()
    if (!keptId) return
    const finalized = await json<FinalizeResult>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post({ keepUnreadIds: [keptId] }, review.body.csrfToken),
    )
    expect(finalized.response.status).toBe(200)
    expect(finalized.body).toMatchObject({ finalized: true, keptUnread: 1, markedRead: 0 })

    const changed = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post({ keepUnreadIds: [] }, review.body.csrfToken),
    )
    expect(changed.response.status).toBe(409)
    expect(changed.body.error.code).toBe('FINALIZE_SELECTION_LOCKED')
  })
})
