import type {
  DraftResult,
  MailboxOption,
  MailIdentity,
  MailResource,
  ReplyProposal,
  ReviewEmail,
  ReviewEmailSummary,
  ThreadMessage,
} from '../src/shared.ts'
import { demoEmails } from './demo.ts'
import {
  createAndVerifyDraft,
  type DraftInput,
  downloadBlob,
  fetchEmailDetail,
  fetchEmailSummaries,
  fetchIdentities,
  fetchMailAccount,
  fetchThread,
  JmapError,
  type MailAccount,
  type MailboxActionResult,
  type MailSearchHit,
  type MailSearchQuery,
  type MarkReadResult,
  markEmailsRead,
  queryUnreadEmailIds,
  searchEmailSummaries,
  tagEmailsForLaterUnsubscribe,
  watchMailChanges,
} from './jmap.ts'
import { generateReply, type ReplyRequest } from './reply.ts'

const ACCOUNT_TTL_MS = 10 * 60_000

/**
 * The one place that talks to the mail account. The live implementation uses
 * Fastmail over JMAP; the demo implementation serves fixed sample mail and
 * never leaves the process. Nothing here can send mail.
 */
export interface Mailbox {
  createDraft(input: DraftInput): Promise<DraftResult>
  detail(emailId: string): Promise<ReviewEmail>
  downloadBlob(resource: MailResource, signal: AbortSignal): Promise<Response>
  generateReply(messages: ThreadMessage[], request: ReplyRequest): Promise<ReplyProposal>
  identities(): Promise<MailIdentity[]>
  mailboxes(): Promise<MailboxOption[]>
  markRead(emailIds: readonly string[]): Promise<MarkReadResult>
  readonly mode: 'demo' | 'live'
  search(query: MailSearchQuery, signal?: AbortSignal): Promise<MailSearchHit[]>
  /** Summaries of incoming, non-spam mail; other IDs are reported as excluded. */
  summaries(
    emailIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ emails: ReviewEmailSummary[]; excludedIds: string[] }>
  tagNewsletter(emailIds: readonly string[]): Promise<MailboxActionResult>
  thread(threadId: string): Promise<ThreadMessage[]>
  /** Every unread, non-draft message outside Spam. */
  unreadIds(signal?: AbortSignal): Promise<string[]>
  /** Demo only: forget every read mark so tests start from the full sample inbox. */
  reset?(): void
  /** Live only: push notifications for mail changes until the signal aborts. */
  watch?(
    onChange: () => void,
    signal: AbortSignal,
    onStatus?: (connected: boolean) => void,
  ): Promise<void>
}

export function createLiveMailbox(token: string): Mailbox {
  let cached: { account: MailAccount; loadedAt: number } | undefined

  async function account(signal?: AbortSignal) {
    if (cached && Date.now() - cached.loadedAt < ACCOUNT_TTL_MS) return cached.account
    const loaded = await fetchMailAccount(token, signal)
    cached = { account: loaded, loadedAt: Date.now() }
    return loaded
  }

  /** A failed call may mean the session moved; resolve the account again next time. */
  async function withAccount<T>(work: (current: MailAccount) => Promise<T>, signal?: AbortSignal) {
    const current = await account(signal)
    try {
      return await work(current)
    } catch (error) {
      if (error instanceof JmapError) cached = undefined
      throw error
    }
  }

  return {
    mode: 'live',
    createDraft: (input) =>
      withAccount(({ context }) => createAndVerifyDraft(context, token, input)),
    detail: (emailId) =>
      withAccount(({ context, mailboxes }) => fetchEmailDetail(context, token, emailId, mailboxes)),
    downloadBlob: (resource, signal) =>
      withAccount(({ context }) => downloadBlob(context, token, resource, signal), signal),
    generateReply: (messages, request) =>
      withAccount(({ context }) => generateReply(context, token, messages, request)),
    identities: () => withAccount(({ context }) => fetchIdentities(context, token)),
    mailboxes: async () => (await account()).mailboxes,
    markRead: (emailIds) => withAccount(({ context }) => markEmailsRead(context, token, emailIds)),
    search: (query, signal) =>
      withAccount((current) => searchEmailSummaries(current, token, query, signal), signal),
    summaries: (emailIds, signal) =>
      withAccount((current) => fetchEmailSummaries(current, token, emailIds, signal), signal),
    tagNewsletter: (emailIds) =>
      withAccount(({ context }) => tagEmailsForLaterUnsubscribe(context, token, emailIds)),
    thread: (threadId) =>
      withAccount(({ context, mailboxes }) => fetchThread(context, token, threadId, mailboxes)),
    unreadIds: (signal) =>
      withAccount((current) => queryUnreadEmailIds(current, token, signal), signal),
    watch: (onChange, signal, onStatus) => watchMailChanges(token, onChange, signal, onStatus),
  }
}

/** Every attachment and inline resource of a thread, once per blob. */
export function threadResources(messages: readonly ThreadMessage[]) {
  const resources = new Map<string, MailResource>()
  for (const message of messages) {
    for (const resource of [...message.inlineResources, ...message.attachments]) {
      resources.set(resource.blobId, resource)
    }
  }
  return [...resources.values()]
}

function summaryOf(email: ReviewEmail): ReviewEmailSummary {
  return {
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
  }
}

function isDemoSpam(email: ReviewEmail) {
  return email.mailboxNames.some((name) => /^(spam|junk)$/i.test(name))
}

/** In-memory sample mailbox. Reads and labels only change this process. */
export function createDemoMailbox(messages: readonly ReviewEmail[] = demoEmails): Mailbox {
  const readIds = new Set<string>()
  const byId = new Map(messages.map((email) => [email.id, email]))

  return {
    mode: 'demo',
    createDraft: async (input) => ({
      draftId: `demo-draft-${Date.now()}`,
      recovered: false,
      threadId: input.threadId,
      verified: true,
    }),
    detail: async (emailId) => {
      const email = byId.get(emailId)
      if (!email) throw new JmapError('Nachricht wurde nicht gefunden.', 'EMAIL_NOT_FOUND', 404)
      return email
    },
    downloadBlob: async () => {
      throw new JmapError('Datei nicht gefunden.', 'BLOB_NOT_FOUND', 404)
    },
    generateReply: async (messages, request) => ({
      attachmentManifest: threadResources(messages),
      bodyText:
        request.currentDraft?.trim() ||
        request.roughNotes.trim() ||
        'Danke für deine Nachricht. Ich melde mich dazu in Kürze noch einmal.',
      questions: [],
      requestId: request.requestId,
      supportedDetails: [],
      warnings: [
        `Demo-Modus: Es wurde keine Anfrage an Codex gesendet (${messages.length} Thread-Nachrichten).`,
      ],
    }),
    identities: async () => [
      {
        id: 'demo-identity',
        name: 'Alex',
        email: 'alex@example.com',
        textSignature: 'Viele Grüße\nAlex',
        htmlSignature: '<div>Viele Grüße<br>Alex</div>',
      },
    ],
    mailboxes: async () => [
      { id: 'Inbox', name: 'Inbox', role: 'inbox' },
      { id: 'Newsletter', name: 'Newsletter' },
      { id: 'Reisen', name: 'Reisen' },
      { id: 'Spam', name: 'Spam', role: 'junk' },
    ],
    markRead: async (emailIds) => {
      for (const id of emailIds) readIds.add(id)
      return { failed: [], markedIds: [...emailIds] }
    },
    search: async (query) => {
      const needle = (query.text ?? query.subject ?? query.from ?? '').toLowerCase()
      return messages
        .filter((email) => !isDemoSpam(email))
        .filter((email) =>
          `${email.subject} ${email.preview} ${email.from.map((from) => from.email).join(' ')}`
            .toLowerCase()
            .includes(needle),
        )
        .slice(0, query.limit)
        .map((email) => ({ ...summaryOf(email), unread: !readIds.has(email.id) }))
    },
    summaries: async (emailIds) => {
      const emails: ReviewEmailSummary[] = []
      const excludedIds: string[] = []
      for (const id of emailIds) {
        const email = byId.get(id)
        if (email && !isDemoSpam(email)) emails.push(summaryOf(email))
        else excludedIds.push(id)
      }
      return { emails, excludedIds }
    },
    tagNewsletter: async (emailIds) => ({ failed: [], succeededIds: [...emailIds] }),
    thread: async (threadId) =>
      messages
        .filter((email) => email.threadId === threadId)
        .map((email) => ({ ...email, sentAt: null })),
    unreadIds: async () =>
      messages.filter((email) => !readIds.has(email.id) && !isDemoSpam(email)).map(({ id }) => id),
    reset: () => readIds.clear(),
  }
}
