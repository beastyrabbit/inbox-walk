import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewEmail } from '../src/shared.ts'
import { CodexAuthenticationError } from './codex.ts'
import { demoEmails } from './demo.ts'
import { IoError } from './io.ts'
import { JmapError } from './jmap.ts'
import { createDemoMailbox } from './mailbox.ts'
import * as telemetry from './telemetry.ts'
import { createTriageEngine } from './triage-engine.ts'
import { heuristicSorter, type TriageSorter } from './triage-sorter.ts'
import { createTriageStore } from './triage-store.ts'

function nonSpam(emails: readonly ReviewEmail[]) {
  return emails.filter((email) => !email.mailboxNames.includes('Spam'))
}

describe('triage engine', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('drops tracked mail that is unread but no longer incoming', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      sorter: heuristicSorter,
      store,
    })
    await engine.refresh()
    expect(store.message('demo-train')?.status).toBe('sorted')
    const original = mailbox.summaries
    vi.spyOn(mailbox, 'summaries').mockImplementation(async (ids, signal) => {
      const result = await original(ids, signal)
      return {
        emails: result.emails.filter((email) => email.id !== 'demo-train'),
        excludedIds: ids.includes('demo-train') ? ['demo-train'] : result.excludedIds,
      }
    })
    await engine.refresh()
    expect(store.message('demo-train')?.status).toBe('gone')
    expect(store.todo().flatMap((bucket) => bucket.messages)).toHaveLength(8)
    await engine.stop()
    store.close()
  })

  it('retries a failing sorter three times per message and then waits for the user', async () => {
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox([demoEmails[0] as ReviewEmail])
    const failure = new Error('fetch failed: ECONNRESET')
    const sorter = vi.fn<TriageSorter>(async () => {
      throw failure
    })
    const engine = createTriageEngine({ engine: 'codex', mailbox, sorter, store })
    await engine.refresh()
    expect(sorter).toHaveBeenCalledTimes(3)
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(failure)
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
    expect(report).toHaveBeenCalledOnce()
    await engine.stop()
    store.close()
  })

  it('does not report a transient sort failure that a retry recovers from', async () => {
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox([demoEmails[0] as ReviewEmail])
    const sorter = vi.fn<TriageSorter>(heuristicSorter)
    sorter.mockRejectedValueOnce(new Error('Codex error: An error occurred while processing.'))
    const engine = createTriageEngine({ engine: 'codex', mailbox, sorter, store })
    await engine.refresh()
    expect(sorter).toHaveBeenCalledTimes(2)
    expect(store.message('demo-train')?.status).toBe('sorted')
    expect(report).not.toHaveBeenCalled()
    await engine.stop()
    store.close()
  })

  it('pauses on an authentication failure without counting an attempt', async () => {
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
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
    expect(report).toHaveBeenCalledOnce()
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
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
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
    expect(report).not.toHaveBeenCalled()
    await engine.stop()
    store.close()
  })

  it.each([
    new TypeError('fetch failed'),
    new Error('read ECONNRESET'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    new IoError(
      'Der externe Abruf hat sein Zeitlimit überschritten oder wurde abgebrochen.',
      'IO_TIMEOUT',
    ),
    new JmapError('Fastmail session failed (503)', 'FASTMAIL_SESSION_FAILED', 503),
    new JmapError('Fastmail request failed (429)', 'FASTMAIL_REQUEST_FAILED', 429),
  ])('reports a persistent poll outage once at the third failure: %s', async (failure) => {
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    vi.spyOn(mailbox, 'unreadIds').mockRejectedValue(failure)
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      sorter: heuristicSorter,
      store,
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      await engine.refresh()
      expect(engine.status().lastPollError).not.toBeNull()
      expect(engine.status().lastPollAt).not.toBeNull()
      expect(report).not.toHaveBeenCalled()
    }
    await engine.refresh()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    await engine.refresh()
    expect(report).toHaveBeenCalledOnce()
    await engine.stop()
    store.close()
  })

  it('resets the poll failure streak only after the whole poll succeeds', async () => {
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    const summaries = vi.spyOn(mailbox, 'summaries')
    const failure = new TypeError('fetch failed')
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      sorter: heuristicSorter,
      store,
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      summaries.mockRejectedValueOnce(failure)
      await engine.refresh()
    }
    expect(report).not.toHaveBeenCalled()
    await engine.refresh()
    expect(engine.status().lastPollError).toBeNull()
    for (let attempt = 0; attempt < 3; attempt++) {
      summaries.mockRejectedValueOnce(failure)
      await engine.refresh()
      expect(report).toHaveBeenCalledTimes(attempt === 2 ? 1 : 0)
    }
    await engine.refresh()
    expect(engine.status().lastPollError).toBeNull()
    for (let attempt = 0; attempt < 3; attempt++) {
      summaries.mockRejectedValueOnce(failure)
      await engine.refresh()
      expect(report).toHaveBeenCalledTimes(attempt === 2 ? 2 : 1)
    }
    await engine.stop()
    store.close()
  })

  it.each([
    new JmapError('Fastmail session failed (401)', 'FASTMAIL_AUTH_EXPIRED', 401),
    new JmapError('Fastmail request failed (403)', 'FASTMAIL_REQUEST_FAILED', 403),
    new JmapError('Fastmail session has no primary mail account', 'NO_MAIL_ACCOUNT'),
    new JmapError('Fastmail returned no responses', 'INVALID_JMAP'),
  ])(
    'reports auth and configuration errors immediately even during an outage: %s',
    async (failure) => {
      const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
      const store = createTriageStore(':memory:')
      const mailbox = createDemoMailbox()
      const unread = vi.spyOn(mailbox, 'unreadIds').mockRejectedValue(failure)
      const engine = createTriageEngine({
        engine: 'heuristic',
        mailbox,
        sorter: heuristicSorter,
        store,
      })
      await engine.refresh()
      expect(report).toHaveBeenCalledExactlyOnceWith(failure)
      if (failure.status === 401 || failure.status === 403) {
        expect(engine.status().lastPollError).toBe('Fastmail hat den Zugriff abgelehnt.')
      }
      unread.mockRejectedValue(new TypeError('fetch failed'))
      for (let attempt = 0; attempt < 3; attempt++) await engine.refresh()
      report.mockClear()
      unread.mockRejectedValue(failure)
      await engine.refresh()
      expect(report).toHaveBeenCalledExactlyOnceWith(failure)
      await engine.stop()
      store.close()
    },
  )

  it('does not report or record a shutdown-aborted poll at the failure threshold', async () => {
    const report = vi.spyOn(telemetry, 'reportServerError').mockImplementation(() => {})
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    const unread = vi.spyOn(mailbox, 'unreadIds').mockRejectedValue(new TypeError('fetch failed'))
    const engine = createTriageEngine({
      engine: 'heuristic',
      mailbox,
      sorter: heuristicSorter,
      store,
    })
    await engine.refresh()
    await engine.refresh()
    const before = store.runState()
    const recordPoll = vi.spyOn(store, 'recordPoll')
    let entered: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    unread.mockImplementationOnce(
      (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          entered()
        }),
    )
    const refresh = engine.refresh()
    await pending
    await engine.stop()
    await refresh
    expect(report).not.toHaveBeenCalled()
    expect(recordPoll).not.toHaveBeenCalled()
    expect(store.runState()).toEqual(before)
    expect(engine.status().polling).toBe(false)
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

  it('keeps polling while a long sort is running', async () => {
    const store = createTriageStore(':memory:')
    const mailbox = createDemoMailbox()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sorter = vi.fn<TriageSorter>(async (context) => {
      await gate
      await heuristicSorter(context)
    })
    const engine = createTriageEngine({ engine: 'codex', mailbox, sorter, store })
    const first = engine.refresh()
    await expect.poll(() => sorter.mock.calls.length).toBe(1)
    await mailbox.markRead(['demo-train'])
    const second = engine.refresh()
    await expect.poll(() => store.message('demo-train')?.status).toBe('gone')
    release()
    await Promise.all([first, second])
    expect(store.queueCounts(3).queued).toBe(0)
    await engine.stop()
    store.close()
  })
})
