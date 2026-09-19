import { createApiMiddleware } from './api.ts'
import { codexAuthStatus, ensureCodexStorageReady, selectedCodexSettings } from './codex.ts'
import { createDemoMailbox, createLiveMailbox, type Mailbox } from './mailbox.ts'
import { createTriageEngine } from './triage-engine.ts'
import { createCodexSorter, heuristicSorter } from './triage-sorter.ts'
import { createTriageStore } from './triage-store.ts'

export interface RuntimeOptions {
  fastmailToken?: string
  forceDemo: boolean
  pollIntervalMs?: number
}

/** Builds the store, mailbox, engine and API for one process. */
export function createRuntime(options: RuntimeOptions) {
  const mailbox: Mailbox = options.forceDemo
    ? createDemoMailbox()
    : createLiveMailbox(requireToken(options.fastmailToken))
  if (!options.forceDemo) ensureCodexStorageReady()
  const store = createTriageStore()
  const live = mailbox.mode === 'live'
  const engine = createTriageEngine({
    canSort: live ? () => codexAuthStatus().configured : undefined,
    engine: live ? 'codex' : 'heuristic',
    mailbox,
    model: live ? () => selectedCodexSettings().model : undefined,
    pollIntervalMs: options.pollIntervalMs ?? pollIntervalFromEnvironment(),
    sorter: live ? createCodexSorter() : heuristicSorter,
    store,
  })
  const api = createApiMiddleware({ engine, mailbox, store })
  return {
    api,
    engine,
    async close() {
      await engine.stop()
      store.close()
    },
    start() {
      engine.start()
    },
  }
}

function requireToken(token: string | undefined) {
  const trimmed = token?.trim()
  if (!trimmed)
    throw new Error('FASTMAIL_JMAP_TOKEN is required unless MAIL_REVIEW_DEMO=1 is explicit')
  return trimmed
}

function pollIntervalFromEnvironment() {
  const configured = Number(process.env.TRIAGE_POLL_INTERVAL_MS?.trim() || 60_000)
  return Number.isFinite(configured) ? Math.min(3_600_000, Math.max(5_000, configured)) : 60_000
}
