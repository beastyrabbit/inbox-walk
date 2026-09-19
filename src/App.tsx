import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { api, blobUrl, ClientApiError, type CodexSettings } from './api.ts'
import { emailDocument, type MailColorMode } from './email-document.ts'
import {
  addressesToText,
  applyReplyProposal,
  parseAddresses,
  patchReplyEditor,
} from './reply-editor.ts'
import {
  type CodexLoginState,
  type CodexSpeed,
  type CodexThinkingLevel,
  codexModelLabel,
  type DraftResult,
  type MailAddress,
  type ReplyEditorState,
  type ReplyProposal,
  type ReviewEmail,
  type ReviewEmailSummary,
  type ThreadContext,
  TRIAGE_MEMORY_MAX_LENGTH,
  type TriageBucket,
  type TriageMemory,
  type TriageMessage,
  type TriageSnapshot,
  type TriageStatus,
} from './shared.ts'

export { emailDocument } from './email-document.ts'

const LIST_POLL_INTERVAL_MS = 15_000
const EDITOR_SAVE_DELAY_MS = 750
const PARKED_PREFIX = 'parked:'

function addressLine(addresses: MailAddress[]) {
  if (addresses.length === 0) return 'Unbekannter Absender'
  return addresses.map((address) => address.name || address.email).join(', ')
}

function fullAddress(addresses: MailAddress[]) {
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.email}>` : address.email))
    .join(', ')
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function initials(addresses: MailAddress[]) {
  const source = addresses[0]?.name || addresses[0]?.email || '?'
  const words = source
    .replace(/[<>"]/g, '')
    .trim()
    .split(/[\s._@-]+/)
    .filter(Boolean)
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase('de-DE') ?? '')
    .join('')
}

const MAIL_COLOR_STORAGE_KEY = 'inbox-walk.mail-colors'

function storedMailColorMode(): MailColorMode {
  try {
    return window.localStorage.getItem(MAIL_COLOR_STORAGE_KEY) === 'original' ? 'original' : 'dark'
  } catch {
    return 'dark'
  }
}

function errorMessage(error: unknown) {
  if (error instanceof ClientApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Ein unbekannter Fehler ist aufgetreten.'
}

function initialEditor(context: ThreadContext): ReplyEditorState {
  return {
    bodyText: '',
    cc: context.recipients.cc,
    identityId: context.recipients.identityId,
    revisionInstruction: '',
    roughNotes: '',
    subject: context.recipients.subject,
    to: context.recipients.to,
  }
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function bucketIdFromPath() {
  const match = window.location.pathname.match(/^\/buckets\/([^/]+)\/?$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function setBucketUrl(bucketId: string | null, replace = false) {
  const next = bucketId ? `/buckets/${encodeURIComponent(bucketId)}` : '/'
  if (window.location.pathname === next) return
  window.history[replace ? 'replaceState' : 'pushState']({}, '', next)
}

function messageSource(summary: ReviewEmailSummary) {
  const name = summary.from[0]?.name?.trim()
  if (name) return name
  return summary.from[0]?.email?.split('@').at(-1) ?? 'E-Mail'
}

function kindLabel(kind: TriageBucket['kind']) {
  switch (kind) {
    case 'order_delivery':
      return 'Bestellung'
    case 'development_workstream':
      return 'Entwicklung'
    case 'incident':
      return 'Störung'
    case 'conversation':
      return 'Gespräch'
    default:
      return 'Einzeln'
  }
}

function relativeTime(value: string | null) {
  if (!value) return 'noch nie'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 60) return 'gerade eben'
  if (seconds < 3_600) return `vor ${Math.round(seconds / 60)} Min.`
  if (seconds < 86_400) return `vor ${Math.round(seconds / 3_600)} Std.`
  return formatDate(value)
}

function statusLine(status: TriageStatus, mode: 'demo' | 'live') {
  if (status.waitingForCodex) return 'Sortierung wartet auf die Codex-Anmeldung.'
  if (status.polling) return 'Postfach wird abgefragt …'
  if (status.sorting) {
    return `${status.queuedCount} ${status.queuedCount === 1 ? 'Nachricht wird' : 'Nachrichten werden'} sortiert …`
  }
  if (status.lastPollError) return status.lastPollError
  if (status.lastSortError) return `${status.lastSortError} Wird automatisch erneut versucht.`
  if (status.queuedCount > 0)
    return `${status.queuedCount} neue Nachrichten warten auf die Sortierung.`
  const origin =
    mode === 'demo'
      ? 'Lokale Sortierung'
      : `Codex${status.model ? ` · ${codexModelLabel(status.model)}` : ''}`
  return `${origin} · Postfach zuletzt geprüft ${relativeTime(status.lastPollAt)}`
}

function parkedBucket(message: TriageMessage): TriageBucket {
  const { summary } = message
  return {
    activityAt: summary.receivedAt,
    bucketId: `${PARKED_PREFIX}${summary.id}`,
    currentState: 'Geparkt',
    handledCount: 0,
    kind: 'standalone',
    linkEvidence: [],
    messages: [message],
    summary: summary.preview || summary.subject,
    title: summary.subject || '(Kein Betreff)',
    unsorted: false,
  }
}

function useFocusRegion<T extends HTMLElement>(trap: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const region = ref.current
    if (!region) return
    const selector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const focusables = () => [...region.querySelectorAll<HTMLElement>(selector)]
    ;(region.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? region).focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (!trap || event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        region.focus()
        return
      }
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    region.addEventListener('keydown', onKeyDown)
    return () => {
      region.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [trap])
  return ref
}

function App() {
  const [snapshot, setSnapshot] = useState<TriageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [bucketId, setBucketId] = useState<string | null>(bucketIdFromPath)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, ReviewEmail>>({})
  const [pendingDetails, setPendingDetails] = useState<Set<string>>(new Set())
  const [failedDetails, setFailedDetails] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showParked, setShowParked] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [codexLogin, setCodexLogin] = useState<CodexLoginState | null>(null)
  const [codexLoginBusy, setCodexLoginBusy] = useState(false)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [threadContexts, setThreadContexts] = useState<Record<string, ThreadContext>>({})
  const [replyDrafts, setReplyDrafts] = useState<Record<string, ReplyEditorState>>({})
  const [replyProposals, setReplyProposals] = useState<Record<string, ReplyProposal>>({})
  const [draftResults, setDraftResults] = useState<Record<string, DraftResult>>({})
  const [replyLoading, setReplyLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [mailColorMode, setMailColorModeState] = useState<MailColorMode>(storedMailColorMode)
  const detailRequestsRef = useRef(new Map<string, Promise<ReviewEmail>>())
  const replyBodyEditsRef = useRef(new Map<string, number>())
  const editorSaveTimersRef = useRef(new Map<string, number>())
  const snapshotRef = useRef<TriageSnapshot | null>(null)
  snapshotRef.current = snapshot

  const setMailColorMode = useCallback((mode: MailColorMode) => {
    setMailColorModeState(mode)
    try {
      window.localStorage.setItem('inbox-walk.mail-color-mode', mode)
    } catch {
      // The preference simply resets when storage is unavailable.
    }
  }, [])

  const buckets = snapshot?.buckets ?? []
  const parked = snapshot?.parked ?? []
  const bucket = useMemo(() => {
    if (!bucketId) return undefined
    if (bucketId.startsWith(PARKED_PREFIX)) {
      const message = parked.find(
        (item) => item.summary.id === bucketId.slice(PARKED_PREFIX.length),
      )
      return message ? parkedBucket(message) : undefined
    }
    return buckets.find((item) => item.bucketId === bucketId)
  }, [bucketId, buckets, parked])
  const isParkedView = Boolean(bucketId?.startsWith(PARKED_PREFIX))
  const messages = bucket?.messages ?? []
  const summary =
    messages.find((message) => message.summary.id === selectedMemberId)?.summary ??
    messages[0]?.summary
  const email = summary ? details[summary.id] : undefined
  const editor = summary ? replyDrafts[summary.id] : undefined
  const thread = summary ? threadContexts[summary.id] : undefined
  const proposal = summary ? replyProposals[summary.id] : undefined
  const draftResult = summary ? draftResults[summary.id] : undefined
  const codexLoginId = codexLogin?.id
  const codexLoginStatus = codexLogin?.status
  const openCount = buckets.reduce((count, item) => count + item.messages.length, 0)

  const applySnapshot = useCallback((next: TriageSnapshot) => {
    setSnapshot(next)
    setError(null)
  }, [])

  const load = useCallback(async () => {
    const next = await api.todo()
    applySnapshot(next)
    return next
  }, [applySnapshot])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } catch (cause) {
        if (active) setError(errorMessage(cause))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  useEffect(() => {
    let polling = false
    const poll = async () => {
      if (polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        await load()
      } catch {
        // The last known list stays visible; a manual refresh reports the error.
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => void poll(), LIST_POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  useEffect(() => {
    const onPopState = () => {
      setBucketId(bucketIdFromPath())
      setReplyOpen(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!bucket) return
    if (
      !selectedMemberId ||
      !bucket.messages.some((item) => item.summary.id === selectedMemberId)
    ) {
      setSelectedMemberId(bucket.messages[0]?.summary.id ?? null)
    }
  }, [bucket, selectedMemberId])

  useEffect(() => {
    if (!snapshot || !bucketId || loading) return
    if (!bucket) {
      setBucketUrl(null, true)
      setBucketId(null)
      setReplyOpen(false)
      setStatus('Dieser Bucket ist nicht mehr offen.')
    }
  }, [bucket, bucketId, loading, snapshot])

  useEffect(() => {
    if (!codexLoginId || !codexLoginStatus || !['starting', 'waiting'].includes(codexLoginStatus))
      return
    let active = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const next = await api.codexLoginState(codexLoginId)
        if (!active) return
        if (next.status === 'completed') {
          const auth = await api.codexStatus()
          if (!active) return
          setSnapshot((current) => (current ? { ...current, codex: auth } : current))
          setCodexLogin(next)
          return
        }
        setCodexLogin(next)
      } catch (cause) {
        if (active) {
          setCodexLogin({
            id: codexLoginId,
            status: 'failed',
            message:
              cause instanceof ClientApiError && cause.status === 404
                ? 'Die Anmeldung ist nach einem App-Neustart abgelaufen. Bitte starte sie erneut.'
                : 'Der Anmeldestatus konnte nicht geladen werden. Bitte starte die Anmeldung erneut.',
          })
        }
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [codexLoginId, codexLoginStatus])

  const loadDetail = useCallback(
    (emailId: string) => {
      if (details[emailId] || pendingDetails.has(emailId) || failedDetails.has(emailId)) return
      let request = detailRequestsRef.current.get(emailId)
      if (!request) {
        request = api.email(emailId)
        detailRequestsRef.current.set(emailId, request)
      }
      setPendingDetails((current) => new Set(current).add(emailId))
      void request
        .then((loaded) => setDetails((current) => ({ ...current, [loaded.id]: loaded })))
        .catch((cause) => {
          detailRequestsRef.current.delete(emailId)
          setFailedDetails((current) => new Set(current).add(emailId))
          setError(errorMessage(cause))
        })
        .finally(() =>
          setPendingDetails((current) => {
            const next = new Set(current)
            next.delete(emailId)
            return next
          }),
        )
    },
    [details, failedDetails, pendingDetails],
  )

  useEffect(() => {
    if (!bucket) return
    for (const message of bucket.messages) loadDetail(message.summary.id)
  }, [bucket, loadDetail])

  const openBucket = useCallback((id: string, replace = false) => {
    setBucketUrl(id, replace)
    setBucketId(id)
    setSelectedMemberId(null)
    setReplyOpen(false)
    setError(null)
  }, [])

  const backToList = useCallback(() => {
    setBucketUrl(null)
    setBucketId(null)
    setReplyOpen(false)
  }, [])

  const runAction = useCallback(
    async (
      action: 'done' | 'park' | 'unpark' | 'newsletter' | 'retry',
      emailIds: string[],
      successStatus: string,
    ) => {
      const current = snapshotRef.current
      if (!current || emailIds.length === 0) return false
      setBusy(true)
      setError(null)
      try {
        const result = await api.messageAction(action, emailIds, current.csrfToken)
        applySnapshot(result.snapshot)
        if (result.failed.length > 0) {
          setError(
            `${result.failed.length} ${result.failed.length === 1 ? 'Änderung ist' : 'Änderungen sind'} fehlgeschlagen: ${result.failed.map((item) => item.reason).join(' ')}`,
          )
          return false
        }
        setStatus(successStatus)
        return true
      } catch (cause) {
        setError(errorMessage(cause))
        return false
      } finally {
        setBusy(false)
      }
    },
    [applySnapshot],
  )

  const nextBucketAfter = useCallback(
    (currentId: string) => {
      const index = buckets.findIndex((item) => item.bucketId === currentId)
      return buckets[index + 1] ?? buckets[index - 1]
    },
    [buckets],
  )

  const completeBucket = useCallback(async () => {
    if (!bucket || busy || isParkedView) return
    const ids = bucket.messages.map((message) => message.summary.id)
    const following = nextBucketAfter(bucket.bucketId)
    const ok = await runAction(
      'done',
      ids,
      `${ids.length} ${ids.length === 1 ? 'Nachricht' : 'Nachrichten'} als gelesen markiert.`,
    )
    if (!ok) return
    if (following) openBucket(following.bucketId, true)
    else backToList()
  }, [backToList, bucket, busy, isParkedView, nextBucketAfter, openBucket, runAction])

  const parkSelected = useCallback(async () => {
    if (!bucket || !summary || busy) return
    if (isParkedView) {
      const ok = await runAction('unpark', [summary.id], 'Nachricht ist zurück in der Liste.')
      if (ok) backToList()
      return
    }
    const last = bucket.messages.length === 1
    const following = last ? nextBucketAfter(bucket.bucketId) : undefined
    const ok = await runAction('park', [summary.id], 'Nachricht geparkt; sie bleibt ungelesen.')
    if (!ok || !last) return
    if (following) openBucket(following.bucketId, true)
    else backToList()
  }, [backToList, bucket, busy, isParkedView, nextBucketAfter, openBucket, runAction, summary])

  const tagNewsletter = useCallback(async () => {
    if (!summary || busy || !summary.isNewsletter) return
    await runAction('newsletter', [summary.id], 'Mit „Newsletter abmelden“ markiert.')
  }, [busy, runAction, summary])

  const refreshNow = useCallback(async () => {
    const current = snapshotRef.current
    if (!current || refreshing) return
    setRefreshing(true)
    setError(null)
    try {
      applySnapshot(await api.refresh(current.csrfToken))
      setStatus('Postfach geprüft.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRefreshing(false)
    }
  }, [applySnapshot, refreshing])

  const scheduleEditorSave = useCallback((emailId: string, next: ReplyEditorState) => {
    const timers = editorSaveTimersRef.current
    const existing = timers.get(emailId)
    if (existing) window.clearTimeout(existing)
    timers.set(
      emailId,
      window.setTimeout(() => {
        timers.delete(emailId)
        const current = snapshotRef.current
        if (!current) return
        void api.saveReplyEditor(emailId, next, current.csrfToken).catch(() => {
          setStatus('Der Entwurfsstand konnte nicht gespeichert werden.')
        })
      }, EDITOR_SAVE_DELAY_MS),
    )
  }, [])

  const openReply = useCallback(async () => {
    if (!summary) return
    setReplyOpen(true)
    setHelpOpen(false)
    if (threadContexts[summary.id]) return
    setReplyLoading(true)
    setError(null)
    try {
      const [context, saved] = await Promise.all([
        api.thread(summary.threadId, summary.id),
        api.replyEditor(summary.id).catch(() => ({ editor: null })),
      ])
      setThreadContexts((current) => ({ ...current, [summary.id]: context }))
      setReplyDrafts((current) => ({
        ...current,
        [summary.id]: current[summary.id] ?? saved.editor ?? initialEditor(context),
      }))
      setStatus('Antwortkontext geladen.')
    } catch (cause) {
      setError(errorMessage(cause))
      setReplyOpen(false)
    } finally {
      setReplyLoading(false)
    }
  }, [summary, threadContexts])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (submitting || busy) return
      if (event.key === 'Escape') {
        if (settingsOpen) return
        if (helpOpen) setHelpOpen(false)
        else if (replyOpen) setReplyOpen(false)
        else if (bucket) backToList()
        return
      }
      if (settingsOpen || helpOpen || replyOpen || replyLoading) return
      if (isTypingTarget(event.target)) return
      if (event.key === '?') {
        event.preventDefault()
        setHelpOpen(true)
        return
      }
      if (!bucket) return
      const key = event.key.toLowerCase()
      if (key === 'r') {
        event.preventDefault()
        void openReply()
      } else if (key === 'e' || event.key === 'ArrowRight') {
        event.preventDefault()
        void completeBucket()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        backToList()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        void parkSelected()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        void tagNewsletter()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    backToList,
    bucket,
    busy,
    completeBucket,
    helpOpen,
    openReply,
    parkSelected,
    replyLoading,
    replyOpen,
    settingsOpen,
    submitting,
    tagNewsletter,
  ])

  function updateEditor(patch: Partial<ReplyEditorState>) {
    if (!summary || !editor) return
    if ('bodyText' in patch) {
      replyBodyEditsRef.current.set(
        summary.id,
        (replyBodyEditsRef.current.get(summary.id) ?? 0) + 1,
      )
    }
    const next = patchReplyEditor(editor, patch)
    setReplyDrafts((current) => ({ ...current, [summary.id]: next }))
    scheduleEditorSave(summary.id, next)
  }

  async function generateReply() {
    const current = snapshotRef.current
    if (!current || !summary || !editor) return
    const bodyEditRevision = replyBodyEditsRef.current.get(summary.id) ?? 0
    setReplyLoading(true)
    setError(null)
    try {
      const nextProposal = await api.reply(
        summary.id,
        {
          currentDraft: editor.bodyText || undefined,
          requestId: crypto.randomUUID(),
          revisionInstruction: editor.revisionInstruction || undefined,
          roughNotes: editor.roughNotes,
        },
        current.csrfToken,
      )
      if ((replyBodyEditsRef.current.get(summary.id) ?? 0) !== bodyEditRevision) {
        setStatus('Vorschlag verworfen, weil der Antworttext zwischenzeitlich geändert wurde.')
        return
      }
      setReplyProposals((state) => ({ ...state, [summary.id]: nextProposal }))
      setReplyDrafts((state) => {
        const existing = state[summary.id]
        if (!existing) return state
        const next = applyReplyProposal(existing, editor, nextProposal.bodyText)
        scheduleEditorSave(summary.id, next)
        return { ...state, [summary.id]: next }
      })
      setStatus('Antwortentwurf erstellt. Bitte prüfen und bearbeiten.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setReplyLoading(false)
    }
  }

  async function saveDraft() {
    const current = snapshotRef.current
    if (!current || !summary || !editor) return
    let to: MailAddress[]
    let cc: MailAddress[]
    try {
      to = parseAddresses(editor.toText ?? addressesToText(editor.to))
      cc = parseAddresses(editor.ccText ?? addressesToText(editor.cc))
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    if (to.length === 0 || !editor.subject.trim() || !editor.bodyText.trim()) {
      setError('Empfänger, Betreff und Nachrichtentext werden für einen Draft benötigt.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const requestId = editor.draftRequestId ?? crypto.randomUUID()
      if (!editor.draftRequestId) {
        const next = { ...editor, draftRequestId: requestId }
        setReplyDrafts((state) => ({ ...state, [summary.id]: next }))
        scheduleEditorSave(summary.id, next)
      }
      const saved = await api.draft(
        summary.id,
        {
          bodyText: editor.bodyText,
          cc,
          identityId: editor.identityId,
          requestId,
          subject: editor.subject,
          to,
        },
        current.csrfToken,
      )
      setDraftResults((state) => ({ ...state, [summary.id]: saved }))
      setStatus('Draft in Fastmail gespeichert; die Nachricht bleibt ungelesen.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function startCodexLogin() {
    setCodexLoginBusy(true)
    setSettingsError(null)
    try {
      const { id } = await api.startCodexLogin()
      setCodexLogin({ id, status: 'starting', message: 'Anmeldung wird vorbereitet …' })
    } catch (cause) {
      setSettingsError(errorMessage(cause))
    } finally {
      setCodexLoginBusy(false)
    }
  }

  async function saveMemory(notes: string) {
    const current = snapshotRef.current
    if (!current) return
    setMemoryBusy(true)
    setSettingsError(null)
    try {
      const memory = await api.saveMemory(notes, current.csrfToken)
      setSnapshot((state) => (state ? { ...state, memory } : state))
    } catch (cause) {
      setSettingsError(errorMessage(cause))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function decideProposal(id: string, accept: boolean) {
    const current = snapshotRef.current
    if (!current) return
    setMemoryBusy(true)
    setSettingsError(null)
    try {
      const memory = await api.decideProposal(id, accept, current.csrfToken)
      setSnapshot((state) => (state ? { ...state, memory } : state))
    } catch (cause) {
      setSettingsError(errorMessage(cause))
    } finally {
      setMemoryBusy(false)
    }
  }

  const settingsDialog =
    settingsOpen && snapshot ? (
      <SettingsDialog
        authBusy={codexLoginBusy}
        codex={snapshot.codex}
        demo={snapshot.mode === 'demo'}
        error={settingsError}
        login={codexLogin}
        memory={snapshot.memory}
        memoryBusy={memoryBusy}
        onClose={() => setSettingsOpen(false)}
        onDecideProposal={(id, accept) => void decideProposal(id, accept)}
        onSaveMemory={(notes) => void saveMemory(notes)}
        onStartLogin={() => void startCodexLogin()}
      />
    ) : null

  if (loading) {
    return (
      <main className="state-page" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <h1>Inbox Walk</h1>
        <p>{status || 'Deine Todo-Liste wird geladen …'}</p>
      </main>
    )
  }

  if (!snapshot) {
    return (
      <main className="state-page">
        <h1>Postfach nicht erreichbar</h1>
        <p>{error}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Erneut versuchen
        </button>
      </main>
    )
  }

  if (!bucket || !summary) {
    return (
      <>
        <TodoPage
          buckets={buckets}
          error={error}
          onDismissError={() => setError(null)}
          onHelp={() => setHelpOpen(true)}
          onOpen={(id) => openBucket(id)}
          onRefresh={() => void refreshNow()}
          onRetry={(ids) => void runAction('retry', ids, 'Die Sortierung wird erneut versucht.')}
          onSettings={() => {
            setSettingsError(null)
            setSettingsOpen(true)
          }}
          onToggleParked={() => setShowParked((current) => !current)}
          onUnpark={(ids) => void runAction('unpark', ids, 'Nachricht ist zurück in der Liste.')}
          openCount={openCount}
          parked={parked}
          refreshing={refreshing}
          showParked={showParked}
          snapshot={snapshot}
          status={status}
        />
        {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
        {settingsDialog}
      </>
    )
  }

  const isStory = bucket.messages.length > 1
  const position = buckets.findIndex((item) => item.bucketId === bucket.bucketId)

  return (
    <div className={`app-shell ${replyOpen ? 'with-reply' : ''}`}>
      <header className="topbar">
        <button
          type="button"
          className="brand-button"
          onClick={backToList}
          aria-label={`Zurück zur Todo-Liste · Inbox Walk v${__APP_VERSION__}`}
        >
          <span className="brand-name">
            <span>Inbox Walk</span>
            <span className="app-version">v{__APP_VERSION__}</span>
          </span>
          <span className="story-position">
            <span className="counter">
              {isParkedView
                ? 'Geparkt'
                : `Bucket ${position + 1} / ${buckets.length} · ${openCount} offen`}
            </span>
            <span className="counter-compact">
              {isParkedView ? 'P' : `${position + 1}/${buckets.length}`}
            </span>
            <ChevronIcon />
          </span>
        </button>
        <div className="top-actions">
          {snapshot.mode === 'demo' && <span className="mode-label">Demo</span>}
          {bucket.unsorted ? (
            <span className="analysis-badge heuristic">Noch nicht einsortiert</span>
          ) : (
            <span className="analysis-badge codex">{kindLabel(bucket.kind)}</span>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setSettingsError(null)
              setSettingsOpen(true)
            }}
          >
            Einstellungen
          </button>
          <button type="button" className="text-button" onClick={backToList}>
            Liste
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setHelpOpen(true)}
            aria-label="Tastaturhilfe"
          >
            ?
          </button>
        </div>
      </header>

      <main className="reader">
        <article className="message-card" aria-labelledby="bundle-title">
          <header className="message-header">
            <h1 id="bundle-title">{bucket.title}</h1>
            {isStory ? (
              <p className="message-subject">{bucket.summary}</p>
            ) : (
              summary.subject &&
              summary.subject !== bucket.title && (
                <p className="message-subject">{summary.subject}</p>
              )
            )}
            {isStory ? (
              <div className="message-meta">
                <span className="tag">{bucket.messages.length} Nachrichten</span>
                {bucket.handledCount > 0 && (
                  <span className="tag">{bucket.handledCount} bereits erledigt</span>
                )}
                {Array.from(
                  new Set(bucket.messages.map((item) => messageSource(item.summary))),
                ).map((source) => (
                  <span className="tag" key={source}>
                    {source}
                  </span>
                ))}
                <span className="meta-hint">
                  Klick auf eine Kopfzeile wählt die Nachricht für ↑, ↓ und R
                </span>
              </div>
            ) : (
              <div className="message-meta">
                <span className="avatar" aria-hidden="true">
                  {initials(summary.from)}
                </span>
                <span className="sender" title={fullAddress(summary.from)}>
                  {addressLine(summary.from)}
                </span>
                {summary.from[0]?.name && summary.from[0]?.email && (
                  <span className="sender-email">{summary.from[0].email}</span>
                )}
                <time dateTime={summary.receivedAt}>{formatDate(summary.receivedAt)}</time>
                <span className="meta-tags">
                  {summary.mailboxNames.map((name) => (
                    <span className="tag" key={name}>
                      {name}
                    </span>
                  ))}
                  {summary.isNewsletter && <span className="tag newsletter">Newsletter</span>}
                  {summary.hasAttachment && <span className="tag">Anhang</span>}
                </span>
              </div>
            )}
            <div className="message-tools">
              {email?.html && (
                <fieldset className="segmented">
                  <legend className="sr-only">Farben der Nachricht</legend>
                  <button
                    type="button"
                    aria-pressed={mailColorMode === 'dark'}
                    onClick={() => setMailColorMode('dark')}
                    title="Farben an die dunkle Oberfläche anpassen"
                  >
                    Dunkel
                  </button>
                  <button
                    type="button"
                    aria-pressed={mailColorMode === 'original'}
                    onClick={() => setMailColorMode('original')}
                    title="Nachricht in ihren Originalfarben zeigen"
                  >
                    Original
                  </button>
                </fieldset>
              )}
              <details className="message-details" key={summary.id}>
                <summary>Details</summary>
                <dl className="message-details-content">
                  <div>
                    <dt>Bucket</dt>
                    <dd className="bundle-summary">{bucket.summary}</dd>
                  </div>
                  <div>
                    <dt>Stand</dt>
                    <dd>{bucket.currentState}</dd>
                  </div>
                  {bucket.linkEvidence.length > 0 && (
                    <div>
                      <dt>Belege</dt>
                      <dd>{bucket.linkEvidence.join(' · ')}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Betreff</dt>
                    <dd className="original-subject">{summary.subject || '(Kein Betreff)'}</dd>
                  </div>
                  <div>
                    <dt>Von</dt>
                    <dd>{fullAddress(summary.from) || 'Unbekannter Absender'}</dd>
                  </div>
                  <div>
                    <dt>An</dt>
                    <dd>{fullAddress(summary.to) || '–'}</dd>
                  </div>
                  <div>
                    <dt>Postfach</dt>
                    <dd>
                      {summary.mailboxNames.join(', ') || '–'}
                      {summary.isNewsletter && ' · Newsletter'}
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
            {email?.bodyTruncated && (
              <p className="warning-note">
                Fastmail hat nur einen gekürzten Nachrichteninhalt geliefert.
              </p>
            )}
          </header>

          {isStory ? (
            <ol
              className="story-grid"
              aria-label="Verlauf der Story"
              data-count={Math.min(bucket.messages.length, 6)}
            >
              {bucket.messages.map((item, index) => {
                const member = item.summary
                const body = details[member.id]
                const selected = summary.id === member.id
                const pending = pendingDetails.has(member.id)
                const source = messageSource(member)
                return (
                  <li
                    key={member.id}
                    className={`story-pane ${selected ? 'selected' : ''}`}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      className="pane-head"
                      aria-pressed={selected}
                      aria-label={`${source} · ${member.subject} · ${formatDate(member.receivedAt)}`}
                      title="Diese Nachricht auswählen"
                      onClick={() => {
                        setSelectedMemberId(member.id)
                        setReplyOpen(false)
                      }}
                    >
                      <span className="timeline-step">{index + 1}</span>
                      <span className="timeline-copy">
                        <span className="timeline-source">
                          {source}
                          <time dateTime={member.receivedAt}>
                            {formatShortDate(member.receivedAt)}
                          </time>
                        </span>
                        <strong>{member.subject || '(Kein Betreff)'}</strong>
                      </span>
                    </button>
                    <div className="pane-body" aria-busy={pending}>
                      {body ? (
                        <iframe
                          className="message-body"
                          title={`Inhalt von ${body.subject}`}
                          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                          srcDoc={emailDocument(body, true, snapshot.imageToken, mailColorMode)}
                        />
                      ) : pending ? (
                        <div className="body-loading">
                          <div className="spinner" />
                          <span>Nachricht wird geladen …</span>
                        </div>
                      ) : (
                        <div className="body-loading error-copy">
                          Der Nachrichteninhalt ist nicht verfügbar.
                        </div>
                      )}
                    </div>
                    {body && body.attachments.length > 0 && (
                      <div className="attachments pane-attachments">
                        <AttachmentChips email={body} mode={snapshot.mode} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          ) : (
            <>
              <div className="message-content" aria-busy={pendingDetails.has(summary.id)}>
                {pendingDetails.has(summary.id) && !email ? (
                  <div className="body-loading">
                    <div className="spinner" />
                    <span>Nachricht wird geladen …</span>
                  </div>
                ) : email ? (
                  <iframe
                    className="message-body"
                    title={`Inhalt von ${summary.subject}`}
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={emailDocument(email, true, snapshot.imageToken, mailColorMode)}
                  />
                ) : (
                  <div className="body-loading error-copy">
                    Der Nachrichteninhalt ist nicht verfügbar.
                  </div>
                )}
              </div>
              {email && email.attachments.length > 0 && (
                <section className="attachments" aria-label="Anhänge">
                  <h2>Anhänge</h2>
                  <AttachmentChips email={email} mode={snapshot.mode} />
                </section>
              )}
            </>
          )}
        </article>
      </main>

      <footer className="controls">
        <button type="button" className="control-button" onClick={backToList}>
          <kbd>←</kbd>
          <span>Liste</span>
        </button>
        <div className="decision-actions">
          <button
            type="button"
            className="control-button reply-trigger"
            aria-label="Antwort entwerfen"
            onClick={() => void openReply()}
          >
            <kbd>R</kbd>
            <span>Antwort entwerfen</span>
          </button>
          <button
            type="button"
            className="control-button unsubscribe-button"
            aria-label={
              summary.isNewsletter ? 'Für spätere Abmeldung markieren' : 'Kein Newsletter erkannt'
            }
            disabled={busy || !summary.isNewsletter}
            onClick={() => void tagNewsletter()}
            title={
              summary.isNewsletter
                ? 'Mit dem Fastmail-Label „Newsletter abmelden“ kennzeichnen'
                : 'Diese Nachricht wurde nicht als Newsletter erkannt'
            }
          >
            <kbd>↓</kbd>
            <span>Später abmelden</span>
          </button>
          <button
            type="button"
            className="control-button keep-button"
            aria-label={isParkedView ? 'Zurück in die Liste' : 'Nachricht parken'}
            disabled={busy}
            onClick={() => void parkSelected()}
            title={
              isParkedView
                ? 'Die Nachricht erscheint wieder in der Todo-Liste'
                : 'Bleibt ungelesen und verlässt die Todo-Liste, bis du sie zurückholst'
            }
          >
            <kbd>↑</kbd>
            <span>{isParkedView ? 'Zurückholen' : 'Parken'}</span>
          </button>
        </div>
        <div className="completion-actions">
          <button
            type="button"
            className="control-button next"
            onClick={() => void completeBucket()}
            disabled={busy || isParkedView}
            aria-label={`Bucket erledigt · ${bucket.messages.length} ${bucket.messages.length === 1 ? 'Nachricht' : 'Nachrichten'} als gelesen markieren`}
          >
            <span>{busy ? 'Wird gespeichert …' : 'Erledigt'}</span>
            <kbd>E</kbd>
          </button>
        </div>
      </footer>

      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Fehlermeldung schließen">
            ×
          </button>
        </div>
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {settingsDialog}
      {replyOpen && (
        <ReplyPanel
          context={thread}
          draftResult={draftResult}
          editor={editor}
          loading={replyLoading}
          proposal={proposal}
          submitting={submitting}
          onClose={() => setReplyOpen(false)}
          onGenerate={() => void generateReply()}
          onSave={() => void saveDraft()}
          onUpdate={updateEditor}
        />
      )}
    </div>
  )
}

function TodoPage({
  buckets,
  error,
  onDismissError,
  onHelp,
  onOpen,
  onRefresh,
  onRetry,
  onSettings,
  onToggleParked,
  onUnpark,
  openCount,
  parked,
  refreshing,
  showParked,
  snapshot,
  status,
}: {
  buckets: TriageBucket[]
  error: string | null
  onDismissError: () => void
  onHelp: () => void
  onOpen: (bucketId: string) => void
  onRefresh: () => void
  onRetry: (emailIds: string[]) => void
  onSettings: () => void
  onToggleParked: () => void
  onUnpark: (emailIds: string[]) => void
  openCount: number
  parked: TriageMessage[]
  refreshing: boolean
  showParked: boolean
  snapshot: TriageSnapshot
  status: string
}) {
  const failed = buckets.filter(
    (bucket) => bucket.unsorted && bucket.messages.some((message) => message.attempts >= 3),
  )
  const failedIds = failed.flatMap((bucket) => bucket.messages.map((message) => message.summary.id))
  return (
    <main className="todo-page">
      <header className="todo-header">
        <div className="setup-brand">
          <h1>Inbox Walk</h1>
          <span className="app-version">v{__APP_VERSION__}</span>
          {snapshot.mode === 'demo' && <span className="mode-label">Demo</span>}
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="text-button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Postfach jetzt prüfen"
          >
            <RefreshIcon />
            <span>{refreshing ? 'Prüft …' : 'Jetzt prüfen'}</span>
          </button>
          <button type="button" className="text-button" onClick={onSettings}>
            Einstellungen
          </button>
          <button type="button" className="icon-button" onClick={onHelp} aria-label="Tastaturhilfe">
            ?
          </button>
        </div>
      </header>
      <p className="todo-status" role="status">
        {statusLine(snapshot.status, snapshot.mode)}
        {snapshot.status.waitingForCodex && (
          <>
            {' '}
            <button type="button" className="text-button inline" onClick={onSettings}>
              Codex verbinden
            </button>
          </>
        )}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          <button type="button" className="text-button" onClick={onDismissError}>
            Ausblenden
          </button>
        </div>
      )}
      {failedIds.length > 0 && (
        <div className="inline-error" role="alert">
          <span>
            {failedIds.length} {failedIds.length === 1 ? 'Nachricht konnte' : 'Nachrichten konnten'}{' '}
            nach drei Versuchen nicht einsortiert werden. Sie bleiben oben in der Liste.
          </span>
          <button type="button" className="text-button" onClick={() => onRetry(failedIds)}>
            Erneut sortieren
          </button>
        </div>
      )}
      <section className="todo-section" aria-labelledby="todo-title">
        <div className="runs-heading">
          <h2 id="todo-title">Offen</h2>
          <p>
            {openCount === 0
              ? 'Keine ungelesenen Nachrichten.'
              : `${openCount} ${openCount === 1 ? 'Nachricht' : 'Nachrichten'} in ${buckets.length} ${buckets.length === 1 ? 'Bucket' : 'Buckets'}`}
          </p>
        </div>
        {buckets.length === 0 ? (
          <div className="todo-empty">
            <span className="completion-mark" aria-hidden="true">
              ✓
            </span>
            <h3>Alles erledigt</h3>
            <p>Neue Nachrichten erscheinen hier, sobald sie eintreffen und sortiert sind.</p>
          </div>
        ) : (
          <ol className="todo-list">
            {buckets.map((bucket) => {
              const latest = bucket.messages.at(-1)?.summary
              const sources = Array.from(
                new Set(bucket.messages.map((message) => messageSource(message.summary))),
              )
              const stuck = bucket.unsorted && bucket.messages.some((item) => item.attempts >= 3)
              return (
                <li key={bucket.bucketId} className={bucket.unsorted ? 'unsorted' : ''}>
                  <button
                    type="button"
                    className="todo-row"
                    onClick={() => onOpen(bucket.bucketId)}
                    aria-label={`${bucket.title} öffnen`}
                  >
                    <span className="todo-row-main">
                      <strong>{bucket.title}</strong>
                      <small>
                        {bucket.unsorted
                          ? stuck
                            ? 'Sortierung fehlgeschlagen'
                            : 'Wird einsortiert …'
                          : bucket.currentState}
                      </small>
                    </span>
                    <span className="todo-row-meta">
                      <span className="tag">
                        {bucket.unsorted ? 'Neu' : kindLabel(bucket.kind)}
                      </span>
                      <span className="tag">
                        {bucket.messages.length}{' '}
                        {bucket.messages.length === 1 ? 'Nachricht' : 'Nachrichten'}
                      </span>
                      <small className="todo-sources">{sources.slice(0, 3).join(', ')}</small>
                      {latest && (
                        <time dateTime={bucket.activityAt}>{relativeTime(bucket.activityAt)}</time>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </section>
      {parked.length > 0 && (
        <section className="todo-section parked-section" aria-labelledby="parked-title">
          <div className="runs-heading">
            <h2 id="parked-title">Geparkt</h2>
            <button type="button" className="text-button" onClick={onToggleParked}>
              {showParked ? 'Ausblenden' : `${parked.length} anzeigen`}
            </button>
          </div>
          {showParked && (
            <ol className="todo-list">
              {parked.map((message) => (
                <li key={message.summary.id}>
                  <button
                    type="button"
                    className="todo-row"
                    onClick={() => onOpen(`${PARKED_PREFIX}${message.summary.id}`)}
                    aria-label={`${message.summary.subject || '(Kein Betreff)'} öffnen`}
                  >
                    <span className="todo-row-main">
                      <strong>{message.summary.subject || '(Kein Betreff)'}</strong>
                      <small>{messageSource(message.summary)}</small>
                    </span>
                    <span className="todo-row-meta">
                      <time dateTime={message.summary.receivedAt}>
                        {relativeTime(message.summary.receivedAt)}
                      </time>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onUnpark([message.summary.id])}
                  >
                    Zurückholen
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
    </main>
  )
}

function AttachmentChips({ email, mode }: { email: ReviewEmail; mode: 'demo' | 'live' }) {
  return (
    <div className="attachment-list">
      {email.attachments.map((attachment) =>
        mode === 'live' ? (
          <a key={attachment.blobId} href={blobUrl(attachment.blobId)}>
            <AttachmentIcon />
            <span className="attachment-copy">
              <span>{attachment.name}</span>
              <small>{formatBytes(attachment.size)}</small>
            </span>
          </a>
        ) : (
          <button type="button" key={attachment.blobId} disabled>
            <AttachmentIcon />
            <span className="attachment-copy">
              <span>{attachment.name}</span>
              <small>{formatBytes(attachment.size)} · Demo</small>
            </span>
          </button>
        ),
      )}
    </div>
  )
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
      <path
        d="m4 6 4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function AttachmentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
      <path
        d="m13.5 6.5-6 6a1.8 1.8 0 0 0 2.5 2.5l6.5-6.5a3.5 3.5 0 0 0-5-5L5 10a5.2 5.2 0 0 0 7.4 7.4l4.6-4.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17">
      <path
        d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="dialog help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id="help-title">Tastatur</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <dl className="shortcut-list">
          <div>
            <dt>
              <kbd>←</kbd> <kbd>→</kbd>
            </dt>
            <dd>Zurück zur Liste / nächsten Bucket öffnen</dd>
          </div>
          <div>
            <dt>
              <kbd>↑</kbd>
            </dt>
            <dd>Ausgewählte Nachricht parken (bleibt ungelesen, verlässt die Liste)</dd>
          </div>
          <div>
            <dt>
              <kbd>↓</kbd>
            </dt>
            <dd>Newsletter für spätere Abmeldung markieren</dd>
          </div>
          <div>
            <dt>
              <kbd>E</kbd>
            </dt>
            <dd>Bucket erledigt: alle gezeigten Nachrichten als gelesen markieren</dd>
          </div>
          <div>
            <dt>
              <kbd>R</kbd>
            </dt>
            <dd>Antwort entwerfen</dd>
          </div>
          <div>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>Diese Hilfe</dd>
          </div>
          <div>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Panel schließen</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

const thinkingLevelLabels: Record<CodexThinkingLevel, string> = {
  off: 'Aus',
  minimal: 'Minimal',
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  xhigh: 'Sehr hoch',
  max: 'Maximum',
}

const speedLabels: Record<CodexSpeed, string> = {
  standard: 'Standard',
  fast: 'Schnell',
}

function settingsSourceLabel(codex: CodexSettings) {
  if (codex.settingsSource === 'codex') {
    return codex.settingsPath
      ? `Gelesen aus ${codex.settingsPath}.`
      : 'Gelesen aus der Codex-Konfiguration.'
  }
  return 'Codex hat kein Modell konfiguriert; die Startwerte der App gelten.'
}

function SettingsDialog({
  authBusy,
  codex,
  demo,
  error,
  login,
  memory,
  memoryBusy,
  onClose,
  onDecideProposal,
  onSaveMemory,
  onStartLogin,
}: {
  authBusy: boolean
  codex: CodexSettings
  demo: boolean
  error: string | null
  login: CodexLoginState | null
  memory: TriageMemory
  memoryBusy: boolean
  onClose: () => void
  onDecideProposal: (id: string, accept: boolean) => void
  onSaveMemory: (notes: string) => void
  onStartLogin: () => void
}) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  const [notes, setNotes] = useState(memory.notes)
  useEffect(() => setNotes(memory.notes), [memory.notes])
  const waiting = login?.status === 'starting' || login?.status === 'waiting'
  const codexLogin = codex.authSource === 'codex'
  const modelLabel = codex.modelLabel ?? codexModelLabel(codex.model) ?? codex.model
  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id="settings-title">Einstellungen</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <section className="settings-section" aria-labelledby="settings-codex-title">
          <div className="settings-section-heading">
            <div>
              <h3 id="settings-codex-title">Codex</h3>
              <p>
                Codex sortiert jede neue ungelesene Nachricht in einen Bucket ein und darf dafür im
                Postfach suchen und Nachrichten lesen. Modell, Denkaufwand und Geschwindigkeit
                folgen der Codex-Konfiguration und gelten für die Sortierung und für
                Antwortentwürfe.
              </p>
            </div>
            <span className={`connection-state ${codex.configured ? 'connected' : ''}`}>
              {codex.configured ? 'Verbunden' : 'Nicht verbunden'}
            </span>
          </div>
          <dl className="settings-values">
            <div>
              <dt>Modell</dt>
              <dd>
                {modelLabel}
                {modelLabel !== codex.model && <small>{codex.model}</small>}
              </dd>
            </div>
            <div>
              <dt>Denkaufwand</dt>
              <dd>{thinkingLevelLabels[codex.thinkingLevel ?? 'high']}</dd>
            </div>
            <div>
              <dt>Geschwindigkeit</dt>
              <dd>{speedLabels[codex.speed ?? 'standard']}</dd>
            </div>
          </dl>
          {!demo && (
            <p className="settings-source">
              {settingsSourceLabel(codex)} Ändere die Werte in Codex; die App übernimmt sie bei der
              nächsten Analyse.
            </p>
          )}
          {demo && (
            <p className="settings-demo-note">Im Demo-Modus sind diese Werte fest eingestellt.</p>
          )}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          {login && (
            <div className={`codex-login-state ${login.status}`} aria-live="polite">
              <strong>{login.message}</strong>
              {login.userCode && <code>{login.userCode}</code>}
              {login.url && (
                <a className="button primary" href={login.url} target="_blank" rel="noreferrer">
                  OpenAI-Anmeldung öffnen
                </a>
              )}
            </div>
          )}
          {!demo && codexLogin && (
            <p className="settings-source">
              Angemeldet über die Codex-Anmeldung. Bei Anmeldeproblemen <code>codex login</code>{' '}
              ausführen.
            </p>
          )}
          {!demo && !codexLogin && !waiting && (
            <button
              type="button"
              className="text-button settings-login"
              disabled={authBusy}
              onClick={onStartLogin}
            >
              {codex.configured ? 'Codex neu verbinden' : 'Mit ChatGPT verbinden'}
            </button>
          )}
        </section>
        <section className="settings-section" aria-labelledby="settings-memory-title">
          <div className="settings-section-heading">
            <div>
              <h3 id="settings-memory-title">Gedächtnis</h3>
              <p>
                Diese Notizen bekommt Codex bei jeder Sortierung als deine Vorlieben. Codex kann
                Ergänzungen vorschlagen; sie gelten erst, wenn du sie übernimmst.
              </p>
            </div>
          </div>
          <label className="memory-field">
            <span className="sr-only">Notizen für Codex</span>
            <textarea
              rows={6}
              maxLength={TRIAGE_MEMORY_MAX_LENGTH}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Zum Beispiel: Bahn-Buchungen und Sitzplatzreservierungen gehören zur selben Reise."
            />
          </label>
          <div className="memory-actions">
            <button
              type="button"
              className="button secondary"
              disabled={memoryBusy || notes === memory.notes}
              onClick={() => onSaveMemory(notes)}
            >
              {memoryBusy ? 'Wird gespeichert …' : 'Notizen speichern'}
            </button>
          </div>
          {memory.proposals.length > 0 && (
            <ul className="memory-proposals" aria-label="Vorschläge von Codex">
              {memory.proposals.map((proposal) => (
                <li key={proposal.id}>
                  <p>{proposal.note}</p>
                  <div className="memory-proposal-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={memoryBusy}
                      onClick={() => onDecideProposal(proposal.id, true)}
                    >
                      Übernehmen
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={memoryBusy}
                      onClick={() => onDecideProposal(proposal.id, false)}
                    >
                      Verwerfen
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={onClose}>
            Schließen
          </button>
        </div>
      </section>
    </div>
  )
}

function ReplyPanel({
  context,
  draftResult,
  editor,
  loading,
  proposal,
  submitting,
  onClose,
  onGenerate,
  onSave,
  onUpdate,
}: {
  context?: ThreadContext
  draftResult?: DraftResult
  editor?: ReplyEditorState
  loading: boolean
  proposal?: ReplyProposal
  submitting: boolean
  onClose: () => void
  onGenerate: () => void
  onSave: () => void
  onUpdate: (patch: Partial<ReplyEditorState>) => void
}) {
  const panelRef = useFocusRegion<HTMLElement>(false)
  const identity = context?.identities.find((item) => item.id === editor?.identityId)
  return (
    <aside ref={panelRef} className="reply-panel" aria-label="Antwortentwurf" tabIndex={-1}>
      <div className="reply-header">
        <div>
          <h2>Antwortentwurf</h2>
          <p>Wird nur als Fastmail-Draft gespeichert.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Antwort schließen"
        >
          ×
        </button>
      </div>
      {loading && !editor ? (
        <div className="panel-loading">
          <div className="spinner" />
          <span>Thread wird geladen …</span>
        </div>
      ) : editor && context ? (
        <div className="reply-form">
          <section className="context-note">
            <strong>Kontext für Codex</strong>
            <p>
              Alle {context.messages.length} Thread-Nachrichten und alle{' '}
              {context.attachmentManifest.length} Anhänge werden automatisch berücksichtigt. Wenn
              eine Datei nicht verarbeitet werden kann, wird kein Entwurf erzeugt.
            </p>
            {context.attachmentManifest.length > 0 && (
              <ul>
                {context.attachmentManifest.map((attachment) => (
                  <li key={attachment.blobId}>
                    {attachment.name} · {formatBytes(attachment.size)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <label>
            Von
            <select
              value={editor.identityId}
              onChange={(event) => onUpdate({ identityId: event.target.value })}
            >
              {context.identities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name ? `${item.name} <${item.email}>` : item.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            An
            <input
              type="text"
              value={editor.toText ?? addressesToText(editor.to)}
              onChange={(event) => onUpdate({ toText: event.target.value })}
            />
          </label>
          <label>
            Cc
            <input
              type="text"
              value={editor.ccText ?? addressesToText(editor.cc)}
              onChange={(event) => onUpdate({ ccText: event.target.value })}
            />
          </label>
          <label>
            Betreff
            <input
              type="text"
              value={editor.subject}
              onChange={(event) => onUpdate({ subject: event.target.value })}
            />
          </label>
          <label>
            Was soll die Antwort sagen?
            <textarea
              data-autofocus
              rows={4}
              value={editor.roughNotes}
              onChange={(event) => onUpdate({ roughNotes: event.target.value })}
              placeholder="Stichpunkte, Ton und wichtige Fakten …"
            />
          </label>
          <button
            type="button"
            className="button secondary full"
            onClick={onGenerate}
            disabled={loading}
          >
            {loading
              ? 'Entwurf wird erstellt …'
              : editor.bodyText
                ? 'Entwurf neu erstellen'
                : 'Entwurf erstellen'}
          </button>
          {editor.bodyText && (
            <>
              <label>
                Antwort
                <textarea
                  className="draft-body"
                  rows={12}
                  value={editor.bodyText}
                  onChange={(event) => onUpdate({ bodyText: event.target.value })}
                />
              </label>
              <label>
                Korrekturwunsch
                <textarea
                  rows={3}
                  value={editor.revisionInstruction}
                  onChange={(event) => onUpdate({ revisionInstruction: event.target.value })}
                  placeholder="Optional: kürzer, wärmer, ergänze …"
                />
              </label>
              <button
                type="button"
                className="text-button revise"
                onClick={onGenerate}
                disabled={loading || !editor.revisionInstruction.trim()}
              >
                Korrektur anwenden
              </button>
              {proposal && (proposal.warnings.length > 0 || proposal.questions.length > 0) && (
                <section className="proposal-notes">
                  {proposal.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  {proposal.questions.map((question) => (
                    <p key={question}>Offen: {question}</p>
                  ))}
                </section>
              )}
              {identity && (identity.textSignature || identity.htmlSignature) && (
                <section className="signature-preview">
                  <strong>Fastmail-Signatur</strong>
                  <pre>{identity.textSignature || 'Formatierte HTML-Signatur'}</pre>
                </section>
              )}
              <button
                type="button"
                className="button primary full"
                onClick={onSave}
                disabled={submitting}
              >
                {submitting ? 'Draft wird gespeichert …' : 'In Fastmail als Draft speichern'}
              </button>
              <p className="no-send-note">Inbox Walk kann keine Nachricht senden.</p>
            </>
          )}
          {draftResult && (
            <p className="draft-success" role="status">
              Draft gespeichert und verifiziert
              {draftResult.recovered ? ' (nach Wiederherstellung)' : ''}.
            </p>
          )}
        </div>
      ) : (
        <p className="panel-error">Antwortkontext ist nicht verfügbar.</p>
      )}
    </aside>
  )
}

export default App
