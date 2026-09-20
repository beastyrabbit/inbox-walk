import { describe, expect, it, vi } from 'vitest'
import type { ReviewEmail } from '../src/shared.ts'
import { CodexAuthenticationError } from './codex.ts'
import { demoEmails } from './demo.ts'
import { createDemoMailbox } from './mailbox.ts'
import { createTriageEngine } from './triage-engine.ts'
import { heuristicSorter, type TriageSorter } from './triage-sorter.ts'
import { createTriageStore } from './triage-store.ts'

function nonSpam(emails: readonly ReviewEmail[]) {
  return emails.filter((email) => !email.mailboxNames.includes('Spam'))
}

describe('triage engine', () => {
  it('queues every unread demo message and sorts it with the local heuristic', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      pollIntervalMs: 60_000,
      sorter: heuristicSorter,
      store,
    })
    await engine.refresh()
    const todo = store.todo()
    expect(todo.every((bucket) => !bucket.unsorted)).toBe(true)
    const ids = todo.flatMap((bucket) => bucket.messages.map((item) => item.summary.id))
    expect(new Set(ids)).toEqual(new Set(nonSpam(demoEmails).map((email) => email.id)))
    const github = todo.find((bucket) =>
      bucket.messages.some((item) => item.summary.id === 'demo-github-merged'),
    )
    expect(github?.messages.map((item) => item.summary.id)).toEqual(
      expect.arrayContaining([
        'demo-github-opened',
        'demo-github-merged',
        'demo-railway-failed',
        'demo-railway-success',
      ]),
    )
    expect(engine.status()).toMatchObject({
      engine: 'heuristic',
      failedCount: 0,
      lastPollError: null,
      lastSortError: null,
      queuedCount: 0,
      waitingForCodex: false,
    })
    await engine.stop()
    store.close()
  })

  it('drops messages read elsewhere and keeps ones this app marked done', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      sorter: heuristicSorter,
      store,
    })
    await engine.refresh()
    await mailbox.markRead(['demo-train'])
    await engine.refresh()
    expect(store.message('demo-train')?.status).toBe('gone')
    expect(store.trackedIds().has('demo-train')).toBe(false)
    await engine.stop()
    store.close()
  })

  it('retries a failing sorter three times per message and then waits for the user', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox([demoEmails[0] as ReviewEmail])
    const sorter = vi.fn<TriageSorter>(async () => {
      throw new Error('fetch failed: ECONNRESET')
    })
    const engine = createTriageEngine({ engine: 'codex', mailbox, sorter, store })
    await engine.refresh()
    expect(sorter).toHaveBeenCalledTimes(3)
    expect(engine.status()).toMatchObject({
      failedCount: 1,
      lastSortError: 'Codex war nicht erreichbar.',
      queuedCount: 0,
    })
    await engine.refresh()
    expect(sorter).toHaveBeenCalledTimes(3)
    store.resetAttempts(['demo-train'])
    sorter.mockImplementation(heuristicSorter)
    await engine.sort()
    expect(sorter).toHaveBeenCalledTimes(4)
    expect(store.todo()[0]?.unsorted).toBe(false)
    await engine.stop()
    store.close()
  })

  it('pauses on an authentication failure without counting an attempt', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox([demoEmails[0] as ReviewEmail])
    let configured = false
    const sorter = vi.fn<TriageSorter>(async () => {
      throw new CodexAuthenticationError()
    })
    const engine = createTriageEngine({
      canSort: () => configured,
      engine: 'codex',
      mailbox,
      sorter,
      store,
    })
    await engine.refresh()
    expect(sorter).not.toHaveBeenCalled()
    expect(engine.status()).toMatchObject({ queuedCount: 1, waitingForCodex: true })
    configured = true
    await engine.sort()
    expect(sorter).toHaveBeenCalledTimes(1)
    expect(engine.status()).toMatchObject({
      lastSortError: 'Codex muss erneut verbunden werden.',
      waitingForCodex: true,
    })
    expect(store.message('demo-train')?.attempts).toBe(0)
    await engine.stop()
    store.close()
  })

  it('records a sorter that returns without assigning as one failed attempt', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox([demoEmails[0] as ReviewEmail])
    const sorter = vi.fn<TriageSorter>(async () => {})
    const engine = createTriageEngine({ engine: 'codex', mailbox, sorter, store })
    await engine.refresh()
    expect(sorter).toHaveBeenCalledTimes(3)
    expect(store.message('demo-train')).toMatchObject({
      attempts: 3,
      lastError: 'Die Nachricht wurde nicht einsortiert.',
      status: 'queued',
    })
    await engine.stop()
    store.close()
  })

  it('reports a mailbox outage without losing the existing list', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      sorter: heuristicSorter,
      store,
    })
    await engine.refresh()
    const before = store.todo().length
    vi.spyOn(mailbox, 'unreadIds').mockRejectedValueOnce(new Error('fetch failed'))
    await engine.refresh()
    expect(engine.status().lastPollError).toBe('Fastmail war nicht erreichbar.')
    expect(store.todo()).toHaveLength(before)
    await engine.stop()
    store.close()
  })

  it('refreshes on push notifications and reports the connection state', async () => {
    vi.useFakeTimers()
    try {
      const store = createTriageStore(':memory:')
      const mailbox = createDemoMailbox()
      let notify: (() => void) | undefined
      let setStatus: ((connected: boolean) => void) | undefined
      const watch = vi.fn<NonNullable<typeof mailbox.watch>>(
        (onChange, signal, onStatus) =>
          new Promise<void>((resolve) => {
            notify = onChange
            setStatus = onStatus
            onStatus?.(true)
            signal.addEventListener('abort', () => resolve(), { once: true })
          }),
      )
      const engine = createTriageEngine({
        engine: 'heuristic',
        mailbox: { ...mailbox, watch },
        pollIntervalMs: 3_600_000,
        sorter: heuristicSorter,
        store,
      })
      engine.start()
      await vi.runOnlyPendingTimersAsync()
      expect(watch).toHaveBeenCalledOnce()
      expect(engine.status().pushConnected).toBe(true)
      await mailbox.markRead(['demo-train'])
      notify?.()
      notify?.()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(store.message('demo-train')?.status).toBe('gone')
      setStatus?.(false)
      expect(engine.status().pushConnected).toBe(false)
      await engine.stop()
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
