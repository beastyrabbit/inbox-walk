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
import { clearApiStateForTests, createApiMiddleware, safeCodexLoginUrl } from './api.ts'

let server: Server
let baseUrl = ''
const retainedIds = new Set<string>()

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
  const middleware = createApiMiddleware({
    forceDemo: true,
    reviewHistory: {
      close() {},
      count: () => retainedIds.size,
      forget: (emailIds) =>
        emailIds.forEach((emailId) => {
          retainedIds.delete(emailId)
        }),
      rememberKeptUnread: (emailIds) =>
        emailIds.forEach((emailId) => {
          retainedIds.add(emailId)
        }),
      retainedIds: () => new Set(retainedIds),
      retainOnly: (emailIds) => {
        for (const emailId of retainedIds) {
          if (!emailIds.has(emailId)) retainedIds.delete(emailId)
        }
      },
    },
    codexAuthStorage: () => ({
      login: async (_provider, callbacks) => {
        const selected = await callbacks.onSelect({
          message: 'Methode',
          options: [
            { id: 'browser', label: 'Browser' },
            { id: 'device_code', label: 'Gerätecode' },
          ],
        })
        if (selected !== 'device_code') throw new Error('Expected device-code login')
        callbacks.onDeviceCode({
          userCode: 'TEST-CODE',
          verificationUri: 'https://auth.openai.com/codex/device',
        })
        await new Promise<void>((_resolve, reject) => {
          callbacks.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          )
        })
      },
    }),
  })
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

beforeEach(() => {
  clearApiStateForTests()
  retainedIds.clear()
})

describe('demo API contract', () => {
  it('allows only the official OpenAI host for login links', () => {
    expect(safeCodexLoginUrl('https://auth.openai.com/codex/device')).toBe(
      'https://auth.openai.com/codex/device',
    )
    expect(() => safeCodexLoginUrl('https://auth.openai.com.example.test/codex/device')).toThrow(
      'unerwartete Zieladresse',
    )
    expect(() => safeCodexLoginUrl('http://auth.openai.com/codex/device')).toThrow(
      'unerwartete Zieladresse',
    )
  })

  it('starts a headless Codex subscription login without exposing credentials', async () => {
    const started = await json<{ id: string }>('/api/auth/codex/start', post({}))
    expect(started.response.status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const state = await json<{
      status: string
      url: string
      userCode: string
    }>(`/api/auth/codex/${started.body.id}`)
    expect(state.body).toMatchObject({
      status: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-CODE',
    })
    expect(state.body).not.toHaveProperty('access')
    expect(state.body).not.toHaveProperty('refresh')
  })

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

    const remoteSummary = review.body.emails.find((email) => email.id === 'demo-shop')
    expect(remoteSummary).toBeDefined()
    if (!remoteSummary) return
    const remoteDetail = await json<ReviewEmail>(
      `/api/reviews/${review.body.snapshotId}/emails/${remoteSummary.id}`,
    )
    const remoteIds = Object.values(remoteDetail.body.remoteImageIds ?? {})
    expect(remoteIds).toHaveLength(1)
    expect(remoteIds[0]).toMatch(/^[A-Za-z0-9_-]{24}$/)

    const unknownImage = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/emails/${remoteSummary.id}/images/not-registered?token=${review.body.imageToken}`,
    )
    expect(unknownImage.response.status).toBe(403)
    expect(unknownImage.body.error.code).toBe('IMAGE_FORBIDDEN')
  })

  it('records only messages deliberately kept unread and forgets messages marked read', async () => {
    const first = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const viewed = first.body.emails[0]
    expect(viewed).toBeDefined()
    if (!viewed) return
    await json<ReviewEmail>(`/api/reviews/${first.body.snapshotId}/emails/${viewed.id}`)

    const beforeFinalize = await json<ReviewOptions>('/api/review/options')
    expect(beforeFinalize.body.reviewedCount).toBe(0)
    await json<FinalizeResult>(
      `/api/reviews/${first.body.snapshotId}/finalize`,
      post({ finalizeIds: [viewed.id], keepUnreadIds: [viewed.id] }, first.body.csrfToken),
    )

    const afterKeep = await json<ReviewOptions>('/api/review/options')
    expect(afterKeep.body.reviewedCount).toBe(1)
    const filtered = await json<ReviewSnapshot>(
      '/api/reviews',
      post({
        filters: {
          hideReviewed: true,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
      }),
    )
    expect(filtered.body.emails.map((email) => email.id)).not.toContain(viewed.id)
    expect(filtered.body.emails).toHaveLength(3)

    const unfiltered = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    await json<FinalizeResult>(
      `/api/reviews/${unfiltered.body.snapshotId}/finalize`,
      post({ finalizeIds: [viewed.id], keepUnreadIds: [] }, unfiltered.body.csrfToken),
    )
    const afterRead = await json<ReviewOptions>('/api/review/options')
    expect(afterRead.body.reviewedCount).toBe(0)
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
      post({ finalizeIds: [review.body.emails[0]?.id], keepUnreadIds: [] }),
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

  it('locks the final selection and leaves unprocessed snapshot messages untouched', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'only', timeRange: 'all' } }),
    )
    const keptId = review.body.emails[0]?.id
    expect(keptId).toBeDefined()
    if (!keptId) return
    const finalized = await json<FinalizeResult>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post({ finalizeIds: [keptId], keepUnreadIds: [keptId] }, review.body.csrfToken),
    )
    expect(finalized.response.status).toBe(200)
    expect(finalized.body).toMatchObject({
      finalized: true,
      keptUnread: 1,
      markedRead: 0,
      processed: 1,
      untouched: review.body.emails.length - 1,
    })

    const changed = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post(
        { finalizeIds: review.body.emails.map((email) => email.id), keepUnreadIds: [] },
        review.body.csrfToken,
      ),
    )
    expect(changed.response.status).toBe(409)
    expect(changed.body.error.code).toBe('FINALIZE_SELECTION_LOCKED')
  })

  it('rejects decisions for messages outside the partial completion selection', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const [processed, untouched] = review.body.emails
    expect(processed).toBeDefined()
    expect(untouched).toBeDefined()
    if (!processed || !untouched) return

    const rejected = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post({ finalizeIds: [processed.id], keepUnreadIds: [untouched.id] }, review.body.csrfToken),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('INVALID_SELECTION')
  })

  it('defers newsletter unsubscribe work as a mailbox label', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({
        filters: { mailboxId: null, newsletter: 'only', spam: 'exclude', timeRange: 'all' },
      }),
    )
    const newsletter = review.body.emails[0]
    expect(newsletter?.isNewsletter).toBe(true)
    if (!newsletter) return

    const finalized = await json<FinalizeResult>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post(
        {
          finalizeIds: [newsletter.id],
          keepUnreadIds: [],
          secondaryActionIds: [newsletter.id],
        },
        review.body.csrfToken,
      ),
    )
    expect(finalized.body).toMatchObject({
      rescuedFromSpam: 0,
      taggedForUnsubscribe: 1,
    })
  })

  it('loads only Spam and treats the secondary action as Not Spam', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({
        filters: { mailboxId: null, newsletter: 'all', spam: 'only', timeRange: 'all' },
      }),
    )
    expect(review.body.emails.map((email) => email.id)).toEqual(['demo-spam'])
    const spam = review.body.emails[0]
    if (!spam) return

    const finalized = await json<FinalizeResult>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post(
        {
          finalizeIds: [spam.id],
          keepUnreadIds: [],
          secondaryActionIds: [spam.id],
        },
        review.body.csrfToken,
      ),
    )
    expect(finalized.body).toMatchObject({
      rescuedFromSpam: 1,
      taggedForUnsubscribe: 0,
    })
  })

  it('does not allow non-newsletters to receive the deferred unsubscribe label', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({
        filters: { mailboxId: null, newsletter: 'all', spam: 'exclude', timeRange: 'all' },
      }),
    )
    const regular = review.body.emails.find((email) => !email.isNewsletter)
    expect(regular).toBeDefined()
    if (!regular) return
    const rejected = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post(
        {
          finalizeIds: [regular.id],
          keepUnreadIds: [],
          secondaryActionIds: [regular.id],
        },
        review.body.csrfToken,
      ),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('UNSUBSCRIBE_UNAVAILABLE')
  })
})
