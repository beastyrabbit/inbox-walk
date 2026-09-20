import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ReviewEmail,
  ThreadContext,
  TriageActionResult,
  TriageMemory,
  TriageSnapshot,
} from '../src/shared.ts'
import { clearApiStateForTests, createApiMiddleware } from './api.ts'
import { createDemoMailbox } from './mailbox.ts'
import { createTriageEngine } from './triage-engine.ts'
import { heuristicSorter } from './triage-sorter.ts'
import { createTriageStore } from './triage-store.ts'

let server: Server
let baseUrl = ''
const store = createTriageStore(':memory:')
const mailbox = createDemoMailbox()
const engine = createTriageEngine({ engine: 'heuristic', mailbox, sorter: heuristicSorter, store })

async function json<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init)
  return { response, body: (await response.json()) as T }
}

function post(body: unknown, csrfToken?: string, method = 'POST'): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-Inbox-Walk-CSRF': csrfToken } : {}),
    },
    body: JSON.stringify(body),
  }
}

async function todo() {
  return (await json<TriageSnapshot>('/api/todo')).body
}

beforeAll(async () => {
  const middleware = createApiMiddleware({ engine, mailbox, store })
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
  await engine.refresh()
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await engine.stop()
  store.close()
  clearApiStateForTests()
})

describe('todo API', () => {
  it('serves the sorted todo with tokens, status and memory', async () => {
    const snapshot = await todo()
    expect(snapshot.mode).toBe('demo')
    expect(snapshot.csrfToken).toHaveLength(43)
    expect(snapshot.buckets.length).toBeGreaterThan(1)
    expect(snapshot.buckets.every((bucket) => !bucket.unsorted)).toBe(true)
    expect(snapshot.status).toMatchObject({ engine: 'heuristic', queuedCount: 0 })
    expect(snapshot.memory).toEqual({ notes: '', proposals: [] })
    expect(snapshot.codex.configured).toBe(false)
  })

  it('requires the CSRF token for every mutation', async () => {
    const rejected = await json<{ error: { code: string } }>(
      '/api/todo/messages/done',
      post({ emailIds: ['demo-train'] }),
    )
    expect(rejected.response.status).toBe(403)
    expect(rejected.body.error.code).toBe('INVALID_CSRF')
    const memory = await json<{ error: { code: string } }>(
      '/api/todo/memory',
      post({ notes: 'x' }, undefined, 'PUT'),
    )
    expect(memory.response.status).toBe(403)
  })

  it('marks only the named messages read and removes their bucket when it is empty', async () => {
    const before = await todo()
    const train = before.buckets.find((bucket) =>
      bucket.messages.some((item) => item.summary.id === 'demo-train'),
    )
    expect(train?.messages).toHaveLength(1)
    const done = await json<TriageActionResult>(
      '/api/todo/messages/done',
      post({ emailIds: ['demo-train'] }, before.csrfToken),
    )
    expect(done.response.status).toBe(200)
    expect(done.body.failed).toEqual([])
    expect(
      done.body.snapshot.buckets.some((bucket) =>
        bucket.messages.some((item) => item.summary.id === 'demo-train'),
      ),
    ).toBe(false)
    expect(done.body.snapshot.buckets).toHaveLength(before.buckets.length - 1)
    expect(await mailbox.unreadIds()).not.toContain('demo-train')
    const unknown = await json<{ error: { code: string } }>(
      '/api/todo/messages/done',
      post({ emailIds: ['ghost'] }, before.csrfToken),
    )
    expect(unknown.response.status).toBe(404)
  })

  it('parks a message out of its bucket and brings it back unread', async () => {
    const before = await todo()
    const parked = await json<TriageActionResult>(
      '/api/todo/messages/park',
      post({ emailIds: ['demo-human'] }, before.csrfToken),
    )
    expect(parked.body.snapshot.parked.map((item) => item.summary.id)).toEqual(['demo-human'])
    expect(await mailbox.unreadIds()).toContain('demo-human')
    const unparked = await json<TriageActionResult>(
      '/api/todo/messages/unpark',
      post({ emailIds: ['demo-human'] }, before.csrfToken),
    )
    expect(unparked.body.snapshot.parked).toEqual([])
    expect(
      unparked.body.snapshot.buckets.some((bucket) =>
        bucket.messages.some((item) => item.summary.id === 'demo-human'),
      ),
    ).toBe(true)
  })

  it('applies the newsletter label only to detected newsletters', async () => {
    const snapshot = await todo()
    const rejected = await json<{ error: { code: string } }>(
      '/api/todo/messages/newsletter',
      post({ emailIds: ['demo-train'] }, snapshot.csrfToken),
    )
    expect(rejected.response.status).toBe(400)
    expect(rejected.body.error.code).toBe('NOT_A_NEWSLETTER')
    const tagged = await json<TriageActionResult>(
      '/api/todo/messages/newsletter',
      post({ emailIds: ['demo-news'] }, snapshot.csrfToken),
    )
    expect(tagged.response.status).toBe(200)
    expect(tagged.body.failed).toEqual([])
  })

  it('serves mail bodies, threads and proxied image IDs for known messages only', async () => {
    const detail = await json<ReviewEmail>('/api/todo/emails/demo-shop')
    expect(detail.response.status).toBe(200)
    expect(detail.body.remoteImageIds).toBeDefined()
    const imageId = Object.values(detail.body.remoteImageIds ?? {})[0]
    expect(imageId).toBeDefined()
    const forbidden = await fetch(
      `${baseUrl}/api/todo/emails/demo-shop/images/${imageId}?token=wrong`,
    )
    expect(forbidden.status).toBe(403)
    const missing = await json<{ error: { code: string } }>('/api/todo/emails/ghost')
    expect(missing.response.status).toBe(404)
    const thread = await json<ThreadContext>(
      '/api/todo/threads/thread-github-184?emailId=demo-github-opened',
    )
    expect(thread.body.messages).toHaveLength(2)
    expect(thread.body.recipients.identityId).toBe('demo-identity')
  })

  it('reloads a thread for every reply so later mail is never missed', async () => {
    const before = await json<ThreadContext>('/api/todo/threads/thread-human?emailId=demo-human')
    expect(before.body.messages).toHaveLength(1)
    const original = mailbox.thread
    vi.spyOn(mailbox, 'thread').mockImplementation(async (threadId) => [
      ...(await original(threadId)),
      { ...(await original(threadId))[0], id: 'demo-human-2', subject: 'Re: Re: Essen' } as never,
    ])
    const after = await json<ThreadContext>('/api/todo/threads/thread-human?emailId=demo-human')
    expect(after.body.messages).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it('forgets blob and image registrations of evicted mail', async () => {
    const original = mailbox.detail
    const spy = vi.spyOn(mailbox, 'detail').mockImplementation(async (emailId) => {
      if (!emailId.startsWith('synthetic-')) return original(emailId)
      const base = await original('demo-shop')
      return {
        ...base,
        id: emailId,
        attachments: [
          { blobId: `blob-${emailId}`, name: 'a.pdf', type: 'application/pdf', size: 1 },
        ],
      }
    })
    const spyMessage = vi
      .spyOn(store, 'message')
      .mockImplementation((emailId) =>
        emailId.startsWith('synthetic-')
          ? { attempts: 0, bucketId: null, status: 'sorted', summary: { id: emailId } as never }
          : store.message.call(store, emailId),
      )
    try {
      const first = await json<ReviewEmail>('/api/todo/emails/synthetic-0')
      const firstImage = Object.values(first.body.remoteImageIds ?? {})[0]
      for (let index = 1; index <= 305; index += 1) {
        await fetch(`${baseUrl}/api/todo/emails/synthetic-${index}`)
      }
      const evicted = await fetch(`${baseUrl}/api/todo/emails/synthetic-0/images/${firstImage}`)
      expect(evicted.status).toBe(403)
      // Reloading registers fresh image IDs; the evicted one must stay unknown.
      const reloaded = await json<ReviewEmail>('/api/todo/emails/synthetic-0')
      expect(Object.values(reloaded.body.remoteImageIds ?? {})).not.toContain(firstImage)
      const snapshot = await todo()
      const image = await fetch(
        `${baseUrl}/api/todo/emails/synthetic-0/images/${firstImage}?token=${snapshot.imageToken}`,
      )
      expect(image.status).toBe(403)
    } finally {
      spy.mockRestore()
      spyMessage.mockRestore()
    }
  })

  it('creates a reply proposal and a draft without any send path', async () => {
    const snapshot = await todo()
    const proposal = await json<{ bodyText: string; warnings: string[] }>(
      '/api/todo/emails/demo-human/replies',
      post({ requestId: crypto.randomUUID(), roughNotes: 'Gerne Dienstag.' }, snapshot.csrfToken),
    )
    expect(proposal.response.status).toBe(200)
    expect(proposal.body.bodyText).toContain('Gerne Dienstag.')
    const draft = await json<{ draftId: string; verified: boolean }>(
      '/api/todo/emails/demo-human/drafts',
      post(
        {
          bodyText: 'Gerne Dienstag.',
          cc: [],
          identityId: 'demo-identity',
          requestId: crypto.randomUUID(),
          subject: 'Re: Essen nächste Woche?',
          to: [{ name: 'Sam', email: 'sam@example.com' }],
        },
        snapshot.csrfToken,
      ),
    )
    expect(draft.response.status).toBe(201)
    expect(draft.body.verified).toBe(true)
    const send = await fetch(
      `${baseUrl}/api/todo/emails/demo-human/send`,
      post({}, snapshot.csrfToken),
    )
    expect(send.status).toBe(404)
  })

  it('persists the reply editor per message', async () => {
    const snapshot = await todo()
    const editor = {
      bodyText: '',
      cc: [],
      identityId: 'demo-identity',
      revisionInstruction: '',
      roughNotes: 'Bitte kurz bestätigen.',
      subject: 'Re: Essen',
      to: [{ name: 'Sam', email: 'sam@example.com' }],
    }
    const saved = await json<{ editor: typeof editor }>(
      '/api/todo/emails/demo-human/editor',
      post({ editor }, snapshot.csrfToken, 'PUT'),
    )
    expect(saved.response.status).toBe(200)
    const loaded = await json<{ editor: typeof editor }>('/api/todo/emails/demo-human/editor')
    expect(loaded.body.editor.roughNotes).toBe('Bitte kurz bestätigen.')
  })

  it('updates memory notes and decides proposals', async () => {
    const snapshot = await todo()
    store.addProposal('Newsletter der Bahn zur Reise sortieren.')
    const saved = await json<TriageMemory>(
      '/api/todo/memory',
      post({ notes: 'Bahn gehört zur Reise.' }, snapshot.csrfToken, 'PUT'),
    )
    expect(saved.body.notes).toBe('Bahn gehört zur Reise.')
    const proposal = saved.body.proposals[0]
    expect(proposal).toBeDefined()
    const accepted = await json<TriageMemory>(
      `/api/todo/memory/proposals/${proposal?.id}/accept`,
      post({}, snapshot.csrfToken),
    )
    expect(accepted.body.notes).toContain('Newsletter der Bahn zur Reise sortieren.')
    expect(accepted.body.proposals).toEqual([])
  })

  it('refreshes on demand and rejects unknown routes', async () => {
    const snapshot = await todo()
    const refreshed = await json<TriageSnapshot>('/api/todo/refresh', post({}, snapshot.csrfToken))
    expect(refreshed.response.status).toBe(200)
    expect(refreshed.body.status.lastPollAt).not.toBeNull()
    const legacy = await fetch(`${baseUrl}/api/reviews`)
    expect(legacy.status).toBe(404)
  })
})
