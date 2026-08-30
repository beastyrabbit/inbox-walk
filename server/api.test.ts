import { createServer, request as httpRequest, type Server } from 'node:http'
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
import {
  clearApiStateForTests,
  codexBundleCallLimit,
  createApiMiddleware,
  safeCodexLoginUrl,
  waitForApiJobs,
} from './api.ts'
import type { BundleRelationshipLabel } from './bundle-store.ts'
import { type BundleExample, hashLearningSignal } from './bundles.ts'
import { CodexAuthenticationError } from './codex.ts'
import { demoEmails } from './demo.ts'
import { createRoundStore } from './round-store.ts'

let server: Server
let baseUrl = ''
const retainedIds = new Set<string>()
let injectUnknownBundleId = false
let bundleDecisionCalls = 0
let bundleDecisionGate: Promise<void> | null = null
let releaseBundleDecision: (() => void) | null = null
const recordedBundleLabels: BundleRelationshipLabel[] = []
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
  return { response, body: (await response.json()) as T }
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
      record: (label) => recordedBundleLabels.push(label),
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
  bundleDecisionCalls = 0
  bundleDecisionGate = null
  releaseBundleDecision = null
  recordedBundleLabels.length = 0
  availableBundleExamples = []
})

describe('demo API contract', () => {
  it('uses the documented Codex call limit default for empty configuration', () => {
    const previous = process.env.CODEX_BUNDLE_MAX_CALLS
    try {
      delete process.env.CODEX_BUNDLE_MAX_CALLS
      expect(codexBundleCallLimit(undefined)).toBe(64)
      process.env.CODEX_BUNDLE_MAX_CALLS = ''
      expect(codexBundleCallLimit(undefined)).toBe(64)
      process.env.CODEX_BUNDLE_MAX_CALLS = '   '
      expect(codexBundleCallLimit(undefined)).toBe(64)
      process.env.CODEX_BUNDLE_MAX_CALLS = 'invalid'
      expect(codexBundleCallLimit(undefined)).toBe(64)
      expect(codexBundleCallLimit(0)).toBe(1)
      expect(codexBundleCallLimit(2.9)).toBe(2)
      expect(codexBundleCallLimit(1_000)).toBe(512)
    } finally {
      if (previous === undefined) delete process.env.CODEX_BUNDLE_MAX_CALLS
      else process.env.CODEX_BUNDLE_MAX_CALLS = previous
    }
  })

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

  it('creates a fixed review and lazily loads a detail', async () => {
    const options = await json<ReviewOptions>('/api/review/options')
    expect(options.response.status).toBe(200)
    expect(options.body.mode).toBe('demo')

    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    expect(review.response.status).toBe(201)
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
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const started = await json<ReviewSnapshot>(
      `/api/reviews/${created.body.snapshotId}/bundles`,
      post({}, created.body.csrfToken),
    )

    expect(started.response.status).toBe(202)
    expect(started.body.analysis).toMatchObject({ engine: 'codex', status: 'running' })
    expect(started.body.bundleRun).toBeUndefined()
    releaseBundleDecision?.()
    const completed = await waitForBundles(created.body)
    const callsAfterCompletion = bundleDecisionCalls
    expect(callsAfterCompletion).toBeGreaterThan(0)

    clearApiStateForTests()
    const restored = await json<ReviewSnapshot>(`/api/reviews/${created.body.snapshotId}`)
    expect(restored.body.analysis.status).toBe('complete')
    const restarted = await json<ReviewSnapshot>(
      `/api/reviews/${created.body.snapshotId}/bundles`,
      post({}, created.body.csrfToken),
    )
    expect(restarted.response.status).toBe(200)
    expect(restarted.body.bundleRun).toEqual(completed.bundleRun)
    expect(bundleDecisionCalls).toBe(callsAfterCompletion)
    const rejectedFallback = await json<{ error: { code: string } }>(
      `/api/reviews/${created.body.snapshotId}/bundles/fallback`,
      post({}, created.body.csrfToken),
    )
    expect(rejectedFallback.response.status).toBe(409)
    expect(rejectedFallback.body.error.code).toBe('ANALYSIS_ALREADY_COMPLETE')
  })

  it('rejects the explicit fallback immediately while Codex analysis is running', async () => {
    bundleDecisionGate = new Promise<void>((resolve) => {
      releaseBundleDecision = resolve
    })
    const created = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const started = await json<ReviewSnapshot>(
      `/api/reviews/${created.body.snapshotId}/bundles`,
      post({}, created.body.csrfToken),
    )
    expect(started.response.status).toBe(202)
    expect(started.body.analysis.status).toBe('running')

    const fallbackRequest = json<{ error: { code: string } }>(
      `/api/reviews/${created.body.snapshotId}/bundles/fallback`,
      post({}, created.body.csrfToken),
    )
    try {
      const early = await Promise.race([
        fallbackRequest.then((result) => ({ kind: 'response' as const, result })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), 100),
        ),
      ])
      expect(early.kind).toBe('response')
      if (early.kind === 'response') {
        expect(early.result.response.status).toBe(409)
        expect(early.result.body.error.code).toBe('ANALYSIS_NOT_WAITING_FOR_CODEX')
      }
    } finally {
      releaseBundleDecision?.()
      await fallbackRequest
      await waitForApiJobs()
    }
  })

  it('automatically resumes a persisted unfinished analysis when the round is opened', async () => {
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
      const openedResponse = await fetch(`${localBase}/api/reviews/pending-recovery-round`)
      const opened = (await openedResponse.json()) as ReviewSnapshot

      expect(openedResponse.status).toBe(200)
      expect(opened.analysis).toMatchObject({ engine: 'codex', status: 'running' })
      expect(opened.bundleRun).toBeUndefined()
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

      const forbiddenFallback = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles/fallback`,
        post({}, 'wrong-csrf'),
      )
      expect(forbiddenFallback.status).toBe(403)

      const fallbackResponse = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles/fallback`,
        post({}, 'restart-csrf'),
      )
      const fallback = (await fallbackResponse.json()) as ReviewSnapshot
      expect(fallbackResponse.status).toBe(200)
      expect(fallback.analysis).toMatchObject({
        callCount: 2,
        engine: 'fallback',
        model: 'gpt-5.6-sol',
        phase: 'complete',
        processedEmailCount: 2,
        progress: 1,
        status: 'complete',
      })
      expect(fallback.analysis).not.toHaveProperty('error')
      expect(fallback.bundleRun?.fallback).toBe(true)
      expect(fallback.bundleRun?.bundles.map((bundle) => bundle.emailIds)).toEqual([
        [source.id],
        [secondSource.id],
      ])
      expect(localStore.get('live-restart-round')?.analysis).toMatchObject({
        callCount: 2,
        engine: 'fallback',
        phase: 'complete',
        status: 'complete',
      })

      const repeatedResponse = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles/fallback`,
        post({}, 'restart-csrf'),
      )
      const repeated = (await repeatedResponse.json()) as ReviewSnapshot
      expect(repeatedResponse.status).toBe(200)
      expect(repeated.bundleRun).toEqual(fallback.bundleRun)

      const extraSegmentResponse = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles/fallback/extra`,
        post({}, 'restart-csrf'),
      )
      expect(extraSegmentResponse.status).toBe(404)

      clearApiStateForTests()
      const reopened = (await (
        await fetch(`${localBase}/api/reviews/live-restart-round`)
      ).json()) as ReviewSnapshot
      expect(reopened.analysis).toMatchObject({ engine: 'fallback', status: 'complete' })
      expect(reopened.bundleRun).toEqual(fallback.bundleRun)
      const normalBundleResponse = await fetch(
        `${localBase}/api/reviews/live-restart-round/bundles`,
        post({}, 'restart-csrf'),
      )
      expect(normalBundleResponse.status).toBe(200)
      expect(((await normalBundleResponse.json()) as ReviewSnapshot).bundleRun).toEqual(
        fallback.bundleRun,
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close((error) => (error ? reject(error) : resolve())),
      )
      localStore.close()
      clearApiStateForTests()
    }
  })

  it('keeps the Codex waiting state in memory when fallback persistence fails', async () => {
    for (const failureMode of ['null', 'throw'] as const) {
      clearApiStateForTests()
      const localStore = createRoundStore(':memory:')
      const source = demoEmails[0]
      expect(source).toBeDefined()
      if (!source) return
      localStore.create({
        analysis: {
          callCount: 1,
          engine: 'codex',
          model: 'gpt-5.6-sol',
          phase: 'waiting_for_codex',
          processedEmailCount: 0,
          progress: 0.25,
          status: 'pending',
          totalEmailCount: 1,
        },
        csrfToken: `fallback-${failureMode}-csrf`,
        emails: [source],
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        id: `fallback-${failureMode}-round`,
        imageToken: `fallback-${failureMode}-image`,
        mailboxes: [{ id: 'Inbox', name: 'Inbox', role: 'inbox' }],
        mode: 'live',
      })
      const failingStore = {
        ...localStore,
        saveBundleRun: () => {
          if (failureMode === 'throw') throw new Error('Simulated persistence failure')
          return null
        },
      }
      const localMiddleware = createApiMiddleware({
        autoStartBundles: false,
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
        if (!address || typeof address === 'string')
          throw new Error('Local test server did not bind')
        const localBase = `http://127.0.0.1:${address.port}`
        const failedResponse = await fetch(
          `${localBase}/api/reviews/fallback-${failureMode}-round/bundles/fallback`,
          post({}, `fallback-${failureMode}-csrf`),
        )
        expect(failedResponse.status).toBe(503)
        expect((await failedResponse.json()) as { error: { code: string } }).toMatchObject({
          error: { code: 'ROUND_PERSIST_FAILED' },
        })

        const current = (await (
          await fetch(`${localBase}/api/reviews/fallback-${failureMode}-round`)
        ).json()) as ReviewSnapshot
        expect(current.analysis).toMatchObject({
          engine: 'codex',
          phase: 'waiting_for_codex',
          status: 'pending',
        })
        expect(current.bundleRun).toBeUndefined()
        expect(localStore.get(`fallback-${failureMode}-round`)).toMatchObject({
          analysis: {
            engine: 'codex',
            phase: 'waiting_for_codex',
            status: 'pending',
          },
          bundleRun: null,
        })
      } finally {
        await new Promise<void>((resolve, reject) =>
          localServer.close((error) => (error ? reject(error) : resolve())),
        )
        localStore.close()
        clearApiStateForTests()
      }
    }
  })

  it('reuses the frozen Codex inputs and call limit after restart', async () => {
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
      bundleCallLimit: 2,
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
      bundleCallLimit: 1,
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

  it('builds an exact bundle partition and rejects unknown learning IDs', async () => {
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
    const rejected = await json<{ error: { code: string } }>(
      `/api/reviews/${review.body.snapshotId}/bundle-labels`,
      post(
        {
          anchorEmailIds: [review.body.emails[0]?.id],
          candidateEmailIds: ['not-in-the-snapshot'],
          label: 'split',
        },
        review.body.csrfToken,
      ),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('UNKNOWN_EMAIL')
  })

  it('accepts a bundle-label reason without persisting its free-form text', async () => {
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const [anchor, candidate] = review.body.emails
    expect(anchor).toBeDefined()
    expect(candidate).toBeDefined()
    if (!anchor || !candidate) return

    const recorded = await json<{ recorded: boolean }>(
      `/api/reviews/${review.body.snapshotId}/bundle-labels`,
      post(
        {
          anchorEmailIds: [anchor.id],
          candidateEmailIds: [candidate.id],
          label: 'split',
          reason: 'Untrusted free-form reason that must not reach SQLite.',
        },
        review.body.csrfToken,
      ),
    )

    expect(recorded.response.status).toBe(201)
    expect(recorded.body.recorded).toBe(true)
    expect(recordedBundleLabels).toHaveLength(1)
    expect(recordedBundleLabels[0]).toMatchObject({
      label: 'split',
      reason: 'Vom Nutzer im Review bestätigt.',
    })
  })

  it('falls back to safe singletons when a bundle decision injects an unknown ID', async () => {
    injectUnknownBundleId = true
    const review = await json<ReviewSnapshot>(
      '/api/reviews',
      post({ filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' } }),
    )
    const completed = await waitForBundles(review.body)
    const run = completed.bundleRun
    if (!run) return
    expect(run.fallback).toBe(true)
    expect(completed.analysis).toMatchObject({ engine: 'fallback', status: 'complete' })
    expect(completed.analysis.error).toContain('nicht sicher bestimmt')
    expect(run.bundles).toHaveLength(review.body.emails.length)
    expect(run.bundles.flatMap((bundle) => bundle.emailIds)).not.toContain(
      'outside-frozen-snapshot',
    )
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
      const created = (await createdResponse.json()) as ReviewSnapshot
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
    const localMiddleware = createApiMiddleware({ forceDemo: true, demoMessages: messages })
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
      const created = (await createdResponse.json()) as ReviewSnapshot
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
