import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  DraftResult,
  FinalizeResult,
  ReplyProposal,
  ReviewEmail,
  ReviewOptions,
  ReviewRunSummary,
  ReviewSnapshot,
  ThreadContext,
} from '../src/shared.ts'
import { defaultReviewFilters } from '../src/shared.ts'
import {
  clearApiStateForTests,
  createApiMiddleware,
  safeCodexLoginUrl,
  waitForApiJobs,
} from './api.ts'
import { type BundleExample, hashLearningSignal } from './bundles.ts'
import { CodexAuthenticationError, CodexContextLengthError } from './codex.ts'
import { demoEmails } from './demo.ts'
import { createRoundStore } from './round-store.ts'

let server: Server
let baseUrl = ''
const retainedIds = new Set<string>()
let injectUnknownBundleId = false
let bundleDecisionFailure: Error | null = null
let bundleDecisionCalls = 0
let bundleDecisionGate: Promise<void> | null = null
let releaseBundleDecision: (() => void) | null = null
let availableBundleExamples: BundleExample[] = []
const roundStore = createRoundStore(':memory:')
const partialFinalizeResult: FinalizeResult = {
  actionFailed: [],
  failed: [{ id: 'demo-human', reason: 'Temporärer Fastmail-Fehler' }],
  finalized: false,
  keptUnread: 1,
  markedRead: 0,
  mode: 'demo',
  processed: 1,
  remaining: 1,
  rescuedFromSpam: 0,
  taggedForUnsubscribe: 0,
  untouched: demoEmails.length - 1,
}

async function json<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = (await response.json()) as T
  if (
    path === '/api/reviews' &&
    init?.method === 'POST' &&
    typeof init.body === 'string' &&
    !Object.hasOwn(JSON.parse(init.body) as object, 'id') &&
    response.status === 202 &&
    body &&
    typeof body === 'object' &&
    'id' in body &&
    typeof body.id === 'string'
  ) {
    // The older behavioral tests below need a ready snapshot. Drive the new
    // background contract to completion instead of preserving a second creation path.
    await waitForApiJobs()
    const opened = await fetch(`${baseUrl}/api/reviews/${body.id}`)
    return { response, body: (await opened.json()) as T }
  }
  return { response, body }
}

async function waitForBundles(review: ReviewSnapshot) {
  const started = await json<ReviewSnapshot>(
    `/api/reviews/${review.snapshotId}/bundles`,
    post({}, review.csrfToken),
  )
  expect([200, 202]).toContain(started.response.status)
  let current = started.body
  for (let attempt = 0; attempt < 50 && current.analysis.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    current = (await json<ReviewSnapshot>(`/api/reviews/${review.snapshotId}`)).body
  }
  expect(current.analysis.status).toBe('complete')
  expect(current.bundleRun).toBeDefined()
  return current
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

function finalizationBody(
  review: ReviewSnapshot,
  selection: {
    finalizeIds: Array<string | undefined>
    keepUnreadIds: Array<string | undefined>
    secondaryActionIds?: Array<string | undefined>
  },
) {
  return { ...selection, revision: review.userState.revision }
}

beforeAll(async () => {
  const middleware = createApiMiddleware({
    forceDemo: true,
    roundStore,
    bundleStore: {
      examples: () => availableBundleExamples,
      record: () => {},
    },
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
    bundleDecider: async () => {
      bundleDecisionCalls += 1
      if (bundleDecisionGate) await bundleDecisionGate
      if (bundleDecisionFailure) throw bundleDecisionFailure
      return {
        includedEmailIds: injectUnknownBundleId ? ['outside-frozen-snapshot'] : [],
        kind: 'standalone',
        title: 'Demo bundle',
        currentState: 'Demo',
        summary: 'Deterministic test decision.',
        linkEvidence: [],
        membershipConfidence: 1,
      }
    },
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
  roundStore.close()
})

beforeEach(() => {
  clearApiStateForTests()
  retainedIds.clear()
  injectUnknownBundleId = false
  bundleDecisionFailure = null
  bundleDecisionCalls = 0
  bundleDecisionGate = null
  releaseBundleDecision = null
  availableBundleExamples = []
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

  it('does not allow model changes in demo mode', async () => {
    const result = await json<{ error: { code: string } }>(
      '/api/auth/codex/model',
      post({ model: 'gpt-5.6-terra' }),
    )
    expect(result.response.status).toBe(403)
    expect(result.body.error.code).toBe('DEMO_MODE')
  })

  it('creates one durable background run idempotently, lists it, reanalyzes its frozen snapshot, and deletes it', async () => {
    const id = crypto.randomUUID()
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    const created = await json<ReviewRunSummary>('/api/reviews', post({ id, filters }))
    expect(created.response.status).toBe(202)
    expect(created.body).toMatchObject({
      generation: 1,
      id,
      reanalyzable: false,
      status: 'queued',
    })

    const repeated = await json<ReviewRunSummary>('/api/reviews', post({ id, filters }))
    expect(repeated.response.status).toBe(202)
    expect(repeated.body.csrfToken).toBe(created.body.csrfToken)

    await waitForApiJobs()
    const listed = await json<{ runs: ReviewRunSummary[] }>('/api/reviews')
    const ready = listed.body.runs.find((run) => run.id === id)
    expect(ready).toMatchObject({
      emailCount: 9,
      generation: 1,
      reanalyzable: true,
      status: 'ready',
    })

    const opened = await json<ReviewSnapshot>(`/api/reviews/${id}`)
    expect(opened.response.status).toBe(200)
    const frozenIds = opened.body.emails.map((email) => email.id)

    const restarted = await json<ReviewRunSummary>(
      `/api/reviews/${id}/reanalyze`,
      post({}, created.body.csrfToken),
    )
    expect(restarted.response.status).toBe(202)
    expect(restarted.body).toMatchObject({
      generation: 2,
      id,
      reanalyzable: false,
      status: 'analyzing',
    })
    await waitForApiJobs()
    const reopened = await json<ReviewSnapshot>(`/api/reviews/${id}`)
    expect(reopened.body.emails.map((email) => email.id)).toEqual(frozenIds)
    const detailId = frozenIds[0]
    expect(detailId).toBeDefined()
    if (!detailId) return
    const detail = await json<ReviewEmail>(`/api/reviews/${id}/emails/${detailId}`)
    expect(detail.response.status).toBe(200)
    expect(detail.body.text).toBe(demoEmails.find((email) => email.id === detailId)?.text)

    const deleted = await fetch(`${baseUrl}/api/reviews/${id}`, {
      method: 'DELETE',
      headers: { 'X-Inbox-Walk-CSRF': created.body.csrfToken },
    })
    expect(deleted.status).toBe(204)
    expect(roundStore.get(id)).toBeNull()
  })

  it('generates a durable background run ID when the client omits one', async () => {
    const response = await fetch(
      `${baseUrl}/api/reviews`,
      post({
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
      }),
    )
    const created = (await response.json()) as ReviewRunSummary

    expect(response.status).toBe(202)
    expect(created).toMatchObject({
      generation: 1,
      reanalyzable: false,
      status: 'queued',
    })
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(['fetching', 'analyzing', 'ready']).toContain(roundStore.get(created.id)?.runStatus)

    await waitForApiJobs()
    expect(roundStore.get(created.id)).toMatchObject({
      bundleRun: expect.any(Object),
      runStatus: 'ready',
    })

    const deleted = await fetch(`${baseUrl}/api/reviews/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Inbox-Walk-CSRF': created.csrfToken },
    })
    expect(deleted.status).toBe(204)
  })

  it('gates an unfinished run and deleting it aborts snapshot loading before persistence', async () => {
    const localStore = createRoundStore(':memory:')
    let fetchAborted = false
    const localMiddleware = createApiMiddleware({
      autoStartBundles: true,
      fastmailToken: 'test-token',
      fetchMailSnapshot: async (_token, _filters, _retainedIds, signal) => {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            fetchAborted = true
            reject(new DOMException('Cancelled', 'AbortError'))
          }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
        throw new Error('unreachable')
      },
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const id = crypto.randomUUID()
      const created = (await (
        await fetch(
          `${localBase}/api/reviews`,
          post({
            id,
            filters: {
              hideReviewed: false,
              mailboxId: null,
              newsletter: 'all',
              spam: 'exclude',
              timeRange: 'all',
            },
          }),
        )
      ).json()) as ReviewRunSummary
      const gated = await fetch(`${localBase}/api/reviews/${id}`)
      expect(gated.status).toBe(409)
      expect(((await gated.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_NOT_READY',
      )
      const earlyDetail = await fetch(`${localBase}/api/reviews/${id}/emails/anything`)
      expect(earlyDetail.status).toBe(409)
      expect(((await earlyDetail.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_NOT_READY',
      )
      expect(localStore.get(id)).toMatchObject({
        analysis: { phase: 'fetching', status: 'running' },
        runStatus: 'fetching',
      })
      const deleted = await fetch(`${localBase}/api/reviews/${id}`, {
        method: 'DELETE',
        headers: { 'X-Inbox-Walk-CSRF': created.csrfToken },
      })
      expect(deleted.status).toBe(204)
      await waitForApiJobs()
      expect(fetchAborted).toBe(true)
      expect(localStore.get(id)).toBeNull()
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('rejects deletion while non-abortable reply work is in flight', async () => {
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    localStore.create({
      csrfToken: 'reply-delete-csrf',
      emails: [source],
      filters: defaultReviewFilters,
      id: 'reply-delete-round',
      imageToken: 'reply-delete-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
      runStatus: 'ready',
    })
    let contextStarted: (() => void) | undefined
    const contextStart = new Promise<void>((resolve) => {
      contextStarted = resolve
    })
    let releaseContext: (() => void) | undefined
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve
    })
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      codexAuthStatus: () => ({ configured: true, model: 'gpt-5.6-sol' }),
      fastmailToken: 'test-token',
      resumeMailSnapshot: async () => {
        contextStarted?.()
        await contextGate
        throw new Error('Stop reply after delete guard is verified')
      },
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const replying = fetch(
        `${localBase}/api/reviews/reply-delete-round/replies`,
        post(
          {
            emailId: source.id,
            requestId: crypto.randomUUID(),
            roughNotes: 'Kurze Antwort',
          },
          'reply-delete-csrf',
        ),
      )
      await contextStart

      const blocked = await fetch(`${localBase}/api/reviews/reply-delete-round`, {
        method: 'DELETE',
        headers: { 'X-Inbox-Walk-CSRF': 'reply-delete-csrf' },
      })
      expect(blocked.status).toBe(409)
      expect((await blocked.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_DRAFT_IN_PROGRESS' },
      })
      expect(localStore.get('reply-delete-round')).not.toBeNull()

      const reanalysis = await fetch(
        `${localBase}/api/reviews/reply-delete-round/reanalyze`,
        post({}, 'reply-delete-csrf'),
      )
      expect(reanalysis.status).toBe(409)
      expect((await reanalysis.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_DRAFT_IN_PROGRESS' },
      })
      expect(localStore.get('reply-delete-round')).toMatchObject({
        generation: 0,
        runStatus: 'ready',
      })

      releaseContext?.()
      expect((await replying).status).toBe(500)
      const deleted = await fetch(`${localBase}/api/reviews/reply-delete-round`, {
        method: 'DELETE',
        headers: { 'X-Inbox-Walk-CSRF': 'reply-delete-csrf' },
      })
      expect(deleted.status).toBe(204)
      expect(localStore.get('reply-delete-round')).toBeNull()
    } finally {
      releaseContext?.()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('fails a new live run closed when Fastmail returns an incomplete snapshot', async () => {
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    let providerCalls = 0
    const localMiddleware = createApiMiddleware({
      bundleDecider: async () => {
        providerCalls += 1
        throw new Error('Provider must not be called for an incomplete snapshot')
      },
      fastmailToken: 'test-token',
      fetchMailSnapshot: async (_token, filters) => ({
        context: {
          accountId: 'account',
          apiUrl: 'https://api.example.invalid',
          downloadUrl: 'https://download.example.invalid',
          maxObjectsInGet: 256,
          maxObjectsInSet: 256,
          username: 'test@example.invalid',
        },
        emails: [source],
        filters: filters ?? {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
        missingIds: ['missing-live-message'],
        totalBeforeLimit: 2,
        truncated: false,
      }),
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const id = crypto.randomUUID()
      const createdResponse = await fetch(
        `${localBase}/api/reviews`,
        post({
          id,
          filters: {
            hideReviewed: false,
            mailboxId: null,
            newsletter: 'all',
            spam: 'exclude',
            timeRange: 'all',
          },
        }),
      )
      const created = (await createdResponse.json()) as ReviewRunSummary
      expect(createdResponse.status).toBe(202)

      await waitForApiJobs()
      expect(providerCalls).toBe(0)
      expect(localStore.get(id)).toMatchObject({
        bundleRun: null,
        emails: [expect.objectContaining({ id: source.id })],
        generation: 1,
        missingIds: ['missing-live-message'],
        runStatus: 'failed',
      })

      const opened = await fetch(`${localBase}/api/reviews/${id}`)
      expect(opened.status).toBe(409)
      expect(((await opened.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_SNAPSHOT_INCOMPLETE',
      )

      const reanalyzed = await fetch(
        `${localBase}/api/reviews/${id}/reanalyze`,
        post({}, created.csrfToken),
      )
      expect(reanalyzed.status).toBe(409)
      expect(((await reanalyzed.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_SNAPSHOT_INCOMPLETE',
      )

      const deleted = await fetch(`${localBase}/api/reviews/${id}`, {
        method: 'DELETE',
        headers: { 'X-Inbox-Walk-CSRF': created.csrfToken },
      })
      expect(deleted.status).toBe(204)
      expect(localStore.get(id)).toBeNull()
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('deleting an analyzing run aborts its decider and cannot persist a late result', async () => {
    const localStore = createRoundStore(':memory:')
    let analysisStartedResolve: (() => void) | undefined
    const analysisStarted = new Promise<void>((resolve) => {
      analysisStartedResolve = resolve
    })
    let analysisAborted = false
    let savedDecisions = 0
    let savedRuns = 0
    const observedStore = {
      ...localStore,
      saveBundleDecision: (...args: Parameters<(typeof localStore)['saveBundleDecision']>) => {
        savedDecisions += 1
        return localStore.saveBundleDecision(...args)
      },
      saveBundleRun: (...args: Parameters<(typeof localStore)['saveBundleRun']>) => {
        savedRuns += 1
        return localStore.saveBundleRun(...args)
      },
    }
    const localMiddleware = createApiMiddleware({
      bundleDecider: async (_input, signal) => {
        analysisStartedResolve?.()
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            analysisAborted = true
            reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
          }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
        throw new Error('unreachable')
      },
      forceDemo: true,
      roundStore: observedStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const id = crypto.randomUUID()
      const createdResponse = await fetch(
        `${localBase}/api/reviews`,
        post({
          id,
          filters: {
            hideReviewed: false,
            mailboxId: null,
            newsletter: 'all',
            spam: 'exclude',
            timeRange: 'all',
          },
        }),
      )
      expect(createdResponse.status).toBe(202)
      const created = (await createdResponse.json()) as ReviewRunSummary
      await analysisStarted
      expect(localStore.get(id)?.runStatus).toBe('analyzing')

      const deleted = await fetch(`${localBase}/api/reviews/${id}`, {
        method: 'DELETE',
        headers: { 'X-Inbox-Walk-CSRF': created.csrfToken },
      })
      expect(deleted.status).toBe(204)
      await waitForApiJobs()

      expect(analysisAborted).toBe(true)
      expect(savedDecisions).toBe(0)
      expect(savedRuns).toBe(0)
      expect(localStore.get(id)).toBeNull()
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('aborts a manual bundle job before reanalysis and only persists the new generation', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const summaries = [
      source,
      {
        ...source,
        id: `${source.id}-generation-peer`,
        receivedAt: new Date(Date.parse(source.receivedAt) + 1_000).toISOString(),
        subject: `${source.subject} · Fortsetzung`,
        threadId: `${source.threadId}-generation-peer`,
      },
    ].map((email) => ({
      from: email.from,
      hasAttachment: email.hasAttachment,
      id: email.id,
      isNewsletter: email.isNewsletter,
      mailboxNames: email.mailboxNames,
      preview: email.preview,
      receivedAt: email.receivedAt,
      subject: email.subject,
      threadId: email.threadId,
      to: email.to,
    }))
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'waiting',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
        thinkingLevel: 'high',
        totalEmailCount: summaries.length,
      },
      csrfToken: 'manual-generation-csrf',
      emails: summaries,
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 1,
      id: 'manual-generation-round',
      imageToken: 'manual-generation-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
      runStatus: 'ready',
    })
    const checkpointWriteGenerations: Array<number | undefined> = []
    const bundleRunWriteGenerations: Array<number | undefined> = []
    const observedStore = {
      ...localStore,
      saveBundlePartition: (...args: Parameters<(typeof localStore)['saveBundlePartition']>) => {
        checkpointWriteGenerations.push(args[3])
        return localStore.saveBundlePartition(...args)
      },
      saveBundleRun: (...args: Parameters<(typeof localStore)['saveBundleRun']>) => {
        bundleRunWriteGenerations.push(args[3])
        return localStore.saveBundleRun(...args)
      },
    }
    let providerCalls = 0
    let firstSignal: AbortSignal | undefined
    let firstSignalAborted = false
    let firstCallStartedResolve: (() => void) | undefined
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallStartedResolve = resolve
    })
    let releaseFirstCall: (() => void) | undefined
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve
    })
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      bundlePartitionDecider: async (input, signal) => {
        providerCalls += 1
        const generation = providerCalls
        if (generation === 1) {
          firstSignal = signal
          firstCallStartedResolve?.()
          const abort = () => {
            firstSignalAborted = true
            releaseFirstCall?.()
          }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
          await firstCallGate
        }
        return {
          standaloneEmailIds: [],
          stories: [
            {
              currentState: `Generation ${generation} abgeschlossen`,
              emailIds: input.emails.map((email) => email.id),
              kind: 'conversation',
              linkEvidence: [`Generation ${generation}`],
              membershipConfidence: 1,
              summary: `Ergebnis aus Generation ${generation}.`,
              title: `Generation ${generation}`,
            },
          ],
        }
      },
      codexAuthStatus: () => ({
        configured: true,
        model: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      }),
      roundStore: observedStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const opened = await fetch(`${localBase}/api/reviews/manual-generation-round`)
      expect(opened.status).toBe(200)

      const started = await fetch(
        `${localBase}/api/reviews/manual-generation-round/bundles`,
        post({}, 'manual-generation-csrf'),
      )
      expect(started.status).toBe(202)
      await firstCallStarted
      expect(firstSignal?.aborted).toBe(false)

      const reanalyzed = await fetch(
        `${localBase}/api/reviews/manual-generation-round/reanalyze`,
        post({}, 'manual-generation-csrf'),
      )
      expect(reanalyzed.status).toBe(202)
      expect((await reanalyzed.json()) as ReviewRunSummary).toMatchObject({
        generation: 2,
        status: 'analyzing',
      })
      expect(firstSignalAborted).toBe(true)
      expect(firstSignal?.aborted).toBe(true)

      await waitForApiJobs()
      expect(providerCalls).toBe(2)
      expect(checkpointWriteGenerations).toEqual([2])
      expect(bundleRunWriteGenerations).toEqual([2])
      const completed = localStore.get('manual-generation-round')
      expect(completed).toMatchObject({
        analysis: { callCount: 1, status: 'complete' },
        generation: 2,
        runStatus: 'ready',
      })
      expect(completed?.bundleRun?.bundles).toEqual([
        expect.objectContaining({ title: 'Generation 2' }),
      ])
    } finally {
      releaseFirstCall?.()
      await waitForApiJobs()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('reanalyzes a ready empty snapshot but rejects a failed run with no snapshot', async () => {
    const localStore = createRoundStore(':memory:')
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'heuristic',
        phase: 'complete',
        processedEmailCount: 0,
        progress: 1,
        status: 'complete',
        totalEmailCount: 0,
      },
      csrfToken: 'empty-ready-csrf',
      emails: [],
      filters,
      generation: 1,
      id: 'empty-ready-round',
      imageToken: 'empty-ready-image',
      mailboxes: [],
      mode: 'demo',
      runStatus: 'ready',
    })
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'codex',
        error: 'Snapshot failed.',
        phase: 'failed',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
        totalEmailCount: 0,
      },
      csrfToken: 'empty-failed-csrf',
      emails: [],
      filters,
      generation: 1,
      id: 'empty-failed-round',
      imageToken: 'empty-failed-image',
      mailboxes: [],
      mode: 'live',
      runStatus: 'failed',
    })
    const localMiddleware = createApiMiddleware({ forceDemo: true, roundStore: localStore })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const restarted = await fetch(
        `${localBase}/api/reviews/empty-ready-round/reanalyze`,
        post({}, 'empty-ready-csrf'),
      )
      expect(restarted.status).toBe(202)
      await waitForApiJobs()
      expect(localStore.get('empty-ready-round')).toMatchObject({
        bundleRun: { bundles: [] },
        generation: 2,
        runStatus: 'ready',
      })

      const rejected = await fetch(
        `${localBase}/api/reviews/empty-failed-round/reanalyze`,
        post({}, 'empty-failed-csrf'),
      )
      expect(rejected.status).toBe(409)
      expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_SNAPSHOT_MISSING',
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('rejects a second reanalysis request without aborting the first generation', async () => {
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'heuristic',
        phase: 'complete',
        processedEmailCount: 1,
        progress: 1,
        status: 'complete',
        totalEmailCount: 1,
      },
      csrfToken: 'double-reanalysis-csrf',
      emails: [source],
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 1,
      id: 'double-reanalysis-round',
      imageToken: 'double-reanalysis-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'demo',
      runStatus: 'ready',
    })
    let releaseDecision: (() => void) | undefined
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve
    })
    let providerSignal: AbortSignal | undefined
    const localMiddleware = createApiMiddleware({
      bundleDecider: async (input, signal) => {
        providerSignal = signal
        await decisionGate
        return {
          currentState: 'Geprüft',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Eigenständige Nachricht.',
          title: input.seed[0]?.subject ?? 'Nachricht',
        }
      },
      forceDemo: true,
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const first = await fetch(
        `${localBase}/api/reviews/double-reanalysis-round/reanalyze`,
        post({}, 'double-reanalysis-csrf'),
      )
      expect(first.status).toBe(202)
      const second = await fetch(
        `${localBase}/api/reviews/double-reanalysis-round/reanalyze`,
        post({}, 'double-reanalysis-csrf'),
      )
      expect(second.status).toBe(409)
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_REANALYSIS_IN_PROGRESS',
      )
      expect(providerSignal?.aborted).toBe(false)
      releaseDecision?.()
      await waitForApiJobs()
      expect(localStore.get('double-reanalysis-round')).toMatchObject({
        generation: 2,
        runStatus: 'ready',
      })
    } finally {
      releaseDecision?.()
      await waitForApiJobs()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('marks a background run failed when its final bundle result cannot be persisted', async () => {
    const localStore = createRoundStore(':memory:')
    let providerCalls = 0
    const failingStore = {
      ...localStore,
      saveBundleRun: () => null,
    }
    const localMiddleware = createApiMiddleware({
      bundleDecider: async (input) => {
        providerCalls += 1
        return {
          currentState: 'Geprüft',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Eigenständige Nachricht.',
          title: input.seed[0]?.subject ?? 'Nachricht',
        }
      },
      forceDemo: true,
      roundStore: failingStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const id = crypto.randomUUID()
      await fetch(
        `${localBase}/api/reviews`,
        post({
          id,
          filters: {
            hideReviewed: false,
            mailboxId: null,
            newsletter: 'all',
            spam: 'exclude',
            timeRange: 'all',
          },
        }),
      )
      await waitForApiJobs()
      expect(providerCalls).toBeGreaterThan(0)
      expect(localStore.get(id)).toMatchObject({
        bundleRun: null,
        runStatus: 'failed',
      })
      expect(localStore.get(id)?.analysis.error).toContain('nicht dauerhaft gespeichert')

      const callsAfterFailure = providerCalls
      await fetch(`${localBase}/api/reviews`)
      await fetch(`${localBase}/api/reviews`)
      await waitForApiJobs()
      expect(providerCalls).toBe(callsAfterFailure)
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('contains throwing terminal persistence transitions and still cleans up the analysis job', async () => {
    const localStore = createRoundStore(':memory:')
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'heuristic',
        phase: 'complete',
        processedEmailCount: demoEmails.length,
        progress: 1,
        status: 'complete',
        totalEmailCount: demoEmails.length,
      },
      csrfToken: 'throwing-terminal-csrf',
      emails: demoEmails,
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 1,
      id: 'throwing-terminal-round',
      imageToken: 'throwing-terminal-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'demo',
      runStatus: 'ready',
    })
    let terminalTransitions = 0
    const throwingStore = {
      ...localStore,
      saveBundleRun: () => {
        throw new Error('Simulated bundle result persistence failure')
      },
      updateRunStatus: (...args: Parameters<(typeof localStore)['updateRunStatus']>) => {
        const updated = localStore.updateRunStatus(...args)
        if (args[2] === 'failed') {
          terminalTransitions += 1
          throw new Error('Simulated post-commit terminal persistence failure')
        }
        return updated
      },
    }
    const localMiddleware = createApiMiddleware({
      bundleDecider: async (input) => ({
        currentState: 'Geprüft',
        includedEmailIds: [],
        kind: 'standalone',
        linkEvidence: [],
        membershipConfidence: 1,
        summary: 'Eigenständige Nachricht.',
        title: input.seed[0]?.subject ?? 'Nachricht',
      }),
      forceDemo: true,
      roundStore: throwingStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const restarted = await fetch(
        `${localBase}/api/reviews/throwing-terminal-round/reanalyze`,
        post({}, 'throwing-terminal-csrf'),
      )
      expect(restarted.status).toBe(202)

      await expect(waitForApiJobs()).resolves.toBeUndefined()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(terminalTransitions).toBeGreaterThan(0)
      expect(localStore.get('throwing-terminal-round')).toMatchObject({
        bundleRun: null,
        runStatus: 'failed',
      })

      const deleted = await fetch(`${localBase}/api/reviews/throwing-terminal-round`, {
        method: 'DELETE',
        headers: { 'X-Inbox-Walk-CSRF': 'throwing-terminal-csrf' },
      })
      expect(deleted.status).toBe(204)
    } finally {
      await waitForApiJobs()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('fails a background run before provider work when analysis start persistence is rejected', async () => {
    const localStore = createRoundStore(':memory:')
    let providerCalls = 0
    const failingStore = {
      ...localStore,
      updateAnalysis: () => null,
    }
    const localMiddleware = createApiMiddleware({
      bundleDecider: async () => {
        providerCalls += 1
        throw new Error('Provider must not be called')
      },
      forceDemo: true,
      roundStore: failingStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const id = crypto.randomUUID()
      await fetch(
        `${localBase}/api/reviews`,
        post({
          id,
          filters: {
            hideReviewed: false,
            mailboxId: null,
            newsletter: 'all',
            spam: 'exclude',
            timeRange: 'all',
          },
        }),
      )
      await waitForApiJobs()
      expect(providerCalls).toBe(0)
      expect(localStore.get(id)).toMatchObject({ runStatus: 'failed' })
      expect(localStore.get(id)?.analysis.error).toContain('nicht sicher gestartet')
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('recovers a persisted queued run when the run list is loaded after restart', async () => {
    const localStore = createRoundStore(':memory:')
    const id = crypto.randomUUID()
    localStore.create({
      analysis: {
        engine: 'heuristic',
        phase: 'queued',
        status: 'pending',
        totalEmailCount: 0,
      },
      csrfToken: 'restart-csrf',
      emails: [],
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 1,
      id,
      imageToken: 'restart-image',
      mailboxes: [],
      mode: 'demo',
      runStatus: 'queued',
    })
    const localMiddleware = createApiMiddleware({ forceDemo: true, roundStore: localStore })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      await fetch(`http://127.0.0.1:${address.port}/api/reviews`)
      await waitForApiJobs()
      expect(localStore.get(id)).toMatchObject({ runStatus: 'ready' })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('reads and atomically updates model plus thinking level through settings', async () => {
    let settings = { model: 'gpt-5.6-sol' as const, thinkingLevel: 'high' as const }
    const localMiddleware = createApiMiddleware({
      codexAuthStatus: () => ({ configured: true, ...settings }),
      codexSettingsSelect: (next) => {
        settings = next as typeof settings
        return { configured: true, ...settings }
      },
      fastmailToken: 'test-token',
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      expect(await (await fetch(`${localBase}/api/settings/codex`)).json()).toMatchObject(settings)
      const updated = await fetch(
        `${localBase}/api/settings/codex`,
        post({ model: 'gpt-5.6-terra', thinkingLevel: 'xhigh' }),
      )
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({
        model: 'gpt-5.6-terra',
        thinkingLevel: 'xhigh',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      clearApiStateForTests()
    }
  })

  it('creates a fixed review and lazily loads a detail', async () => {
    const options = await json<ReviewOptions>('/api/review/options')
    expect(options.response.status).toBe(200)
    expect(options.body.mode).toBe('demo')

    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    expect(review.response.status).toBe(202)
    expect(review.body.emails).toHaveLength(9)
    expect(review.body.emails[0]).not.toHaveProperty('html')
    expect(review.body.finalization).toEqual({
      result: null,
      selectionLocked: false,
      status: 'active',
    })

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
      post(
        finalizationBody(first.body, {
          finalizeIds: [viewed.id],
          keepUnreadIds: [viewed.id],
        }),
        first.body.csrfToken,
      ),
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
    expect(filtered.body.emails).toHaveLength(8)

    const unfiltered = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    await json<FinalizeResult>(
      `/api/reviews/${unfiltered.body.snapshotId}/finalize`,
      post(
        finalizationBody(unfiltered.body, { finalizeIds: [viewed.id], keepUnreadIds: [] }),
        unfiltered.body.csrfToken,
      ),
    )
    const afterRead = await json<ReviewOptions>('/api/review/options')
    expect(afterRead.body.reviewedCount).toBe(0)
  })

  it('rejects an incomplete demo checkpoint before persistence or bundle analysis', async () => {
    const existingRunIds = new Set(roundStore.list().map((run) => run.id))
    const resumed = await json<{
      error: { code: string; details: { missingCount: number }; message: string }
    }>(
      '/api/reviews/resume',
      post({
        id: crypto.randomUUID(),
        emailIds: ['demo-human', 'missing-id', 'demo-train'],
        filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' },
      }),
    )

    expect(resumed.response.status).toBe(409)
    expect(resumed.body.error).toMatchObject({
      code: 'ROUND_SNAPSHOT_INCOMPLETE',
      details: { missingCount: 1 },
    })
    expect(resumed.body.error.message).toContain('Zwischenstand bleibt erhalten')
    await waitForApiJobs()
    expect(bundleDecisionCalls).toBe(0)
    expect(roundStore.list().filter((run) => !existingRunIds.has(run.id))).toEqual([])
  })

  it('makes a complete resumed snapshot ready and reanalyzable', async () => {
    bundleDecisionGate = new Promise<void>((resolve) => {
      releaseBundleDecision = resolve
    })
    const id = crypto.randomUUID()
    const resumed = await json<ReviewRunSummary>(
      '/api/reviews/resume',
      post({
        id,
        emailIds: ['demo-human', 'demo-train'],
        filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' },
      }),
    )
    expect(resumed.response.status).toBe(202)
    expect(resumed.body).toMatchObject({ emailCount: 2, id, status: 'analyzing' })
    const analyzing = await json<{ runs: ReviewRunSummary[] }>('/api/reviews')
    expect(analyzing.body.runs.find((run) => run.id === id)).toMatchObject({
      reanalyzable: false,
      status: 'analyzing',
    })

    releaseBundleDecision?.()
    await waitForApiJobs()
    const ready = await json<{ runs: ReviewRunSummary[] }>('/api/reviews')
    expect(ready.body.runs.find((run) => run.id === id)).toMatchObject({
      emailCount: 2,
      reanalyzable: true,
      status: 'ready',
    })
    const opened = await json<ReviewSnapshot>(`/api/reviews/${id}`)
    expect(opened.body.emails.map((email) => email.id)).toEqual(['demo-human', 'demo-train'])
    expect(opened.body.missingIds).toEqual([])
  })

  it('reuses one resumed round and analysis job for repeated requests with the same ID', async () => {
    bundleDecisionGate = new Promise<void>((resolve) => {
      releaseBundleDecision = resolve
    })
    const id = crypto.randomUUID()
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    const body = { id, emailIds: ['demo-human'], filters }
    const first = await json<ReviewRunSummary>('/api/reviews/resume', post(body))
    const repeated = await json<ReviewRunSummary>('/api/reviews/resume', post(body))

    expect(first.response.status).toBe(202)
    expect(repeated.response.status).toBe(202)
    expect(repeated.body).toMatchObject({
      csrfToken: first.body.csrfToken,
      emailCount: 1,
      id,
      status: 'analyzing',
    })
    expect(roundStore.list().filter((run) => run.id === id)).toHaveLength(1)

    for (const conflictBody of [
      { ...body, emailIds: ['demo-train'] },
      { ...body, filters: { ...filters, newsletter: 'exclude' as const } },
    ]) {
      const conflict = await json<{ error: { code: string } }>(
        '/api/reviews/resume',
        post(conflictBody),
      )
      expect(conflict.response.status).toBe(409)
      expect(conflict.body.error.code).toBe('ROUND_ID_CONFLICT')
    }

    releaseBundleDecision?.()
    await waitForApiJobs()
    expect(bundleDecisionCalls).toBe(1)
    expect(roundStore.get(id)).toMatchObject({ runStatus: 'ready' })
  })

  it('shares one snapshot fetch when the same resume ID arrives concurrently', async () => {
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    let snapshotCalls = 0
    let providerCalls = 0
    let snapshotStarted: (() => void) | undefined
    const snapshotStart = new Promise<void>((resolve) => {
      snapshotStarted = resolve
    })
    let releaseSnapshot: (() => void) | undefined
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const localMiddleware = createApiMiddleware({
      bundleDecider: async (input) => {
        providerCalls += 1
        return {
          currentState: 'Geprüft',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Eigenständige Nachricht.',
          title: input.seed[0]?.subject ?? 'Nachricht',
        }
      },
      fastmailToken: 'test-token',
      resumeMailSnapshot: async (_token, _ids, filters) => {
        snapshotCalls += 1
        snapshotStarted?.()
        await snapshotGate
        return {
          context: {
            accountId: 'account',
            apiUrl: 'https://api.example.invalid',
            downloadUrl: 'https://download.example.invalid',
            maxObjectsInGet: 256,
            maxObjectsInSet: 256,
            username: 'test@example.invalid',
          },
          emails: [source],
          filters,
          mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
          missingIds: [],
          totalBeforeLimit: 1,
          truncated: false,
        }
      },
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const id = crypto.randomUUID()
      const body = { id, emailIds: [source.id], filters: defaultReviewFilters }
      const first = fetch(`${localBase}/api/reviews/resume`, post(body))
      await snapshotStart
      const repeated = fetch(`${localBase}/api/reviews/resume`, post(body))
      const conflict = await fetch(
        `${localBase}/api/reviews/resume`,
        post({ ...body, emailIds: ['different-message'] }),
      )
      expect(conflict.status).toBe(409)
      expect((await conflict.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_ID_CONFLICT' },
      })

      releaseSnapshot?.()
      const responses = await Promise.all([first, repeated])
      expect(responses.map((response) => response.status)).toEqual([202, 202])
      const summaries = (await Promise.all(
        responses.map((response) => response.json()),
      )) as ReviewRunSummary[]
      expect(summaries[0]?.csrfToken).toBe(summaries[1]?.csrfToken)
      await waitForApiJobs()
      expect(snapshotCalls).toBe(1)
      expect(providerCalls).toBe(1)
      expect(localStore.list().filter((run) => run.id === id)).toHaveLength(1)
      expect(localStore.get(id)).toMatchObject({ runStatus: 'ready' })
    } finally {
      releaseSnapshot?.()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('rejects invalid resume IDs and empty or duplicate message snapshots', async () => {
    const existingRunIds = new Set(roundStore.list().map((run) => run.id))
    const cases = [
      {
        body: { id: 'not-a-uuid', emailIds: ['demo-human'], filters: defaultReviewFilters },
        code: 'INVALID_ROUND_ID',
      },
      {
        body: { id: crypto.randomUUID(), emailIds: [], filters: defaultReviewFilters },
        code: 'INVALID_RESUME',
      },
      {
        body: {
          id: crypto.randomUUID(),
          emailIds: ['demo-human', 'demo-human'],
          filters: defaultReviewFilters,
        },
        code: 'INVALID_RESUME',
      },
      {
        body: { id: crypto.randomUUID(), emailIds: ['   '], filters: defaultReviewFilters },
        code: 'INVALID_RESUME',
      },
    ]

    for (const invalid of cases) {
      const response = await json<{ error: { code: string } }>(
        '/api/reviews/resume',
        post(invalid.body),
      )
      expect(response.response.status).toBe(400)
      expect(response.body.error.code).toBe(invalid.code)
    }
    expect(roundStore.list().filter((run) => !existingRunIds.has(run.id))).toEqual([])
    expect(bundleDecisionCalls).toBe(0)
  })

  it('rejects an incomplete live checkpoint before persistence or Codex work', async () => {
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    let providerCalls = 0
    const localMiddleware = createApiMiddleware({
      bundleDecider: async () => {
        providerCalls += 1
        throw new Error('Provider must not be called for an incomplete snapshot')
      },
      fastmailToken: 'test-token',
      resumeMailSnapshot: async (_token, _ids, filters) => ({
        context: {
          accountId: 'account',
          apiUrl: 'https://api.example.invalid',
          downloadUrl: 'https://download.example.invalid',
          maxObjectsInGet: 256,
          maxObjectsInSet: 256,
          username: 'test@example.invalid',
        },
        emails: [source],
        filters,
        mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
        missingIds: ['missing-live-message'],
        totalBeforeLimit: 2,
        truncated: false,
      }),
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/reviews/resume`,
        post({
          id: crypto.randomUUID(),
          emailIds: [source.id, 'missing-live-message'],
          filters: {
            hideReviewed: false,
            mailboxId: null,
            newsletter: 'all',
            spam: 'exclude',
            timeRange: 'all',
          },
        }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_SNAPSHOT_INCOMPLETE' },
      })
      await waitForApiJobs()
      expect(providerCalls).toBe(0)
      expect(localStore.list()).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('quarantines a historically persisted ready round with missing snapshot messages', async () => {
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    localStore.create({
      analysis: {
        callCount: 1,
        engine: 'codex',
        phase: 'complete',
        processedEmailCount: 1,
        progress: 1,
        status: 'complete',
        totalEmailCount: 1,
      },
      csrfToken: 'incomplete-history-csrf',
      emails: [source],
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 3,
      id: 'incomplete-history-round',
      imageToken: 'incomplete-history-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      missingIds: ['missing-history-message'],
      mode: 'demo',
      runStatus: 'ready',
      totalBeforeLimit: 2,
    })
    let providerCalls = 0
    const localMiddleware = createApiMiddleware({
      bundleDecider: async () => {
        providerCalls += 1
        throw new Error('Incomplete historical rounds must never run analysis')
      },
      forceDemo: true,
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const listed = (await (await fetch(`${localBase}/api/reviews`)).json()) as {
        runs: ReviewRunSummary[]
      }
      expect(listed.runs).toEqual([
        expect.objectContaining({
          id: 'incomplete-history-round',
          reanalyzable: false,
          status: 'failed',
        }),
      ])
      expect(listed.runs[0]?.analysis.error).toContain('Zwischenstand bleibt erhalten')

      for (const path of [
        '/api/reviews/incomplete-history-round',
        `/api/reviews/incomplete-history-round/emails/${source.id}`,
      ]) {
        const gated = await fetch(`${localBase}${path}`)
        expect(gated.status).toBe(409)
        expect(((await gated.json()) as { error: { code: string } }).error.code).toBe(
          'ROUND_SNAPSHOT_INCOMPLETE',
        )
      }
      const reanalyzed = await fetch(
        `${localBase}/api/reviews/incomplete-history-round/reanalyze`,
        post({}, 'incomplete-history-csrf'),
      )
      expect(reanalyzed.status).toBe(409)
      expect(((await reanalyzed.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_SNAPSHOT_INCOMPLETE',
      )
      const finalized = await fetch(
        `${localBase}/api/reviews/incomplete-history-round/finalize`,
        post({}, 'incomplete-history-csrf'),
      )
      expect(finalized.status).toBe(409)
      expect(((await finalized.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_SNAPSHOT_INCOMPLETE',
      )

      await waitForApiJobs()
      expect(providerCalls).toBe(0)
      expect(localStore.get('incomplete-history-round')).toMatchObject({
        emails: [expect.objectContaining({ id: source.id })],
        generation: 3,
        missingIds: ['missing-history-message'],
        runStatus: 'failed',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('loads the same persisted round ID and tokens after the RAM cache is cleared', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)

    expect(restored.response.status).toBe(200)
    expect(restored.body).toMatchObject({
      csrfToken: created.body.csrfToken,
      imageToken: created.body.imageToken,
      snapshotId: created.body.snapshotId,
    })
    expect(restored.body.emails.map((email) => email.id)).toEqual(
      created.body.emails.map((email) => email.id),
    )
  })

  it('freezes cleaned learning examples when the API creates a round', async () => {
    const privateSignal = 'provider:private-api-signal'
    availableBundleExamples = [
      {
        anchorSignals: [privateSignal],
        candidateSignals: ['thread:private-api-thread'],
        correct: true,
        reason: 'Private API reason.',
      },
    ]
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const frozen = roundStore.get(created.body.snapshotId)?.bundleExamples

    expect(frozen).toEqual([
      {
        anchorSignals: [hashLearningSignal(privateSignal)],
        candidateSignals: [hashLearningSignal('thread:private-api-thread')],
        correct: true,
        reason: 'Vom Nutzer im Review bestätigt.',
      },
    ])
    availableBundleExamples = [
      {
        anchorSignals: ['provider:later-signal'],
        candidateSignals: ['thread:later-thread'],
        correct: false,
        reason: 'Later reason.',
      },
    ]
    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)

    expect(restored.response.status).toBe(200)
    expect(roundStore.get(created.body.snapshotId)?.bundleExamples).toEqual(frozen)
  })

  it('starts bundle analysis without blocking and never reruns a persisted result', async () => {
    bundleDecisionGate = new Promise<void>((resolve) => {
      releaseBundleDecision = resolve
    })
    const createdResponse = await fetch(
      `${baseUrl}/api/reviews`,
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const created = (await createdResponse.json()) as ReviewRunSummary

    expect(createdResponse.status).toBe(202)
    expect(created).toMatchObject({ reanalyzable: false, status: 'queued' })
    releaseBundleDecision?.()
    await waitForApiJobs()
    const completed = await json<ReviewSnapshot>(`/api/reviews/${created.id}`)
    const callsAfterCompletion = bundleDecisionCalls
    expect(callsAfterCompletion).toBeGreaterThan(0)
    expect(completed.body.bundleRun).toBeDefined()

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.id}`)
    expect(restored.body.analysis.status).toBe('complete')
    const restarted = await json<ReviewSnapshot>(
      `/api/reviews/${created.id}/bundles`,
      post({}, created.csrfToken),
    )
    expect(restarted.response.status).toBe(200)
    expect(restarted.body.bundleRun).toEqual(completed.body.bundleRun)
    expect(bundleDecisionCalls).toBe(callsAfterCompletion)
  })

  it('keeps the process alive when background bundle analysis fails', async () => {
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const localStore = createRoundStore(':memory:')
    const localMiddleware = createApiMiddleware({
      autoStartBundles: true,
      bundleDecider: async () => {
        throw new Error('Primary bundle analysis failed')
      },
      demoMessages: [
        source,
        {
          ...source,
          id: `${source.id}-related`,
          messageId: [`${source.id}-related@example.test`],
        },
      ],
      forceDemo: true,
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const created = (await (
        await fetch(
          `${localBase}/api/reviews`,
          post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
        )
      ).json()) as ReviewRunSummary

      await waitForApiJobs()
      expect(localStore.get(created.id)).toMatchObject({
        bundleRun: null,
        runStatus: 'failed',
      })
      expect(localStore.get(created.id)?.analysis).toMatchObject({
        phase: 'failed',
        status: 'pending',
      })
      const gated = await fetch(`${localBase}/api/reviews/${created.id}`)
      expect(gated.status).toBe(409)
      expect(((await gated.json()) as { error: { code: string } }).error.code).toBe(
        'ROUND_NOT_READY',
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('resumes a persisted unfinished analysis with demo details when the run list is loaded', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'waiting',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
        totalEmailCount: demoEmails.length,
      },
      csrfToken: 'recovery-csrf',
      emails: demoEmails,
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      id: 'pending-recovery-round',
      imageToken: 'recovery-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'demo',
      generation: 1,
      runStatus: 'analyzing',
    })
    let releaseDecision: (() => void) | undefined
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve
    })
    let decisionCalls = 0
    const localMiddleware = createApiMiddleware({
      autoStartBundles: true,
      bundleDecider: async () => {
        decisionCalls += 1
        await decisionGate
        return {
          currentState: 'Geprüft',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Persistierte Recovery-Entscheidung.',
          title: 'Recovery',
        }
      },
      demoMessages: demoEmails,
      forceDemo: true,
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const listedResponse = await fetch(`${localBase}/api/reviews`)
      expect(listedResponse.status).toBe(200)
      for (let attempt = 0; attempt < 50 && decisionCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(decisionCalls).toBeGreaterThan(0)

      releaseDecision?.()
      await waitForApiJobs()
      const completed = (await (
        await fetch(`${localBase}/api/reviews/pending-recovery-round`)
      ).json()) as ReviewSnapshot
      expect(completed.analysis.status).toBe('complete')
      expect(completed.bundleRun).toBeDefined()
      const source = demoEmails[0]
      expect(source).toBeDefined()
      if (!source) return
      const detailResponse = await fetch(
        `${localBase}/api/reviews/pending-recovery-round/emails/${source.id}`,
      )
      expect(detailResponse.status).toBe(200)
      expect(((await detailResponse.json()) as ReviewEmail).text).toBe(source.text)
      const callsAfterCompletion = decisionCalls

      clearApiStateForTests()
      const reopened = (await (
        await fetch(`${localBase}/api/reviews/pending-recovery-round`)
      ).json()) as ReviewSnapshot
      expect(reopened.analysis.status).toBe('complete')
      expect(decisionCalls).toBe(callsAfterCompletion)
    } finally {
      releaseDecision?.()
      await waitForApiJobs()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('sends the complete live snapshot through one global partition call and replays the persisted run after restart', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const summaries = Array.from({ length: 379 }, (_, index) => ({
      from: source.from,
      hasAttachment: false,
      id: `global-partition-${index.toString().padStart(3, '0')}`,
      isNewsletter: false,
      mailboxNames: ['Inbox'],
      preview: `Global partition preview ${index}`,
      receivedAt: new Date(Date.parse(source.receivedAt) + index * 1_000).toISOString(),
      subject: `Global partition subject ${index}`,
      threadId: `global-partition-thread-${index}`,
      to: source.to,
    }))
    const expectedIds = summaries.map((email) => email.id)
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'waiting',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
        totalEmailCount: summaries.length,
      },
      csrfToken: 'global-partition-csrf',
      emails: summaries,
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 1,
      id: 'global-partition-round',
      imageToken: 'global-partition-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    let providerCalls = 0
    const observedInputIds: string[][] = []
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      bundlePartitionDecider: async (input) => {
        providerCalls += 1
        observedInputIds.push(input.emails.map((email) => email.id))
        return {
          standaloneEmailIds: expectedIds.slice(2),
          stories: [
            {
              currentState: 'Zusammengehörige Nachrichten erkannt',
              emailIds: expectedIds.slice(0, 2),
              kind: 'conversation',
              linkEvidence: ['Gleicher konkreter Vorgang'],
              membershipConfidence: 1,
              summary: 'Die ersten beiden Nachrichten bilden einen konkreten Vorgang.',
              title: 'Global erkannter Vorgang',
            },
          ],
        }
      },
      codexAuthStatus: () => ({
        configured: true,
        model: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      }),
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const started = await fetch(
        `${localBase}/api/reviews/global-partition-round/bundles`,
        post({}, 'global-partition-csrf'),
      )
      expect(started.status).toBe(202)
      await waitForApiJobs()

      expect(providerCalls).toBe(1)
      expect(observedInputIds).toEqual([expectedIds])
      const persisted = localStore.get('global-partition-round')
      expect(persisted).toMatchObject({
        analysis: { callCount: 1, status: 'complete' },
        runStatus: 'ready',
      })
      expect(persisted?.bundleRun).toBeDefined()

      clearApiStateForTests()
      const reopenedResponse = await fetch(`${localBase}/api/reviews/global-partition-round`)
      expect(reopenedResponse.status).toBe(200)
      const reopened = (await reopenedResponse.json()) as ReviewSnapshot
      expect(reopened.analysis).toMatchObject({ callCount: 1, status: 'complete' })
      expect(reopened.bundleRun).toEqual(persisted?.bundleRun)
      expect(providerCalls).toBe(1)
      expect(observedInputIds).toEqual([expectedIds])
    } finally {
      await waitForApiJobs()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('keeps a concurrent reanalysis generation authoritative during stale snapshot recovery', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const roundId = 'stale-snapshot-recovery-round'
    localStore.create({
      analysis: {
        callCount: 1,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'deciding',
        processedEmailCount: 0,
        progress: 0.15,
        status: 'running',
        thinkingLevel: 'high',
        totalEmailCount: 1,
      },
      csrfToken: 'stale-snapshot-recovery-csrf',
      emails: [source],
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      generation: 1,
      id: roundId,
      imageToken: 'stale-snapshot-recovery-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
      runStatus: 'ready',
    })

    let reanalysisStarted = false
    const analysisWriteGenerations: Array<number | undefined> = []
    const runStatusWriteGenerations: number[] = []
    const racingStore = {
      ...localStore,
      updateAnalysis: (...args: Parameters<(typeof localStore)['updateAnalysis']>) => {
        analysisWriteGenerations.push(args[2])
        if (!reanalysisStarted && args[0] === roundId && args[1].phase === 'waiting') {
          reanalysisStarted = true
          expect(
            localStore.reanalyze(roundId, {
              callCount: 0,
              engine: 'codex',
              error: null,
              model: 'gpt-5.6-sol',
              phase: 'indexing',
              processedEmailCount: 0,
              progress: 0,
              status: 'pending',
              thinkingLevel: 'high',
              totalEmailCount: 1,
            }),
          ).toMatchObject({
            analysis: { phase: 'indexing', status: 'pending' },
            generation: 2,
            runStatus: 'analyzing',
          })
        }
        return localStore.updateAnalysis(...args)
      },
      updateRunStatus: (...args: Parameters<(typeof localStore)['updateRunStatus']>) => {
        runStatusWriteGenerations.push(args[1])
        return localStore.updateRunStatus(...args)
      },
    }
    const localMiddleware = createApiMiddleware({
      autoStartBundles: true,
      codexAuthStatus: () => ({
        configured: false,
        model: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      }),
      roundStore: racingStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`

      const restoredResponse = await fetch(`${localBase}/api/reviews/${roundId}`)
      expect(restoredResponse.status).toBe(200)
      expect((await restoredResponse.json()) as ReviewSnapshot).toMatchObject({
        analysis: { phase: 'waiting_for_codex', status: 'pending' },
        snapshotId: roundId,
      })
      await waitForApiJobs()

      const resumedResponse = await fetch(`${localBase}/api/reviews`)
      expect(resumedResponse.status).toBe(200)
      await waitForApiJobs()

      expect(reanalysisStarted).toBe(true)
      expect(analysisWriteGenerations).toEqual([1])
      expect(runStatusWriteGenerations).toEqual([1, 2])
      expect(localStore.get(roundId)).toMatchObject({
        analysis: {
          callCount: 0,
          phase: 'waiting_for_codex',
          progress: 0,
          status: 'pending',
        },
        bundleRun: null,
        generation: 2,
        runStatus: 'failed',
      })
      expect(localStore.get(roundId)?.analysis.error).toContain('erneut verbunden')
    } finally {
      await waitForApiJobs()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('keeps an unfinished Codex analysis pending when its login is unavailable', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const secondSource = {
      ...source,
      id: `${source.id}-second`,
      receivedAt: new Date(Date.parse(source.receivedAt) + 1_000).toISOString(),
      subject: `${source.subject} · zweite Nachricht`,
      threadId: `${source.threadId}-second`,
    }
    localStore.create({
      analysis: {
        callCount: 2,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'deciding',
        processedEmailCount: 0,
        progress: 0.2,
        status: 'running',
        totalEmailCount: 2,
      },
      csrfToken: 'restart-csrf',
      emails: [source, secondSource].map((email) => ({
        from: email.from,
        hasAttachment: email.hasAttachment,
        id: email.id,
        isNewsletter: email.isNewsletter,
        mailboxNames: email.mailboxNames,
        preview: email.preview,
        receivedAt: email.receivedAt,
        subject: email.subject,
        threadId: email.threadId,
        to: email.to,
      })),
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      id: 'live-restart-round',
      imageToken: 'restart-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    const localMiddleware = createApiMiddleware({
      codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const restoredResponse = await fetch(`${localBase}/api/reviews/live-restart-round`)
      const restored = (await restoredResponse.json()) as ReviewSnapshot
      expect(restoredResponse.status).toBe(200)
      expect(restored.snapshotId).toBe('live-restart-round')
      const started = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles`,
        post({}, 'restart-csrf'),
      )
      expect(started.status).toBe(202)
      const current = (await started.json()) as ReviewSnapshot
      expect(current).toMatchObject({
        analysis: {
          callCount: 2,
          engine: 'codex',
          phase: 'waiting_for_codex',
          status: 'pending',
        },
      })
      expect(current.analysis.error).toContain('erneut verbunden')
      expect(current.bundleRun).toBeUndefined()

      const removedFallback = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles/fallback`,
        post({}, 'restart-csrf'),
      )
      expect(removedFallback.status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('reuses the frozen Codex inputs and checkpoints after restart', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const summaries = [
      { id: 'auth-a-1', threadId: 'auth-thread-a', subject: 'alphaquartz', preview: 'alphaquartz' },
      { id: 'auth-a-2', threadId: 'auth-thread-a', subject: 'alphaquartz', preview: 'alphaquartz' },
      { id: 'auth-b-1', threadId: 'auth-thread-b', subject: 'betajuniper', preview: 'betajuniper' },
      { id: 'auth-b-2', threadId: 'auth-thread-b', subject: 'betajuniper', preview: 'betajuniper' },
    ].map((item, index) => ({
      from: source.from,
      hasAttachment: false,
      isNewsletter: false,
      mailboxNames: ['Inbox'],
      receivedAt: `2026-08-30T10:0${index}:00.000Z`,
      to: source.to,
      ...item,
    }))
    let globalExamples: BundleExample[] = [
      {
        anchorSignals: ['provider:initial-anchor'],
        candidateSignals: ['provider:initial-candidate'],
        correct: false,
        reason: 'Initial private reason.',
      },
    ]
    localStore.create({
      analysis: {
        callCount: 0,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'waiting',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
        totalEmailCount: summaries.length,
      },
      bundleExamples: globalExamples,
      csrfToken: 'auth-resume-csrf',
      emails: summaries,
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      id: 'auth-resume-round',
      imageToken: 'auth-resume-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    let providerCalls = 0
    let globalExampleReads = 0
    let failAuthentication = true
    const observedExamples: BundleExample[][] = []
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      bundleDecider: async (input) => {
        providerCalls += 1
        observedExamples.push(input.examples)
        if (failAuthentication && providerCalls === 2) throw new CodexAuthenticationError()
        return {
          currentState: 'Geprüft',
          includedEmailIds: [],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: 'Getrennte Story.',
          title: 'Getrennt',
        }
      },
      bundleStore: {
        examples: () => {
          globalExampleReads += 1
          return globalExamples
        },
        record: () => {},
      },
      codexAuthStatus: () => ({ configured: true, model: 'gpt-5.6-sol' }),
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const start = await fetch(
        `${localBase}/api/reviews/auth-resume-round/bundles`,
        post({}, 'auth-resume-csrf'),
      )
      expect(start.status).toBe(202)
      await waitForApiJobs()

      const waiting = (await (
        await fetch(`${localBase}/api/reviews/auth-resume-round`)
      ).json()) as ReviewSnapshot
      expect(waiting).toMatchObject({
        analysis: {
          callCount: 1,
          engine: 'codex',
          model: 'gpt-5.6-sol',
          phase: 'waiting_for_codex',
          status: 'pending',
        },
        snapshotId: 'auth-resume-round',
      })
      expect(waiting.bundleRun).toBeUndefined()

      const frozenExamples = localStore.get('auth-resume-round')?.bundleExamples ?? []
      expect(frozenExamples).toHaveLength(1)
      expect(observedExamples).toEqual([frozenExamples, frozenExamples])
      globalExamples = [
        {
          anchorSignals: ['provider:changed-anchor'],
          candidateSignals: ['provider:changed-candidate'],
          correct: true,
          reason: 'Changed private reason.',
        },
      ]
      failAuthentication = false
      clearApiStateForTests()
      const resumed = await fetch(
        `${localBase}/api/reviews/auth-resume-round/bundles`,
        post({}, 'auth-resume-csrf'),
      )
      expect(resumed.status).toBe(202)
      await waitForApiJobs()
      expect(providerCalls).toBe(3)
      expect(globalExampleReads).toBe(0)
      expect(observedExamples).toEqual([frozenExamples, frozenExamples, frozenExamples])
      expect(observedExamples.flat()).not.toEqual(expect.arrayContaining(globalExamples))

      clearApiStateForTests()
      const completed = (await (
        await fetch(`${localBase}/api/reviews/auth-resume-round`)
      ).json()) as ReviewSnapshot
      expect(completed.analysis).toMatchObject({
        callCount: 2,
        engine: 'codex',
        model: 'gpt-5.6-sol',
        phase: 'complete',
        status: 'complete',
      })
      expect(completed.analysis).not.toHaveProperty('error')
      expect(completed.bundleRun).toBeDefined()
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('persists decisions with an optimistic revision and rejects a stale tab', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const emailId = created.body.emails[0]?.id
    expect(emailId).toBeDefined()
    if (!emailId) return
    const state = {
      bundleGroups: [],
      index: 0,
      keptUnreadIds: [emailId],
      processedIds: [emailId],
      replyDrafts: {},
      secondaryActionIds: [],
      selectedMemberId: emailId,
    }
    const first = await json<ReviewSnapshot['userState']>(
      `/api/reviews/${created.body.snapshotId}/state`,
      post({ revision: 0, state }, created.body.csrfToken),
    )
    expect(first.body.revision).toBe(1)
    const stale = await json<{ error: { code: string; details: { actualRevision: number } } }>(
      `/api/reviews/${created.body.snapshotId}/state`,
      post({ revision: 0, state: { ...state, keptUnreadIds: [] } }, created.body.csrfToken),
    )
    expect(stale.response.status).toBe(409)
    expect(stale.body.error).toMatchObject({
      code: 'ROUND_REVISION_CONFLICT',
      details: { actualRevision: 1 },
    })

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)
    expect(restored.body.userState).toMatchObject({
      keptUnreadIds: [emailId],
      processedIds: [emailId],
      revision: 1,
    })
  })

  it('persists incomplete recipient input but rejects it at draft creation', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const emailId = created.body.emails.find((email) => email.id === 'demo-human')?.id
    expect(emailId).toBeDefined()
    if (!emailId) return
    const replyEditor = {
      bodyText: 'Antworttext',
      cc: [{ name: '', email: 'team@' }],
      identityId: 'demo-identity',
      revisionInstruction: '',
      roughNotes: '',
      subject: 'Re: Test',
      to: [{ name: '', email: 'alex@' }],
    }
    const state = await json<ReviewSnapshot['userState']>(
      `/api/reviews/${created.body.snapshotId}/state`,
      post(
        {
          revision: 0,
          state: {
            bundleGroups: [],
            index: 0,
            keptUnreadIds: [],
            processedIds: [],
            replyDrafts: { [emailId]: replyEditor },
            secondaryActionIds: [],
            selectedMemberId: emailId,
          },
        },
        created.body.csrfToken,
      ),
    )
    expect(state.response.status).toBe(200)

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)
    expect(restored.body.userState.replyDrafts[emailId]).toEqual(replyEditor)

    const draft = await json<{ error: { code: string } }>(
      `/api/reviews/${created.body.snapshotId}/drafts`,
      post(
        {
          bodyText: replyEditor.bodyText,
          cc: replyEditor.cc,
          emailId,
          identityId: replyEditor.identityId,
          requestId: crypto.randomUUID(),
          subject: replyEditor.subject,
          to: replyEditor.to,
        },
        restored.body.csrfToken,
      ),
    )
    expect(draft.response.status).toBe(400)
    expect(draft.body.error.code).toBe('INVALID_DRAFT')
  })

  it('does not let a stale tab finalize over newer persisted decisions', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const [firstId, secondId] = created.body.emails.map((email) => email.id)
    expect(firstId).toBeDefined()
    expect(secondId).toBeDefined()
    if (!firstId || !secondId) return
    const winnerState = {
      bundleGroups: [],
      index: 0,
      keptUnreadIds: [firstId],
      processedIds: [firstId],
      replyDrafts: {},
      secondaryActionIds: [],
      selectedMemberId: firstId,
    }
    const winner = await json<ReviewSnapshot['userState']>(
      `/api/reviews/${created.body.snapshotId}/state`,
      post({ revision: 0, state: winnerState }, created.body.csrfToken),
    )
    expect(winner.body.revision).toBe(1)

    const staleFinalize = await json<{ error: { code: string; details: unknown } }>(
      `/api/reviews/${created.body.snapshotId}/finalize`,
      post(
        {
          finalizeIds: [secondId],
          keepUnreadIds: [],
          revision: 0,
          secondaryActionIds: [],
        },
        created.body.csrfToken,
      ),
    )
    expect(staleFinalize.response.status).toBe(409)
    expect(staleFinalize.body.error.code).toBe('ROUND_REVISION_CONFLICT')
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)
    expect(restored.body.finalization.status).toBe('active')
    expect(restored.body.userState).toMatchObject(winner.body)
  })

  it('rejects a slow state upload when another request finalizes before its write', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const emailId = created.body.emails[0]?.id
    expect(emailId).toBeDefined()
    if (!emailId) return
    const payload = JSON.stringify({
      revision: created.body.userState.revision,
      state: {
        bundleGroups: [],
        index: 0,
        keptUnreadIds: [emailId],
        processedIds: [emailId],
        replyDrafts: {},
        secondaryActionIds: [],
        selectedMemberId: emailId,
      },
    })
    let slowRequest: ReturnType<typeof httpRequest> | undefined
    const slowResponse = new Promise<{ body: { error: { code: string } }; status: number }>(
      (resolve, reject) => {
        slowRequest = httpRequest(
          `${baseUrl}/api/reviews/${created.body.snapshotId}/state`,
          {
            method: 'POST',
            headers: {
              'Content-Length': Buffer.byteLength(payload),
              'Content-Type': 'application/json',
              'X-Inbox-Walk-CSRF': created.body.csrfToken,
            },
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            response.on('end', () =>
              resolve({
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                  error: { code: string }
                },
                status: response.statusCode ?? 0,
              }),
            )
          },
        )
        slowRequest.on('error', reject)
      },
    )
    slowRequest?.write(payload.slice(0, 1))
    await new Promise((resolve) => setTimeout(resolve, 25))

    const finalized = await json<FinalizeResult>(
      `/api/reviews/${created.body.snapshotId}/finalize`,
      post(
        finalizationBody(created.body, { finalizeIds: [emailId], keepUnreadIds: [] }),
        created.body.csrfToken,
      ),
    )
    expect(finalized.response.status).toBe(200)
    slowRequest?.end(payload.slice(1))

    await expect(slowResponse).resolves.toMatchObject({
      body: { error: { code: 'ROUND_FINALIZED' } },
      status: 409,
    })
  })

  it('does not delete a round while a draft request body is still arriving', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const email = created.body.emails[0]
    expect(email).toBeDefined()
    if (!email) return
    const context = await json<ThreadContext>(
      `/api/reviews/${created.body.snapshotId}/threads/${email.threadId}?emailId=${email.id}`,
    )
    const payload = JSON.stringify({
      bodyText: 'Antworttext',
      cc: context.body.recipients.cc,
      emailId: email.id,
      identityId: context.body.recipients.identityId,
      requestId: crypto.randomUUID(),
      subject: context.body.recipients.subject,
      to: context.body.recipients.to,
    })
    let slowRequest: ReturnType<typeof httpRequest> | undefined
    const slowResponse = new Promise<{ status: number }>((resolve, reject) => {
      slowRequest = httpRequest(
        `${baseUrl}/api/reviews/${created.body.snapshotId}/drafts`,
        {
          method: 'POST',
          headers: {
            'Content-Length': Buffer.byteLength(payload),
            'Content-Type': 'application/json',
            'X-Inbox-Walk-CSRF': created.body.csrfToken,
          },
        },
        (response) => {
          response.resume()
          response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
        },
      )
      slowRequest.on('error', reject)
    })
    slowRequest?.write(payload.slice(0, 1))
    await new Promise((resolve) => setTimeout(resolve, 25))

    const blocked = await fetch(`${baseUrl}/api/reviews/${created.body.snapshotId}`, {
      method: 'DELETE',
      headers: { 'X-Inbox-Walk-CSRF': created.body.csrfToken },
    })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ROUND_DRAFT_IN_PROGRESS' },
    })
    expect(roundStore.get(created.body.snapshotId)).not.toBeNull()

    const reanalysis = await fetch(
      `${baseUrl}/api/reviews/${created.body.snapshotId}/reanalyze`,
      post({}, created.body.csrfToken),
    )
    expect(reanalysis.status).toBe(409)
    expect((await reanalysis.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ROUND_DRAFT_IN_PROGRESS' },
    })

    slowRequest?.end(payload.slice(1))
    await expect(slowResponse).resolves.toMatchObject({ status: 201 })
    const deleted = await fetch(`${baseUrl}/api/reviews/${created.body.snapshotId}`, {
      method: 'DELETE',
      headers: { 'X-Inbox-Walk-CSRF': created.body.csrfToken },
    })
    expect(deleted.status).toBe(204)
  })

  it('requires the snapshot CSRF token for mutations', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const rejected = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post(
        finalizationBody(review.body, {
          finalizeIds: [review.body.emails[0]?.id],
          keepUnreadIds: [],
        }),
      ),
    )
    expect(rejected.response.status).toBe(403)
    expect(rejected.body.error.code).toBe('INVALID_CSRF')
  })

  it('builds an exact bundle partition', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const completed = await waitForBundles(review.body)
    const run = completed.bundleRun
    if (!run) return
    const bundledIds = run.bundles.flatMap((bundle) => bundle.emailIds)
    expect(new Set(bundledIds)).toEqual(new Set(review.body.emails.map((email) => email.id)))
    expect(bundledIds).toHaveLength(review.body.emails.length)
    expect(
      run.bundles.find((bundle) => bundle.emailIds.includes('demo-github-merged'))?.emailIds,
    ).toEqual(
      expect.arrayContaining([
        'demo-github-opened',
        'demo-github-merged',
        'demo-railway-failed',
        'demo-railway-success',
      ]),
    )
  })

  it('fails the background run closed when a bundle decision injects an unknown ID', async () => {
    injectUnknownBundleId = true
    const response = await fetch(
      `${baseUrl}/api/reviews`,
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const created = (await response.json()) as ReviewRunSummary
    expect(response.status).toBe(202)

    await waitForApiJobs()
    const failed = roundStore.get(created.id)
    expect(failed).toMatchObject({ bundleRun: null, runStatus: 'failed' })
    expect(failed?.analysis.error).toContain('nicht sicher bestimmt')
    expect(failed?.emails.map((email) => email.id)).not.toContain('outside-frozen-snapshot')

    const deleted = await fetch(`${baseUrl}/api/reviews/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Inbox-Walk-CSRF': created.csrfToken },
    })
    expect(deleted.status).toBe(204)
  })

  it('reports provider context exhaustion as an actionable failed run', async () => {
    bundleDecisionFailure = new CodexContextLengthError()
    const response = await fetch(
      `${baseUrl}/api/reviews`,
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const created = (await response.json()) as ReviewRunSummary
    expect(response.status).toBe(202)

    await waitForApiJobs()
    const failed = roundStore.get(created.id)
    expect(failed).toMatchObject({ bundleRun: null, runStatus: 'failed' })
    expect(failed?.analysis.error).toContain('Kontextfenster')
    expect(failed?.analysis.error).toContain('kleineren Zeitraum')
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

    const requestId = crypto.randomUUID()
    const draftRequest = () =>
      json<DraftResult>(
        `/api/reviews/${review.body.snapshotId}/drafts`,
        post(
          {
            requestId,
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
    const drafts = await Promise.all([draftRequest(), draftRequest()])
    expect(drafts.map((draft) => draft.response.status).sort()).toEqual([200, 201])
    expect(drafts[0]?.body).toEqual(drafts[1]?.body)
    expect(drafts[0]?.body.verified).toBe(true)

    const conflictingDraft = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/drafts`,
      post(
        {
          requestId,
          emailId: email.id,
          identityId: context.body.recipients.identityId,
          to: context.body.recipients.to,
          cc: context.body.recipients.cc,
          subject: context.body.recipients.subject,
          bodyText: `${proposal.body.bodyText}\nVeränderter Inhalt`,
        },
        review.body.csrfToken,
      ),
    )
    expect(conflictingDraft.response.status).toBe(409)
    expect(conflictingDraft.body.error.code).toBe('DRAFT_REQUEST_CONFLICT')

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
      post(
        finalizationBody(review.body, { finalizeIds: [keptId], keepUnreadIds: [keptId] }),
        review.body.csrfToken,
      ),
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
        finalizationBody(review.body, {
          finalizeIds: review.body.emails.map((email) => email.id),
          keepUnreadIds: [],
        }),
        review.body.csrfToken,
      ),
    )
    expect(changed.response.status).toBe(409)
    expect(changed.body.error.code).toBe('FINALIZE_SELECTION_LOCKED')
  })

  it('does not finalize when the durable selection lock cannot be stored', async () => {
    const localStore = createRoundStore(':memory:')
    const failingStore = {
      ...localStore,
      saveFinalization: () => null,
    }
    const localMiddleware = createApiMiddleware({
      forceDemo: true,
      roundStore: failingStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const createdResponse = await fetch(
        `${localBase}/api/reviews`,
        post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
      )
      const run = (await createdResponse.json()) as ReviewRunSummary
      await waitForApiJobs()
      const created = (await (
        await fetch(`${localBase}/api/reviews/${run.id}`)
      ).json()) as ReviewSnapshot
      const emailId = created.emails[0]?.id
      expect(emailId).toBeDefined()
      if (!emailId) return
      const failedResponse = await fetch(
        `${localBase}/api/reviews/${created.snapshotId}/finalize`,
        post(
          finalizationBody(created, { finalizeIds: [emailId], keepUnreadIds: [] }),
          created.csrfToken,
        ),
      )
      expect(failedResponse.status).toBe(503)
      expect((await failedResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_PERSIST_FAILED' },
      })
      const restored = (await (
        await fetch(`${localBase}/api/reviews/${created.snapshotId}`)
      ).json()) as ReviewSnapshot
      expect(restored.finalization.status).toBe('active')
      expect(restored.userState.processedIds).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('leaves no selection lock when live mailbox context fails before the first mutation', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    localStore.create({
      csrfToken: 'context-failure-csrf',
      emails: [source],
      filters: {
        hideReviewed: false,
        mailboxId: null,
        newsletter: 'all',
        spam: 'exclude',
        timeRange: 'all',
      },
      id: 'context-failure-round',
      imageToken: 'context-failure-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
      fastmailToken: 'test-fastmail-token',
      resumeMailSnapshot: async () => {
        throw new Error('Fastmail context unavailable')
      },
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const failed = await fetch(
        `${localBase}/api/reviews/context-failure-round/finalize`,
        post({ finalizeIds: [source.id], keepUnreadIds: [], revision: 0 }, 'context-failure-csrf'),
      )
      expect(failed.status).toBe(500)

      clearApiStateForTests()
      const restored = (await (
        await fetch(`${localBase}/api/reviews/context-failure-round`)
      ).json()) as ReviewSnapshot
      expect(restored.finalization).toEqual({
        result: null,
        selectionLocked: false,
        status: 'active',
      })
      expect(localStore.get('context-failure-round')?.finalization).toMatchObject({
        finalizeIds: [],
        keepUnreadIds: [],
        secondaryActionIds: [],
        state: 'active',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('rechecks the revision after live context loading before locking finalization', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    localStore.create({
      csrfToken: 'context-race-csrf',
      emails: [source],
      filters,
      id: 'context-race-round',
      imageToken: 'context-race-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    let releaseContext: (() => void) | undefined
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve
    })
    let contextStarted: (() => void) | undefined
    const contextStart = new Promise<void>((resolve) => {
      contextStarted = resolve
    })
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
      fastmailToken: 'test-fastmail-token',
      markRead: async (_context, _token, ids) => ({ failed: [], markedIds: [...ids] }),
      resumeMailSnapshot: async () => {
        contextStarted?.()
        await contextGate
        return {
          context: {
            accountId: 'account',
            apiUrl: 'https://jmap.invalid.test',
            downloadUrl: 'https://jmap.invalid.test/{blobId}',
            maxObjectsInGet: 100,
            maxObjectsInSet: 100,
            username: 'test@example.test',
          },
          emails: [source],
          filters,
          mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
          missingIds: [],
          totalBeforeLimit: 1,
          truncated: false,
        }
      },
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const finalizing = fetch(
        `${localBase}/api/reviews/context-race-round/finalize`,
        post({ finalizeIds: [source.id], keepUnreadIds: [], revision: 0 }, 'context-race-csrf'),
      )
      await contextStart
      const newerState = await fetch(
        `${localBase}/api/reviews/context-race-round/state`,
        post(
          {
            revision: 0,
            state: {
              bundleGroups: [],
              index: 0,
              keptUnreadIds: [source.id],
              processedIds: [source.id],
              replyDrafts: {},
              secondaryActionIds: [],
              selectedMemberId: source.id,
            },
          },
          'context-race-csrf',
        ),
      )
      expect(newerState.status).toBe(200)
      releaseContext?.()

      const rejected = await finalizing
      expect(rejected.status).toBe(409)
      expect((await rejected.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_REVISION_CONFLICT' },
      })
      expect(localStore.get('context-race-round')?.finalization).toMatchObject({
        finalizeIds: [],
        state: 'active',
      })
    } finally {
      releaseContext?.()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('allows only one first finalization selection after concurrent live context loading', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails[0]
    expect(source).toBeDefined()
    if (!source) return
    const other = { ...source, id: 'concurrent-other', threadId: 'concurrent-other-thread' }
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    localStore.create({
      csrfToken: 'concurrent-finalize-csrf',
      emails: [source, other],
      filters,
      id: 'concurrent-finalize-round',
      imageToken: 'concurrent-finalize-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    let contextCalls = 0
    let contextsStarted: (() => void) | undefined
    const bothContextsStarted = new Promise<void>((resolve) => {
      contextsStarted = resolve
    })
    let releaseContexts: (() => void) | undefined
    const contextGate = new Promise<void>((resolve) => {
      releaseContexts = resolve
    })
    let releaseMarkRead: (() => void) | undefined
    const markReadGate = new Promise<void>((resolve) => {
      releaseMarkRead = resolve
    })
    let markReadStarted: (() => void) | undefined
    const markReadStart = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
      fastmailToken: 'test-fastmail-token',
      markRead: async (_context, _token, ids) => {
        markReadStarted?.()
        await markReadGate
        return { failed: [], markedIds: [...ids] }
      },
      resumeMailSnapshot: async () => {
        contextCalls += 1
        if (contextCalls === 2) contextsStarted?.()
        await contextGate
        return {
          context: {
            accountId: 'account',
            apiUrl: 'https://jmap.invalid.test',
            downloadUrl: 'https://jmap.invalid.test/{blobId}',
            maxObjectsInGet: 100,
            maxObjectsInSet: 100,
            username: 'test@example.test',
          },
          emails: [source, other],
          filters,
          mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
          missingIds: [],
          totalBeforeLimit: 2,
          truncated: false,
        }
      },
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const finalizeOne = (id: string) =>
        fetch(
          `${localBase}/api/reviews/concurrent-finalize-round/finalize`,
          post({ finalizeIds: [id], keepUnreadIds: [], revision: 0 }, 'concurrent-finalize-csrf'),
        )
      const first = finalizeOne(source.id)
      const second = finalizeOne(other.id)
      await bothContextsStarted
      releaseContexts?.()
      await markReadStart
      const early = await Promise.race([
        first.then((response) => ({ response, request: 'first' as const })),
        second.then((response) => ({ response, request: 'second' as const })),
      ])
      expect(early.response.status).toBe(409)
      const deleteDuringFinalization = await fetch(
        `${localBase}/api/reviews/concurrent-finalize-round`,
        {
          method: 'DELETE',
          headers: { 'X-Inbox-Walk-CSRF': 'concurrent-finalize-csrf' },
        },
      )
      expect(deleteDuringFinalization.status).toBe(409)
      expect((await deleteDuringFinalization.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'ROUND_FINALIZATION_IN_PROGRESS' },
      })
      expect(localStore.get('concurrent-finalize-round')).not.toBeNull()
      releaseMarkRead?.()
      const responses = await Promise.all([first, second])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409])

      const stored = localStore.get('concurrent-finalize-round')
      expect(stored?.finalization.state).toBe('finalized')
      expect(stored?.finalization.finalizeIds).toHaveLength(1)
      expect([source.id, other.id]).toContain(stored?.finalization.finalizeIds[0])
    } finally {
      releaseContexts?.()
      releaseMarkRead?.()
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('persists a partial live finalization lock and completes the same selection on retry', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails.find((email) => email.isNewsletter)
    expect(source).toBeDefined()
    if (!source) return
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    localStore.create({
      csrfToken: 'partial-live-csrf',
      emails: [source],
      filters,
      id: 'partial-live-round',
      imageToken: 'partial-live-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    let shouldFail = true
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
      fastmailToken: 'test-fastmail-token',
      markRead: async (_context, _token, ids) =>
        shouldFail
          ? {
              failed: ids.map((id) => ({ id, reason: 'Temporärer Lesestatusfehler' })),
              markedIds: [],
            }
          : { failed: [], markedIds: [...ids] },
      resumeMailSnapshot: async () => ({
        context: {
          accountId: 'account',
          apiUrl: 'https://jmap.invalid.test',
          downloadUrl: 'https://jmap.invalid.test/{blobId}',
          maxObjectsInGet: 100,
          maxObjectsInSet: 100,
          username: 'test@example.test',
        },
        emails: [source],
        filters,
        mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
        missingIds: [],
        totalBeforeLimit: 1,
        truncated: false,
      }),
      roundStore: localStore,
      tagForLaterUnsubscribe: async (_context, _token, ids) =>
        shouldFail
          ? {
              failed: ids.map((id) => ({ id, reason: 'Temporärer Labelfehler' })),
              succeededIds: [],
            }
          : { failed: [], succeededIds: [...ids] },
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const body = {
        finalizeIds: [source.id],
        keepUnreadIds: [],
        revision: 0,
        secondaryActionIds: [source.id],
      }
      const partialResponse = await fetch(
        `${localBase}/api/reviews/partial-live-round/finalize`,
        post(body, 'partial-live-csrf'),
      )
      const partial = (await partialResponse.json()) as FinalizeResult
      expect(partialResponse.status).toBe(207)
      expect(partial).toMatchObject({
        actionFailed: [{ id: source.id, reason: 'Temporärer Labelfehler' }],
        failed: [{ id: source.id, reason: 'Temporärer Lesestatusfehler' }],
        finalized: false,
        remaining: 2,
      })

      clearApiStateForTests()
      const restored = (await (
        await fetch(`${localBase}/api/reviews/partial-live-round`)
      ).json()) as ReviewSnapshot
      expect(restored.finalization).toEqual({
        result: partial,
        selectionLocked: true,
        status: 'active',
      })
      expect(restored.userState).toMatchObject({
        processedIds: [source.id],
        secondaryActionIds: [source.id],
      })

      shouldFail = false
      const retryResponse = await fetch(
        `${localBase}/api/reviews/partial-live-round/finalize`,
        post(body, 'partial-live-csrf'),
      )
      expect(retryResponse.status).toBe(200)
      expect((await retryResponse.json()) as FinalizeResult).toMatchObject({
        actionFailed: [],
        failed: [],
        finalized: true,
        remaining: 0,
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('persists secondary-action failures when a later finalization step throws', async () => {
    clearApiStateForTests()
    const localStore = createRoundStore(':memory:')
    const source = demoEmails.find((email) => email.isNewsletter)
    expect(source).toBeDefined()
    if (!source) return
    const filters = {
      hideReviewed: false,
      mailboxId: null,
      newsletter: 'all' as const,
      spam: 'exclude' as const,
      timeRange: 'all' as const,
    }
    localStore.create({
      csrfToken: 'action-failure-csrf',
      emails: [source],
      filters,
      id: 'action-failure-round',
      imageToken: 'action-failure-image',
      mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
      mode: 'live',
    })
    const localMiddleware = createApiMiddleware({
      autoStartBundles: false,
      codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
      fastmailToken: 'test-fastmail-token',
      markRead: async () => {
        throw new Error('Later mark-read step failed')
      },
      resumeMailSnapshot: async () => ({
        context: {
          accountId: 'account',
          apiUrl: 'https://jmap.invalid.test',
          downloadUrl: 'https://jmap.invalid.test/{blobId}',
          maxObjectsInGet: 100,
          maxObjectsInSet: 100,
          username: 'test@example.test',
        },
        emails: [source],
        filters,
        mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
        missingIds: [],
        totalBeforeLimit: 1,
        truncated: false,
      }),
      roundStore: localStore,
      tagForLaterUnsubscribe: async (_context, _token, ids) => ({
        failed: ids.map((id) => ({ id, reason: 'Persistierter Labelfehler' })),
        succeededIds: [],
      }),
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const failed = await fetch(
        `${localBase}/api/reviews/action-failure-round/finalize`,
        post(
          {
            finalizeIds: [source.id],
            keepUnreadIds: [],
            revision: 0,
            secondaryActionIds: [source.id],
          },
          'action-failure-csrf',
        ),
      )
      expect(failed.status).toBe(500)
      expect(localStore.get('action-failure-round')?.finalization).toMatchObject({
        actionFailed: [{ id: source.id, reason: 'Persistierter Labelfehler' }],
        finalizeIds: [source.id],
        state: 'active',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('restores the persisted finalization result after process-memory loss', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const emailId = created.body.emails[0]?.id
    expect(emailId).toBeDefined()
    if (!emailId) return
    const finalized = await json<FinalizeResult>(
      `/api/reviews/${created.body.snapshotId}/finalize`,
      post(
        finalizationBody(created.body, { finalizeIds: [emailId], keepUnreadIds: [emailId] }),
        created.body.csrfToken,
      ),
    )
    expect(finalized.body.finalized).toBe(true)

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)
    expect(restored.body.finalization).toMatchObject({
      result: finalized.body,
      selectionLocked: true,
      status: 'finalized',
    })
    expect(restored.body.userState).toMatchObject({
      keptUnreadIds: [emailId],
      processedIds: [emailId],
    })
    const stateWrite = await json<{ error: { code: string } }>(
      `/api/reviews/${created.body.snapshotId}/state`,
      post(
        {
          revision: restored.body.userState.revision,
          state: {
            bundleGroups: [],
            index: 0,
            keptUnreadIds: [],
            processedIds: [],
            replyDrafts: {},
            secondaryActionIds: [],
            selectedMemberId: null,
          },
        },
        created.body.csrfToken,
      ),
    )
    expect(stateWrite.response.status).toBe(409)
    expect(stateWrite.body.error.code).toBe('ROUND_FINALIZED')
  })

  it('keeps a partial finalization selection locked after process-memory loss', async () => {
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const emailId = created.body.emails[0]?.id
    expect(emailId).toBeDefined()
    if (!emailId) return
    roundStore.saveFinalization(created.body.snapshotId, {
      actionFailed: partialFinalizeResult.actionFailed,
      failed: partialFinalizeResult.failed,
      finalizeIds: [emailId],
      keepUnreadIds: [emailId],
      result: partialFinalizeResult,
      state: 'active',
    })

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)
    expect(restored.body.finalization).toEqual({
      result: partialFinalizeResult,
      selectionLocked: true,
      status: 'active',
    })
    expect(restored.body.userState).toMatchObject({
      keptUnreadIds: [emailId],
      processedIds: [emailId],
    })
    const changed = await json<{ error: { code: string } }>(
      `/api/reviews/${created.body.snapshotId}/state`,
      post(
        {
          revision: restored.body.userState.revision,
          state: {
            bundleGroups: [],
            index: 0,
            keptUnreadIds: [],
            processedIds: [],
            replyDrafts: {},
            secondaryActionIds: [],
            selectedMemberId: null,
          },
        },
        restored.body.csrfToken,
      ),
    )
    expect(changed.response.status).toBe(409)
    expect(changed.body.error.code).toBe('FINALIZE_SELECTION_LOCKED')
  })

  it('accepts and locks an exact completion selection larger than 250 messages', async () => {
    const template = demoEmails.find((email) => email.id === 'demo-human')
    expect(template).toBeDefined()
    if (!template) return
    const messages = Array.from({ length: 301 }, (_, index) => ({
      ...template,
      id: `bulk-${index}`,
      threadId: `bulk-thread-${index}`,
      subject: `Bulk message ${index}`,
      messageId: [`bulk-${index}@example.test`],
    }))
    const localStore = createRoundStore(':memory:')
    const localMiddleware = createApiMiddleware({
      demoMessages: messages,
      forceDemo: true,
      roundStore: localStore,
    })
    const localServer = createServer((request, response) => {
      void localMiddleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = localServer.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const localBase = `http://127.0.0.1:${address.port}`
      const createdResponse = await fetch(
        `${localBase}/api/reviews`,
        post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
      )
      const run = (await createdResponse.json()) as ReviewRunSummary
      await waitForApiJobs()
      const created = (await (
        await fetch(`${localBase}/api/reviews/${run.id}`)
      ).json()) as ReviewSnapshot
      expect(created.emails).toHaveLength(301)
      const finalizeIds = created.emails.slice(0, 300).map((email) => email.id)
      const finalResponse = await fetch(
        `${localBase}/api/reviews/${created.snapshotId}/finalize`,
        post(
          finalizationBody(created, {
            finalizeIds,
            keepUnreadIds: [finalizeIds[0]],
            secondaryActionIds: [],
          }),
          created.csrfToken,
        ),
      )
      const finalized = (await finalResponse.json()) as FinalizeResult
      expect(finalResponse.status).toBe(200)
      expect(finalized).toMatchObject({
        processed: 300,
        keptUnread: 1,
        markedRead: 299,
        untouched: 1,
      })
      const changed = await fetch(
        `${localBase}/api/reviews/${created.snapshotId}/finalize`,
        post(
          finalizationBody(created, {
            finalizeIds: created.emails.map((email) => email.id),
            keepUnreadIds: [],
          }),
          created.csrfToken,
        ),
      )
      expect(changed.status).toBe(409)
      expect((await changed.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'FINALIZE_SELECTION_LOCKED' },
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
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
      post(
        finalizationBody(review.body, {
          finalizeIds: [processed.id],
          keepUnreadIds: [untouched.id],
        }),
        review.body.csrfToken,
      ),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('INVALID_SELECTION')
  })

  it('never finalizes an ID outside the frozen snapshot', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const rejected = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/finalize`,
      post(
        finalizationBody(review.body, {
          finalizeIds: ['new-mail-outside-snapshot'],
          keepUnreadIds: [],
        }),
        review.body.csrfToken,
      ),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('UNKNOWN_EMAIL')
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
        finalizationBody(review.body, {
          finalizeIds: [newsletter.id],
          keepUnreadIds: [],
          secondaryActionIds: [newsletter.id],
        }),
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
        finalizationBody(review.body, {
          finalizeIds: [spam.id],
          keepUnreadIds: [],
          secondaryActionIds: [spam.id],
        }),
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
        finalizationBody(review.body, {
          finalizeIds: [regular.id],
          keepUnreadIds: [],
          secondaryActionIds: [regular.id],
        }),
        review.body.csrfToken,
      ),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('UNSUBSCRIBE_UNAVAILABLE')
  })
})
