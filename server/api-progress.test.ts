import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultReviewFilters } from '../src/shared.ts'
import {
  type ApiOptions,
  clearApiStateForTests,
  createApiMiddleware,
  waitForApiJobs,
} from './api.ts'
import { demoEmails } from './demo.ts'
import { ioSignal } from './io.ts'
import { createReviewHistory } from './review-history.ts'
import { createRoundStore } from './round-store.ts'

vi.mock('./safe-http.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./safe-http.ts')>()),
  fetchRemoteImage: vi.fn(async () => ({
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: 'image/png',
  })),
}))

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const context = {
  accountId: 'fixture',
  apiUrl: 'https://jmap.example.test',
  downloadUrl: 'https://blob.example.test/{blobId}',
  maxObjectsInGet: 10,
  maxObjectsInSet: 1,
  username: 'fixture@example.test',
}
const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'junk', name: 'Spam', role: 'junk' },
  { id: 'label', name: 'Newsletter abmelden', role: null },
]
const emails = ['first', 'second', 'third'].map((id) => ({
  ...demoEmails[0],
  id,
  isNewsletter: true,
}))

async function serve(
  store: ReturnType<typeof createRoundStore>,
  spam = false,
  overrides: ApiOptions = {},
  reconciliation = false,
) {
  const middleware = createApiMiddleware({
    roundStore: store,
    autoStartBundles: false,
    fastmailToken: 'synthetic-fixture',
    codexAuthStatus: () => ({ configured: false, model: 'gpt-5.6-sol' }),
    resumeMailSnapshot: async () => ({
      context: reconciliation ? { ...context, maxObjectsInSet: 2, maxObjectsInGet: 1 } : context,
      emails,
      filters: { ...defaultReviewFilters, spam: spam ? 'only' : 'exclude' },
      mailboxes,
      missingIds: [],
      totalBeforeLimit: emails.length,
      truncated: false,
    }),
    ...overrides,
  })
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

describe('durable adapter boundaries', () => {
  it('rejects a finalization displaced by cache eviction without overwriting a newer result', async () => {
    clearApiStateForTests()
    const store = createRoundStore(':memory:')
    for (const id of ['target', ...Array.from({ length: 22 }, (_, i) => `pressure-${i}`)]) {
      store.create({
        id,
        csrfToken: 'fixture-csrf',
        imageToken: 'fixture-image',
        mode: 'live',
        emails,
        filters: defaultReviewFilters,
        mailboxes,
      })
    }
    const gate = deferred()
    const started = deferred()
    let calls = 0
    const marked: string[][] = []
    const app = await serve(store, false, {
      resumeMailSnapshot: async () => {
        if (++calls === 1) {
          started.resolve()
          await gate.promise
        }
        return {
          context,
          emails,
          filters: defaultReviewFilters,
          mailboxes,
          missingIds: [],
          totalBeforeLimit: emails.length,
          truncated: false,
        }
      },
      markRead: async (_context, _token, ids) => {
        marked.push([...ids])
        return { failed: [], markedIds: [...ids] }
      },
    })
    const finalize = (id: string) =>
      fetch(`${app.base}/api/reviews/target/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Inbox-Walk-CSRF': 'fixture-csrf' },
        body: JSON.stringify({ revision: 0, finalizeIds: [id], keepUnreadIds: [] }),
      })
    try {
      const first = finalize('first')
      await started.promise
      for (let i = 0; i < 22; i++) {
        const response = await fetch(`${app.base}/api/reviews/pressure-${i}`)
        expect(response.ok).toBe(true)
        await response.arrayBuffer()
      }
      const second = await finalize('second')
      expect(second.status).toBe(200)
      await second.arrayBuffer()
      gate.resolve()
      const stale = await first
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ error: { code: 'ROUND_RELOAD_REQUIRED' } })
      expect(marked).toEqual([['second']])
      expect(store.get('target')?.finalization).toMatchObject({
        state: 'finalized',
        finalizeIds: ['second'],
        succeededIds: ['second'],
      })
    } finally {
      gate.resolve()
      await app.close()
      store.close()
      clearApiStateForTests()
    }
  })

  it('preserves a newly deferred message while an older options query reconciles history', async () => {
    clearApiStateForTests()
    const directory = mkdtempSync(join(tmpdir(), 'inbox-reconciliation-'))
    const store = createRoundStore(':memory:')
    const history = createReviewHistory(join(directory, 'history.sqlite'))
    history.rememberKeptUnread(['prior'])
    store.create({
      id: 'target',
      csrfToken: 'fixture-csrf',
      imageToken: 'fixture-image',
      mode: 'live',
      emails,
      filters: defaultReviewFilters,
      mailboxes,
    })
    const gate = deferred()
    const started = deferred()
    const realFetch = globalThis.fetch
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === 'https://api.fastmail.com/jmap/session')
        return new Response(
          JSON.stringify({
            apiUrl: context.apiUrl,
            downloadUrl: context.downloadUrl,
            primaryAccounts: { 'urn:ietf:params:jmap:mail': context.accountId },
            capabilities: {},
          }),
        )
      if (String(url) !== context.apiUrl) throw new Error('Unexpected external request blocked')
      const [method, args, id] = JSON.parse(String(init?.body)).methodCalls[0]
      if (method === 'Mailbox/get')
        return new Response(
          JSON.stringify({ methodResponses: [[method, { list: mailboxes }, id]] }),
        )
      expect(method).toBe('Email/get')
      expect(args.ids).toEqual(['prior'])
      started.resolve()
      await gate.promise
      return new Response(
        JSON.stringify({
          methodResponses: [[method, { list: [{ id: 'prior', keywords: {} }] }, id]],
        }),
      )
    })
    const app = await serve(store, false, {
      reviewHistory: history,
      markRead: async () => ({ failed: [], markedIds: [] }),
    })
    try {
      const options = realFetch(`${app.base}/api/review/options`)
      await started.promise
      const result = await realFetch(`${app.base}/api/reviews/target/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Inbox-Walk-CSRF': 'fixture-csrf' },
        body: JSON.stringify({ revision: 0, finalizeIds: ['first'], keepUnreadIds: ['first'] }),
      })
      expect(result.status).toBe(200)
      await result.arrayBuffer()
      gate.resolve()
      expect((await options).status).toBe(200)
      expect(history.retainedIds()).toEqual(new Set(['prior', 'first']))
    } finally {
      gate.resolve()
      await app.close()
      transport.mockRestore()
      history.close()
      store.close()
      clearApiStateForTests()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['create', 'snapshot', 'analysis'] as const)(
    'detaches %s jobs from the spawning request deadline',
    async (kind) => {
      clearApiStateForTests()
      const store = createRoundStore(':memory:')
      if (kind !== 'create')
        store.create({
          id: 'background-round',
          csrfToken: 'fixture-csrf',
          imageToken: 'fixture-image',
          mode: 'live',
          emails: kind === 'snapshot' ? [] : emails,
          filters: defaultReviewFilters,
          mailboxes,
          runStatus: kind === 'snapshot' ? 'queued' : 'analyzing',
        })
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      const deadline = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => timeout(ms === 5 * 60_000 ? 5 : ms))
      const signals: boolean[] = []
      const probe = async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        signals.push(ioSignal().aborted)
      }
      const app = await serve(store, false, {
        fetchMailSnapshot: async () => {
          await probe()
          return {
            context,
            emails,
            filters: defaultReviewFilters,
            mailboxes,
            missingIds: [],
            totalBeforeLimit: emails.length,
            truncated: false,
          }
        },
        bundlePartitionDecider: async () => {
          await probe()
          return { standaloneEmailIds: emails.map((email) => email.id), stories: [] }
        },
      })
      try {
        const response = await fetch(
          `${app.base}/api/reviews`,
          kind === 'create'
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filters: defaultReviewFilters }),
              }
            : undefined,
        )
        expect(response.status).toBe(kind === 'create' ? 202 : 200)
        await waitForApiJobs()
        expect(signals).toEqual(kind === 'analysis' ? [false] : [false, false])
      } finally {
        await app.close()
        await waitForApiJobs()
        deadline.mockRestore()
        store.close()
        clearApiStateForTests()
      }
    },
  )
  it.each([true, false])(
    'records history once with cumulative progress callbacks enabled=%s',
    async (withProgress) => {
      clearApiStateForTests()
      const store = createRoundStore(':memory:')
      store.create({
        id: 'history-round',
        csrfToken: 'fixture-csrf',
        imageToken: 'fixture-image',
        mode: 'live',
        emails,
        filters: defaultReviewFilters,
        mailboxes,
      })
      const remember = vi.fn()
      const forget = vi.fn()
      const app = await serve(store, false, {
        reviewHistory: {
          close() {},
          count: () => 0,
          forget,
          rememberKeptUnread: remember,
          retainedIds: () => new Set(),
          retainedSnapshot: () => new Map(),
          retainOnly() {},
        },
        markRead: async (_context, _token, ids, onProgress) => {
          expect(ids).toEqual(['first', 'second'])
          const result = { markedIds: [...ids], failed: [] }
          if (withProgress) {
            await onProgress?.({ markedIds: ['first'], failed: [] })
            expect(store.get('history-round')?.finalization.succeededIds).toEqual(['first'])
            expect(forget.mock.calls).toEqual([[['first']]])
            await onProgress?.(result)
          }
          return result
        },
      })
      try {
        const response = await fetch(`${app.base}/api/reviews/history-round/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Inbox-Walk-CSRF': 'fixture-csrf' },
          body: JSON.stringify({
            revision: 0,
            finalizeIds: emails.map((email) => email.id),
            keepUnreadIds: ['third'],
          }),
        })
        expect(response.status).toBe(200)
        expect(remember.mock.calls).toEqual([[['third']]])
        expect(forget.mock.calls).toEqual(
          withProgress ? [[['first']], [['second']]] : [[['first', 'second']]],
        )
      } finally {
        await app.close()
        store.close()
        clearApiStateForTests()
      }
    },
  )

  it.each(
    (['read', 'spam', 'label'] as const).flatMap((kind) =>
      [false, true].map((reconciliation) => ({ kind, reconciliation })),
    ),
  )(
    'reopens SQLite and omits confirmed $kind batches on retry, reconciliation=$reconciliation',
    async ({ kind, reconciliation }) => {
      clearApiStateForTests()
      const directory = mkdtempSync(join(tmpdir(), 'inbox-progress-'))
      let store = createRoundStore(join(directory, 'rounds.sqlite'))
      store.create({
        id: 'fixture-round',
        csrfToken: 'fixture-csrf',
        imageToken: 'fixture-image',
        mode: 'live',
        emails,
        filters: { ...defaultReviewFilters, spam: kind === 'spam' ? 'only' : 'exclude' },
        mailboxes,
      })
      const originalFetch = globalThis.fetch
      let retry = false
      const attempts: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url, init) => {
          if (!String(url).startsWith(context.apiUrl)) return originalFetch(url, init)
          const [method, args, callId] = JSON.parse(String(init?.body)).methodCalls[0]
          let result: unknown
          if (method === 'Mailbox/get') result = { list: mailboxes }
          else if (method === 'Email/get') {
            if (reconciliation && args.ids[0] === 'first') {
              result = {
                list: [
                  {
                    id: 'first',
                    keywords: { $seen: true },
                    mailboxIds: { inbox: true, label: true },
                  },
                ],
              }
            } else if (reconciliation) {
              const saved = store.get('fixture-round')?.finalization
              expect(
                kind === 'read' ? saved?.succeededIds : saved?.secondaryActionSucceededIds,
              ).toEqual(['first'])
              throw new Error('Synthetic later read-back failure')
            } else result = { list: [] }
          } else {
            const id = Object.keys(args.update)[0] as string
            const action = Object.keys(args.update[id])[0]?.startsWith('mailboxIds/')
              ? 'membership'
              : 'read'
            attempts.push(`${action}:${id}`)
            if (!retry && (reconciliation || id === 'second'))
              throw new Error('Synthetic later-batch failure')
            result = {
              updated: Object.fromEntries(Object.keys(args.update).map((id) => [id, null])),
            }
          }
          return new Response(JSON.stringify({ methodResponses: [[method, result, callId]] }))
        }),
      )
      let app = await serve(store, kind === 'spam', {}, reconciliation)
      try {
        const finalize = () =>
          fetch(`${app.base}/api/reviews/fixture-round/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Inbox-Walk-CSRF': 'fixture-csrf' },
            body: JSON.stringify({
              revision: 0,
              finalizeIds: emails.map((email) => email.id),
              keepUnreadIds: [],
              secondaryActionIds: kind === 'read' ? [] : emails.map((email) => email.id),
            }),
          })
        const failed = await finalize()
        expect(failed.status).toBeGreaterThanOrEqual(500)
        if (reconciliation) {
          expect(await failed.json()).toMatchObject({
            error: {
              details: {
                confirmedIds: ['first'],
                unknownIds: ['second'],
                unattemptedIds: ['third'],
              },
            },
          })
        }
        await app.close()
        store.close()
        clearApiStateForTests()
        store = createRoundStore(join(directory, 'rounds.sqlite'))
        const finalization = store.get('fixture-round')?.finalization
        expect(
          kind === 'read' ? finalization?.succeededIds : finalization?.secondaryActionSucceededIds,
        ).toEqual(['first'])
        retry = true
        attempts.length = 0
        app = await serve(store, kind === 'spam', {}, reconciliation)
        expect((await finalize()).status).toBe(200)
        expect(attempts).not.toContain(`${kind === 'read' ? 'read' : 'membership'}:first`)
        expect(store.get('fixture-round')?.finalization.succeededIds).toHaveLength(3)
      } finally {
        await app.close()
        store.close()
        vi.unstubAllGlobals()
        clearApiStateForTests()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('enforces blob membership and image tokens and returns private no-store images', async () => {
    clearApiStateForTests()
    const store = createRoundStore(':memory:')
    store.create({
      id: 'images',
      csrfToken: 'fixture-csrf',
      imageToken: 'fixture-image',
      mode: 'live',
      emails,
      filters: defaultReviewFilters,
      mailboxes,
    })
    const originalFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, init) => {
        if (!String(url).startsWith(context.apiUrl)) return originalFetch(url, init)
        const [method, , callId] = JSON.parse(String(init?.body)).methodCalls[0]
        return new Response(
          JSON.stringify({
            methodResponses: [
              [
                method,
                {
                  list: [
                    {
                      id: 'first',
                      threadId: 'fixture-thread',
                      receivedAt: new Date(0).toISOString(),
                      mailboxIds: { inbox: true },
                      htmlBody: [{ partId: 'html', type: 'text/html' }],
                      bodyValues: {
                        html: { value: '<img src="https://image.example.test/fixture.png">' },
                      },
                    },
                  ],
                },
                callId,
              ],
            ],
          }),
        )
      }),
    )
    const app = await serve(store)
    try {
      expect((await fetch(`${app.base}/api/reviews/images/blobs/unknown`)).status).toBe(403)
      const detail = (await (
        await fetch(`${app.base}/api/reviews/images/emails/first`)
      ).json()) as { remoteImageIds: Record<string, string> }
      const imageId = Object.values(detail.remoteImageIds)[0]
      expect(imageId).toBeTruthy()
      const path = `${app.base}/api/reviews/images/emails/first/images/${imageId}`
      expect((await fetch(`${path}?token=wrong`)).status).toBe(403)
      expect(
        (
          await fetch(
            `${app.base}/api/reviews/images/emails/second/images/${imageId}?token=fixture-image`,
          )
        ).status,
      ).toBe(409)
      const image = await fetch(`${path}?token=fixture-image`)
      expect(image.status).toBe(200)
      expect(image.headers.get('cache-control')).toBe('private, no-store')
      expect(image.headers.get('content-type')).toBe('image/png')
      expect((await image.arrayBuffer()).byteLength).toBe(4)
    } finally {
      await app.close()
      store.close()
      vi.unstubAllGlobals()
      clearApiStateForTests()
    }
  })
})
