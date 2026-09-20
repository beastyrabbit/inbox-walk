import { TRIAGE_MAX_ATTEMPTS, type TriageStatus } from '../src/shared.ts'
import { CodexAuthenticationError, isCodexAuthenticationFailure } from './codex.ts'
import { withoutIoDeadline } from './io.ts'
import type { Mailbox } from './mailbox.ts'
import type { TriageSorter } from './triage-sorter.ts'
import type { TriageStore } from './triage-store.ts'

const DEFAULT_POLL_INTERVAL_MS = 60_000
const PUSH_DEBOUNCE_MS = 2_000
const SORT_BATCH_SIZE = 8
const SUMMARY_PAGE_SIZE = 200

export interface TriageEngineOptions {
  /** Whether the sorter can run right now; false parks the queue until it changes. */
  canSort?: () => boolean
  engine: 'codex' | 'heuristic'
  mailbox: Mailbox
  model?: () => string | undefined
  pollIntervalMs?: number
  sorter: TriageSorter
  store: TriageStore
}

export interface TriageEngine {
  /** Runs a poll and a sort pass now, or joins the pass already running. */
  refresh(): Promise<void>
  /** Runs only the sort pass, for example after a manual retry. */
  sort(): Promise<void>
  start(): void
  status(): TriageStatus
  stop(): Promise<void>
}

function log(event: string, detail: Record<string, unknown> = {}) {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`)
}

function publicSortError(error: unknown) {
  if (error instanceof CodexAuthenticationError || isCodexAuthenticationFailure(error)) {
    return 'Codex muss erneut verbunden werden.'
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out/i.test(message)) return 'Codex hat nicht rechtzeitig geantwortet.'
  if (/network|fetch|connect|econn|dns/i.test(message)) return 'Codex war nicht erreichbar.'
  if (/context (?:length|window)|maximum (?:number of )?tokens/i.test(message)) {
    return 'Die Anfrage war für das Kontextfenster des Modells zu groß.'
  }
  return 'Die Sortierung ist fehlgeschlagen.'
}

export function publicPollError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/401|auth/i.test(message)) return 'Fastmail hat den Zugriff abgelehnt.'
  if (/timeout|timed out|abort/i.test(message)) return 'Fastmail hat nicht rechtzeitig geantwortet.'
  if (/network|fetch|connect|econn|dns/i.test(message)) return 'Fastmail war nicht erreichbar.'
  return 'Das Postfach konnte nicht abgefragt werden.'
}

/**
 * Keeps the todo in step with the mailbox. Every tick lists unread mail, queues
 * new messages, drops messages that were read elsewhere, and lets the sorter
 * place queued messages into buckets. Only user actions ever write to the
 * mailbox; this engine reads.
 */
export function createTriageEngine(options: TriageEngineOptions): TriageEngine {
  const { mailbox, sorter, store } = options
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<void> | null = null
  let sorting: Promise<void> | null = null
  let polling = false
  let waitingForCodex = false
  let pushConnected = false
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let watching: Promise<void> | null = null

  /** Push events arrive in bursts; one refresh shortly after the last one is enough. */
  function onPush() {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = undefined
      void refresh()
    }, PUSH_DEBOUNCE_MS)
  }

  async function poll() {
    const { signal } = controller
    polling = true
    try {
      const unreadIds = await mailbox.unreadIds(signal)
      signal.throwIfAborted()
      const unread = new Set(unreadIds)
      const tracked = store.trackedIds()
      const gone = [...tracked.keys()].filter((id) => !unread.has(id))
      if (gone.length > 0) store.markGone(gone)
      const fresh = unreadIds.filter((id) => !tracked.has(id))
      let added = 0
      for (let start = 0; start < fresh.length; start += SUMMARY_PAGE_SIZE) {
        signal.throwIfAborted()
        const { emails } = await mailbox.summaries(
          fresh.slice(start, start + SUMMARY_PAGE_SIZE),
          signal,
        )
        added += store.enqueue(emails)
      }
      store.recordPoll(new Date().toISOString(), null)
      if (added > 0 || gone.length > 0) log('triage_poll', { added, gone: gone.length })
    } catch (error) {
      if (signal.aborted) return
      log('triage_poll_failed', { message: error instanceof Error ? error.message : 'unknown' })
      store.recordPoll(new Date().toISOString(), publicPollError(error))
    } finally {
      polling = false
    }
  }

  async function sortPass() {
    const { signal } = controller
    while (!signal.aborted) {
      if (options.canSort && !options.canSort()) {
        waitingForCodex = true
        return
      }
      waitingForCodex = false
      const batch = store.queued(SORT_BATCH_SIZE, TRIAGE_MAX_ATTEMPTS)
      if (batch.length === 0) return
      const ids = batch.map(({ summary }) => summary.id)
      try {
        await sorter({ batch, mailbox, signal, store })
        signal.throwIfAborted()
        const unsorted = ids.filter((id) => store.message(id)?.status === 'queued')
        if (unsorted.length > 0) {
          store.recordAttempt(unsorted, 'Die Nachricht wurde nicht einsortiert.')
        }
        store.recordSort(new Date().toISOString(), null)
      } catch (error) {
        if (signal.aborted) return
        log('triage_sort_failed', { message: error instanceof Error ? error.message : 'unknown' })
        const reason = publicSortError(error)
        store.recordSort(new Date().toISOString(), reason)
        if (error instanceof CodexAuthenticationError || isCodexAuthenticationFailure(error)) {
          waitingForCodex = true
          return
        }
        store.recordAttempt(
          ids.filter((id) => store.message(id)?.status === 'queued'),
          reason,
        )
      }
    }
  }

  function sort() {
    if (sorting) return sorting
    sorting = withoutIoDeadline(sortPass).finally(() => {
      sorting = null
    })
    return sorting
  }

  /** One poll at a time; a refresh during a long sort still polls. */
  function pollOnce() {
    if (running) return running
    running = withoutIoDeadline(async () => {
      await poll()
      if (!controller.signal.aborted) store.prune()
    }).finally(() => {
      running = null
    })
    return running
  }

  async function refresh() {
    await pollOnce()
    if (!controller.signal.aborted) await sort()
  }

  return {
    refresh,
    sort,
    start() {
      if (timer) return
      timer = setInterval(() => void refresh(), pollIntervalMs)
      timer.unref()
      if (mailbox.watch && !watching) {
        const watch = mailbox.watch
        watching = withoutIoDeadline(() =>
          watch(onPush, controller.signal, (connected) => {
            pushConnected = connected
          }),
        ).catch((error) => {
          log('triage_push_failed', { message: error instanceof Error ? error.message : 'unknown' })
        })
      }
      void refresh()
    },
    status() {
      const run = store.runState()
      const counts = store.queueCounts(TRIAGE_MAX_ATTEMPTS)
      const model = options.model?.()
      return {
        engine: options.engine,
        failedCount: counts.failed,
        lastPollAt: run.lastPollAt,
        lastPollError: run.lastPollError,
        lastSortAt: run.lastSortAt,
        lastSortError: run.lastSortError,
        ...(model ? { model } : {}),
        polling,
        pushConnected,
        queuedCount: counts.queued,
        sorting: sorting !== null,
        waitingForCodex,
      }
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      if (pushTimer) clearTimeout(pushTimer)
      controller.abort(new DOMException('Triage engine stopped.', 'AbortError'))
      await Promise.allSettled([running, sorting, watching].filter(Boolean))
    },
  }
}
