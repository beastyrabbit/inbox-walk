import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { api, blobUrl, ClientApiError } from './api.ts'
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint.ts'
import { emailDocument } from './email-document.ts'
import { clampIndex, idsToMarkRead, toggleKeptUnread } from './review-state.ts'
import {
  type CodexLoginState,
  type DraftResult,
  defaultReviewFilters,
  type FinalizeResult,
  type MailAddress,
  type ReplyEditorState,
  type ReplyProposal,
  type ReviewCheckpoint,
  type ReviewEmail,
  type ReviewFilters,
  type ReviewOptions,
  type ReviewSnapshot,
  type ThreadContext,
} from './shared.ts'

export { emailDocument } from './email-document.ts'

type View = 'review' | 'confirm' | 'done'

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

function addressesToText(addresses: MailAddress[]) {
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.email}>` : address.email))
    .join(', ')
}

function parseAddresses(value: string): MailAddress[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)\s*<([^<>]+)>$/)
      return match
        ? { name: match[1]?.trim() ?? '', email: match[2]?.trim() ?? '' }
        : { name: '', email: part }
    })
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
  const [options, setOptions] = useState<ReviewOptions | null>(null)
  const [filters, setFilters] = useState<ReviewFilters>(defaultReviewFilters)
  const [checkpoint, setCheckpoint] = useState<ReviewCheckpoint | null>(null)
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null)
  const [details, setDetails] = useState<Record<string, ReviewEmail>>({})
  const [index, setIndex] = useState(0)
  const [keptUnread, setKeptUnread] = useState<Set<string>>(new Set())
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set())
  const [secondaryActionIds, setSecondaryActionIds] = useState<Set<string>>(new Set())
  const [replyDrafts, setReplyDrafts] = useState<Record<string, ReplyEditorState>>({})
  const [threadContexts, setThreadContexts] = useState<Record<string, ThreadContext>>({})
  const [replyProposals, setReplyProposals] = useState<Record<string, ReplyProposal>>({})
  const [draftResults, setDraftResults] = useState<Record<string, DraftResult>>({})
  const [view, setView] = useState<View>('review')
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [codexLoginOpen, setCodexLoginOpen] = useState(false)
  const [codexLogin, setCodexLogin] = useState<CodexLoginState | null>(null)
  const [codexLoginBusy, setCodexLoginBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [replyLoading, setReplyLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FinalizeResult | null>(null)
  const restoredRef = useRef(false)

  const emails = snapshot?.emails ?? []
  const summary = emails[index]
  const email = summary ? details[summary.id] : undefined
  const editor = summary ? replyDrafts[summary.id] : undefined
  const thread = summary ? threadContexts[summary.id] : undefined
  const proposal = summary ? replyProposals[summary.id] : undefined
  const draftResult = summary ? draftResults[summary.id] : undefined
  const isKept = summary ? keptUnread.has(summary.id) : false
  const isSpamReview = snapshot?.filters.spam === 'only'
  const isSecondaryActionMarked = summary ? secondaryActionIds.has(summary.id) : false
  const codexLoginId = codexLogin?.id
  const codexLoginStatus = codexLogin?.status
  const finalizedEmailIds = useMemo(
    () => emails.map((item) => item.id).filter((id) => processedIds.has(id)),
    [emails, processedIds],
  )
  const finalizedKeptUnreadIds = useMemo(
    () => finalizedEmailIds.filter((id) => keptUnread.has(id)),
    [finalizedEmailIds, keptUnread],
  )
  const finalizedSecondaryActionIds = useMemo(
    () => finalizedEmailIds.filter((id) => secondaryActionIds.has(id)),
    [finalizedEmailIds, secondaryActionIds],
  )
  const readIds = useMemo(
    () => idsToMarkRead(finalizedEmailIds, new Set(finalizedKeptUnreadIds)),
    [finalizedEmailIds, finalizedKeptUnreadIds],
  )

  const startReview = useCallback(async (nextFilters: ReviewFilters, resume = loadCheckpoint()) => {
    setLoading(true)
    setError(null)
    setStatus('Postfach wird abgefragt …')
    try {
      const nextSnapshot =
        resume && resume.emailIds.length > 0
          ? await api.resumeReview(resume.emailIds, resume.filters)
          : await api.createReview(nextFilters)
      setSnapshot(nextSnapshot)
      setFilters(nextSnapshot.filters)
      setDetails({})
      setThreadContexts({})
      setReplyProposals({})
      setDraftResults({})
      setView('review')
      setOverviewOpen(false)
      setReplyOpen(false)
      if (resume) {
        setIndex(clampIndex(resume.index, nextSnapshot.emails.length))
        const available = new Set(nextSnapshot.emails.map((item) => item.id))
        setKeptUnread(new Set(resume.keptUnreadIds.filter((id) => available.has(id))))
        setProcessedIds(new Set(resume.processedIds.filter((id) => available.has(id))))
        setSecondaryActionIds(
          new Set(
            resume.secondaryActionIds.filter(
              (id) =>
                available.has(id) &&
                (nextSnapshot.filters.spam === 'only' ||
                  nextSnapshot.emails.some((item) => item.id === id && item.isNewsletter)),
            ),
          ),
        )
        setReplyDrafts(resume.replyDrafts)
        const missing = nextSnapshot.missingIds.length
        setStatus(
          missing > 0
            ? `Checkpoint fortgesetzt; ${missing} Nachricht${missing === 1 ? '' : 'en'} nicht mehr verfügbar.`
            : 'Checkpoint fortgesetzt.',
        )
      } else {
        setIndex(0)
        setKeptUnread(new Set())
        setProcessedIds(new Set())
        setSecondaryActionIds(new Set())
        setReplyDrafts({})
        setStatus(`${nextSnapshot.emails.length} ungelesene Nachrichten geladen.`)
      }
      setCheckpoint(resume)
      restoredRef.current = true
    } catch (cause) {
      setError(errorMessage(cause))
      setStatus('Postfach konnte nicht geladen werden.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const nextOptions = await api.options()
        if (!active) return
        setOptions(nextOptions)
        const savedCheckpoint = loadCheckpoint()
        setCheckpoint(savedCheckpoint)
        setFilters(savedCheckpoint?.filters ?? defaultReviewFilters)
        setLoading(false)
      } catch (cause) {
        if (active) setError(errorMessage(cause))
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

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
          if (active) setOptions((current) => (current ? { ...current, codex: auth } : current))
        }
        if (active) setCodexLogin(next)
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

  useEffect(() => {
    if (!snapshot || !restoredRef.current || emails.length === 0) return
    const saved = saveCheckpoint({
      version: 5,
      emailIds: emails.map((item) => item.id),
      filters: snapshot.filters,
      index,
      keptUnreadIds: [...keptUnread],
      processedIds: [...processedIds],
      secondaryActionIds: [...secondaryActionIds],
      replyDrafts,
    })
    if (!saved)
      setError(
        'Der lokale Checkpoint konnte nicht gespeichert werden. Dieses Fenster offen lassen.',
      )
  }, [emails, index, keptUnread, processedIds, replyDrafts, secondaryActionIds, snapshot])

  useEffect(() => {
    if (!snapshot || !summary || details[summary.id]) return
    let active = true
    setDetailLoading(true)
    setError(null)
    void api
      .email(snapshot.snapshotId, summary.id)
      .then((loaded) => {
        if (active) setDetails((current) => ({ ...current, [loaded.id]: loaded }))
      })
      .catch((cause) => {
        if (!active) return
        setKeptUnread((current) => new Set(current).add(summary.id))
        setError(`${errorMessage(cause)} Die Nachricht bleibt vorsichtshalber ungelesen.`)
        setStatus('Nachrichteninhalt nicht verfügbar; ungelesen geschützt.')
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [details, snapshot, summary])

  const previous = useCallback(() => {
    if (view !== 'review') {
      setView('review')
      return
    }
    setReplyOpen(false)
    setIndex((current) => Math.max(0, current - 1))
  }, [view])

  const next = useCallback(() => {
    if (view !== 'review' || !summary) return
    setReplyOpen(false)
    setProcessedIds((current) => new Set(current).add(summary.id))
    if (index >= emails.length - 1) setView('confirm')
    else setIndex((current) => current + 1)
  }, [emails.length, index, summary, view])

  const finishProcessed = useCallback(() => {
    if (view !== 'review' || processedIds.size === 0) return
    setReplyOpen(false)
    setResult(null)
    setView('confirm')
  }, [processedIds.size, view])

  const toggleCurrent = useCallback(() => {
    if (!summary || view !== 'review') return
    setKeptUnread((current) => toggleKeptUnread(current, summary.id))
    setStatus(isKept ? 'Wird beim Abschluss als gelesen markiert.' : 'Bleibt ungelesen.')
  }, [isKept, summary, view])

  const toggleSecondaryAction = useCallback(() => {
    if (!summary || view !== 'review' || (!isSpamReview && !summary.isNewsletter)) return
    setSecondaryActionIds((current) => toggleKeptUnread(current, summary.id))
    setStatus(
      isSecondaryActionMarked
        ? isSpamReview
          ? 'Nachricht bleibt im Spam-Ordner.'
          : 'Abmelde-Label nicht mehr vorgemerkt.'
        : isSpamReview
          ? 'Wird beim Abschluss aus Spam in die Inbox verschoben.'
          : 'Wird beim Abschluss mit „Newsletter abmelden“ markiert.',
    )
  }, [isSecondaryActionMarked, isSpamReview, summary, view])

  const openReply = useCallback(async () => {
    if (!snapshot || !summary) return
    setReplyOpen(true)
    setHelpOpen(false)
    if (threadContexts[summary.id]) return
    setReplyLoading(true)
    setError(null)
    try {
      const context = await api.thread(snapshot.snapshotId, summary.threadId, summary.id)
      setThreadContexts((current) => ({ ...current, [summary.id]: context }))
      setReplyDrafts((current) => ({
        ...current,
        [summary.id]: current[summary.id] ?? initialEditor(context),
      }))
      setStatus('Antwortkontext geladen.')
    } catch (cause) {
      setError(errorMessage(cause))
      setReplyOpen(false)
    } finally {
      setReplyLoading(false)
    }
  }, [snapshot, summary, threadContexts])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape') {
        if (helpOpen) setHelpOpen(false)
        else if (replyOpen) setReplyOpen(false)
        else if (overviewOpen) setOverviewOpen(false)
        else if (view === 'confirm') setView('review')
        return
      }
      if (submitting || replyLoading) return
      if (isTypingTarget(event.target)) return
      if (event.key === '?') {
        event.preventDefault()
        setHelpOpen(true)
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault()
        void openReply()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        toggleCurrent()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        toggleSecondaryAction()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    helpOpen,
    next,
    openReply,
    overviewOpen,
    previous,
    replyLoading,
    replyOpen,
    submitting,
    toggleCurrent,
    toggleSecondaryAction,
    view,
  ])

  function updateEditor(patch: Partial<ReplyEditorState>) {
    if (!summary || !editor) return
    const changesSavedDraft = ['bodyText', 'cc', 'identityId', 'subject', 'to'].some(
      (key) => key in patch,
    )
    setReplyDrafts((current) => ({
      ...current,
      [summary.id]: {
        ...editor,
        ...patch,
        ...(changesSavedDraft ? { draftRequestId: undefined } : {}),
      },
    }))
  }

  async function generateReply() {
    if (!snapshot || !summary || !editor) return
    setReplyLoading(true)
    setError(null)
    try {
      const nextProposal = await api.reply(snapshot, {
        currentDraft: editor.bodyText || undefined,
        emailId: summary.id,
        requestId: crypto.randomUUID(),
        revisionInstruction: editor.revisionInstruction || undefined,
        roughNotes: editor.roughNotes,
      })
      setReplyProposals((current) => ({ ...current, [summary.id]: nextProposal }))
      updateEditor({ bodyText: nextProposal.bodyText, revisionInstruction: '' })
      setStatus('Antwortentwurf erstellt. Bitte prüfen und bearbeiten.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setReplyLoading(false)
    }
  }

  async function saveDraft() {
    if (!snapshot || !summary || !editor) return
    if (editor.to.length === 0 || !editor.subject.trim() || !editor.bodyText.trim()) {
      setError('Empfänger, Betreff und Nachrichtentext werden für einen Draft benötigt.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const draftPayload = {
        bodyText: editor.bodyText,
        cc: editor.cc,
        emailId: summary.id,
        identityId: editor.identityId,
        subject: editor.subject,
        to: editor.to,
      }
      const requestId = editor.draftRequestId ?? crypto.randomUUID()
      if (!editor.draftRequestId) {
        setReplyDrafts((current) => ({
          ...current,
          [summary.id]: {
            ...current[summary.id],
            draftRequestId: requestId,
          } as ReplyEditorState,
        }))
      }
      const saved = await api.draft(snapshot, {
        ...draftPayload,
        requestId,
      })
      setDraftResults((current) => ({ ...current, [summary.id]: saved }))
      setKeptUnread((current) => new Set(current).add(summary.id))
      setStatus('Draft in Fastmail gespeichert; die Nachricht bleibt ungelesen.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function finalizeReview() {
    if (!snapshot) return
    setSubmitting(true)
    setError(null)
    try {
      const nextResult = await api.finalize(
        snapshot,
        finalizedEmailIds,
        finalizedKeptUnreadIds,
        finalizedSecondaryActionIds,
      )
      setResult(nextResult)
      if (nextResult.finalized) {
        clearCheckpoint()
        restoredRef.current = false
        setView('done')
        setStatus('Review abgeschlossen.')
      } else {
        setError(
          `${nextResult.remaining} Änderungen sind fehlgeschlagen. Du kannst sie erneut versuchen.`,
        )
        setStatus('Review teilweise gespeichert.')
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function startNewReview() {
    clearCheckpoint()
    setCheckpoint(null)
    restoredRef.current = false
    await startReview(filters, null)
  }

  async function showSetup(discardCheckpoint = false) {
    if (discardCheckpoint) clearCheckpoint()
    restoredRef.current = false
    setCheckpoint(discardCheckpoint ? null : loadCheckpoint())
    setSnapshot(null)
    setResult(null)
    setView('review')
    setOverviewOpen(false)
    setReplyOpen(false)
    setError(null)
    try {
      setOptions(await api.options())
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function startCodexLogin() {
    setCodexLoginBusy(true)
    setError(null)
    try {
      const { id } = await api.startCodexLogin()
      setCodexLogin({ id, status: 'starting', message: 'Anmeldung wird vorbereitet …' })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCodexLoginBusy(false)
    }
  }

  if (loading) {
    return (
      <main className="state-page" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <h1>Inbox Walk</h1>
        <p>{status || 'Ungelesene Nachrichten werden geladen …'}</p>
      </main>
    )
  }

  if (error && !options) {
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

  if (!snapshot) {
    return (
      <ReviewSetup
        checkpoint={checkpoint}
        error={error}
        filters={filters}
        options={options}
        onChange={setFilters}
        onResume={() => checkpoint && void startReview(checkpoint.filters, checkpoint)}
        onStart={() => void startNewReview()}
      />
    )
  }

  if (emails.length === 0) {
    return (
      <main className="state-page">
        <h1>Keine ungelesenen Nachrichten</h1>
        <p>Für diese Auswahl ist dein Postfach bereits aufgeräumt.</p>
        <button type="button" className="button secondary" onClick={() => void showSetup()}>
          Auswahl ändern
        </button>
      </main>
    )
  }

  if (view === 'done' && result) {
    return (
      <main className="state-page completion">
        <span className="completion-mark" aria-hidden="true">
          ✓
        </span>
        <h1>Review abgeschlossen</h1>
        <p>
          {result.markedRead} Nachrichten wurden als gelesen markiert. {result.keptUnread}{' '}
          bearbeitete bleiben ungelesen. {result.untouched} noch nicht bearbeitete Nachrichten
          warten auf die nächste Runde.
          {result.taggedForUnsubscribe > 0 &&
            ` ${result.taggedForUnsubscribe} Newsletter wurden mit „Newsletter abmelden“ markiert.`}
          {result.rescuedFromSpam > 0 &&
            ` ${result.rescuedFromSpam} Nachrichten wurden aus Spam in die Inbox verschoben.`}
        </p>
        {result.actionFailed.length > 0 && (
          <div className="inline-error" role="alert">
            <strong>{result.actionFailed.length} Zusatzaktionen sind fehlgeschlagen.</strong>
            <ul>
              {result.actionFailed.map((failure) => (
                <li key={failure.id}>{failure.reason}</li>
              ))}
            </ul>
          </div>
        )}
        <button type="button" className="button primary" onClick={() => void showSetup()}>
          Neue Runde auswählen
        </button>
      </main>
    )
  }

  if (view === 'confirm') {
    return (
      <main className="state-page confirm-page">
        <h1>Review abschließen?</h1>
        <p>
          Nur die bereits mit Weiter bestätigten Nachrichten werden jetzt verarbeitet. Alle anderen
          bleiben ungelesen.
        </p>
        <dl className="review-summary">
          <div>
            <dt>Bereits bearbeitet</dt>
            <dd>{finalizedEmailIds.length}</dd>
          </div>
          <div>
            <dt>Als gelesen markieren</dt>
            <dd>{readIds.length}</dd>
          </div>
          <div>
            <dt>Ungelesen behalten</dt>
            <dd>{finalizedKeptUnreadIds.length}</dd>
          </div>
          <div>
            <dt>{isSpamReview ? 'Aus Spam in die Inbox' : 'Für spätere Abmeldung markieren'}</dt>
            <dd>{finalizedSecondaryActionIds.length}</dd>
          </div>
          <div>
            <dt>Noch nicht bearbeitet</dt>
            <dd>{emails.length - finalizedEmailIds.length} bleiben ungelesen</dd>
          </div>
          <div>
            <dt>Neue Nachrichten seit dem Start</dt>
            <dd>bleiben ebenfalls unberührt</dd>
          </div>
        </dl>
        {result && result.failed.length > 0 && (
          <div className="inline-error" role="alert">
            <strong>{result.failed.length} Änderungen fehlgeschlagen.</strong>
            <ul>
              {result.failed.map((failure) => (
                <li key={failure.id}>{failure.reason}</li>
              ))}
            </ul>
          </div>
        )}
        {result && result.actionFailed.length > 0 && (
          <div className="inline-error" role="alert">
            <strong>{result.actionFailed.length} Zusatzaktionen fehlgeschlagen.</strong>
            <ul>
              {result.actionFailed.map((failure) => (
                <li key={failure.id}>{failure.reason}</li>
              ))}
            </ul>
          </div>
        )}
        {snapshot.mode === 'demo' && (
          <p className="mode-note">Demo-Modus: Fastmail wird nicht verändert.</p>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            onClick={() => setView('review')}
            disabled={submitting}
          >
            Zurück
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void finalizeReview()}
            disabled={submitting}
          >
            {submitting
              ? 'Wird gespeichert …'
              : result?.remaining
                ? 'Fehlgeschlagene erneut versuchen'
                : 'Änderungen speichern'}
          </button>
        </div>
      </main>
    )
  }

  if (!summary) return null

  const progress = ((index + 1) / emails.length) * 100

  return (
    <div className={`app-shell ${replyOpen ? 'with-reply' : ''}`}>
      <header className="topbar">
        <button
          type="button"
          className="brand-button"
          onClick={() => setOverviewOpen(true)}
          aria-label="Nachrichtenübersicht öffnen"
        >
          <span>Inbox Walk</span>
          <span className="counter">
            {index + 1} / {emails.length}
          </span>
        </button>
        <div className="top-actions">
          {snapshot.mode === 'demo' && <span className="mode-label">Demo</span>}
          {snapshot.mode === 'live' && (
            <button
              type="button"
              className={`codex-status ${options?.codex.configured ? 'connected' : ''}`}
              onClick={() => setCodexLoginOpen(true)}
            >
              <span aria-hidden="true" />
              {options?.codex.configured ? 'Codex verbunden' : 'Codex anmelden'}
            </button>
          )}
          <button type="button" className="text-button" onClick={() => void showSetup()}>
            Neue Auswahl
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
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      </header>

      {snapshot.truncated && (
        <p className="snapshot-warning" role="status">
          Diese feste Runde ist auf {emails.length} Nachrichten begrenzt. Weitere passende
          ungelesene Nachrichten bleiben für die nächste Runde unberührt.
        </p>
      )}

      <main className="reader">
        <article className="message-card">
          <header className="message-header">
            <div className="message-heading">
              <div>
                <p className="sender" title={fullAddress(summary.from)}>
                  {addressLine(summary.from)}
                </p>
                <h1>{summary.subject || '(Kein Betreff)'}</h1>
              </div>
              <time dateTime={summary.receivedAt}>{formatDate(summary.receivedAt)}</time>
            </div>
            <div className="message-meta">
              <span title={fullAddress(summary.to)}>An {addressLine(summary.to)}</span>
              {summary.mailboxNames.map((mailbox) => (
                <span className="mailbox" key={mailbox}>
                  {mailbox}
                </span>
              ))}
              {summary.isNewsletter && <span className="mailbox">Newsletter</span>}
            </div>
            {email?.bodyTruncated && (
              <p className="warning-note">
                Fastmail hat nur einen gekürzten Nachrichteninhalt geliefert.
              </p>
            )}
          </header>

          <div className="message-content" aria-busy={detailLoading}>
            {detailLoading && !email ? (
              <div className="body-loading">
                <div className="spinner" />
                <span>Nachricht wird geladen …</span>
              </div>
            ) : email ? (
              <iframe
                className="message-body"
                title={`Inhalt von ${summary.subject}`}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                srcDoc={emailDocument(email, snapshot.snapshotId, true, snapshot.imageToken)}
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
              <div className="attachment-list">
                {email.attachments.map((attachment) =>
                  snapshot.mode === 'live' ? (
                    <a
                      key={attachment.blobId}
                      href={blobUrl(snapshot.snapshotId, attachment.blobId)}
                    >
                      <span>{attachment.name}</span>
                      <small>{formatBytes(attachment.size)}</small>
                    </a>
                  ) : (
                    <button type="button" key={attachment.blobId} disabled>
                      <span>{attachment.name}</span>
                      <small>{formatBytes(attachment.size)} · Demo</small>
                    </button>
                  ),
                )}
              </div>
            </section>
          )}
        </article>
      </main>

      <footer className="controls">
        <button type="button" className="control-button" onClick={previous} disabled={index === 0}>
          <kbd>←</kbd>
          <span>Zurück</span>
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
            className={`control-button unsubscribe-button ${isSecondaryActionMarked ? 'active' : ''}`}
            aria-label={
              isSpamReview
                ? isSecondaryActionMarked
                  ? 'Als kein Spam vorgemerkt'
                  : 'Kein Spam'
                : summary.isNewsletter
                  ? isSecondaryActionMarked
                    ? 'Abmelde-Label vorgemerkt'
                    : 'Für spätere Abmeldung markieren'
                  : 'Kein Newsletter erkannt'
            }
            aria-pressed={isSecondaryActionMarked}
            disabled={!isSpamReview && !summary.isNewsletter}
            onClick={toggleSecondaryAction}
            title={
              isSpamReview
                ? 'Beim Abschluss aus Spam entfernen und in die Inbox verschieben'
                : summary.isNewsletter
                  ? 'Beim Abschluss mit dem Fastmail-Label „Newsletter abmelden“ kennzeichnen'
                  : 'Diese Nachricht wurde nicht als Newsletter erkannt'
            }
          >
            <kbd>↓</kbd>
            <span>
              {isSpamReview
                ? isSecondaryActionMarked
                  ? 'Kein Spam vorgemerkt'
                  : 'Kein Spam'
                : isSecondaryActionMarked
                  ? 'Abmeldung markiert'
                  : 'Später abmelden'}
            </span>
          </button>
          <button
            type="button"
            className={`control-button keep-button ${isKept ? 'active' : ''}`}
            aria-label={isKept ? 'Bleibt ungelesen' : 'Ungelesen behalten'}
            aria-pressed={isKept}
            onClick={toggleCurrent}
          >
            <kbd>↑</kbd>
            <span>{isKept ? 'Bleibt ungelesen' : 'Ungelesen behalten'}</span>
          </button>
        </div>
        <div className="completion-actions">
          <button
            type="button"
            className="control-button partial-finish"
            onClick={finishProcessed}
            disabled={processedIds.size === 0}
            aria-label={`${processedIds.size} bereits bearbeitete Nachrichten abschließen`}
            title="Nur bereits mit Weiter bestätigte Nachrichten abschließen"
          >
            <span className="partial-finish-wide">Bisher abschließen · {processedIds.size}</span>
            <span className="partial-finish-compact">{processedIds.size} fertig</span>
          </button>
          <button type="button" className="control-button next" onClick={next}>
            <span>{index === emails.length - 1 ? 'Abschließen' : 'Weiter'}</span>
            <kbd>→</kbd>
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

      {overviewOpen && (
        <OverviewDrawer
          emails={emails}
          currentIndex={index}
          keptUnread={keptUnread}
          processedIds={processedIds}
          secondaryActionIds={secondaryActionIds}
          isSpamReview={isSpamReview}
          onClose={() => setOverviewOpen(false)}
          onSelect={(nextIndex) => {
            setIndex(nextIndex)
            setReplyOpen(false)
            setOverviewOpen(false)
          }}
          onDiscard={() => void showSetup(true)}
        />
      )}
      {helpOpen && <HelpDialog isSpamReview={isSpamReview} onClose={() => setHelpOpen(false)} />}
      {codexLoginOpen && options && (
        <CodexLoginDialog
          authConfigured={options.codex.configured}
          busy={codexLoginBusy}
          login={codexLogin}
          model={options.codex.model}
          onClose={() => setCodexLoginOpen(false)}
          onStart={() => void startCodexLogin()}
        />
      )}
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

function ReviewSetup({
  checkpoint,
  error,
  filters,
  options,
  onChange,
  onResume,
  onStart,
}: {
  checkpoint: ReviewCheckpoint | null
  error: string | null
  filters: ReviewFilters
  options: ReviewOptions | null
  onChange: (filters: ReviewFilters) => void
  onResume: () => void
  onStart: () => void
}) {
  const [mailboxQuery, setMailboxQuery] = useState('')
  const timeRanges: Array<{ label: string; value: ReviewFilters['timeRange'] }> = [
    { label: 'Alle', value: 'all' },
    { label: '24 Stunden', value: '24h' },
    { label: '7 Tage', value: '7d' },
    { label: '30 Tage', value: '30d' },
  ]
  const newsletterFilters: Array<{ label: string; value: ReviewFilters['newsletter'] }> = [
    { label: 'Alle', value: 'all' },
    { label: 'Ohne Newsletter', value: 'exclude' },
    { label: 'Nur Newsletter', value: 'only' },
  ]
  const mailboxes =
    options?.mailboxes.filter(
      (mailbox) => !mailbox.role || !['drafts', 'junk', 'sent', 'trash'].includes(mailbox.role),
    ) ?? []
  const selectedMailbox = mailboxes.find((mailbox) => mailbox.id === filters.mailboxId)
  const visibleMailboxes = mailboxes.filter((mailbox) =>
    mailbox.name
      .toLocaleLowerCase('de-DE')
      .includes(mailboxQuery.trim().toLocaleLowerCase('de-DE')),
  )
  return (
    <main className="setup-page">
      <header className="setup-header">
        <h1>Inbox Walk</h1>
        <p>Stell die Runde zusammen, bevor eine einzige Nachricht geladen wird.</p>
      </header>

      {checkpoint && checkpoint.emailIds.length > 0 && (
        <section className="resume-review" aria-labelledby="resume-title">
          <div>
            <h2 id="resume-title">Offene Runde</h2>
            <p>
              {checkpoint.emailIds.length} Nachrichten · {checkpoint.processedIds.length} bearbeitet
            </p>
          </div>
          <button type="button" className="button secondary" onClick={onResume}>
            Runde fortsetzen
          </button>
        </section>
      )}

      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault()
          onStart()
        }}
      >
        <section className="setup-section" aria-labelledby="scope-title">
          <div className="setup-section-heading">
            <h2 id="scope-title">Bereich</h2>
            <p>Was soll in dieser Runde auftauchen?</p>
          </div>
          <div className="scope-choices">
            <button
              type="button"
              className="setup-choice"
              aria-pressed={filters.spam === 'exclude'}
              onClick={() => onChange({ ...filters, spam: 'exclude' })}
            >
              <span className="choice-box" aria-hidden="true">
                {filters.spam === 'exclude' ? '✓' : ''}
              </span>
              <span>
                <strong>Alles außer Spam</strong>
                <small>Die normale ungelesene Post</small>
              </span>
            </button>
            <button
              type="button"
              className="setup-choice"
              aria-pressed={filters.spam === 'only'}
              onClick={() => onChange({ ...filters, mailboxId: null, spam: 'only' })}
            >
              <span className="choice-box" aria-hidden="true">
                {filters.spam === 'only' ? '✓' : ''}
              </span>
              <span>
                <strong>Nur Spam</strong>
                <small>Mit ↓ falsch erkannte Mails zurückholen</small>
              </span>
            </button>
          </div>
        </section>

        <section className="setup-section" aria-labelledby="time-title">
          <div className="setup-section-heading">
            <h2 id="time-title">Zeitraum</h2>
            <p>Direkt wählen, ohne Menü.</p>
          </div>
          <div className="direct-choices">
            {timeRanges.map((range) => (
              <button
                type="button"
                key={range.value}
                aria-pressed={filters.timeRange === range.value}
                onClick={() => onChange({ ...filters, timeRange: range.value })}
              >
                {range.label}
              </button>
            ))}
          </div>
        </section>

        <section className="setup-section" aria-labelledby="narrow-title">
          <div className="setup-section-heading">
            <h2 id="narrow-title">Eingrenzen</h2>
            <p>Optional – nichts davon muss gewählt werden.</p>
          </div>
          <label className="setup-check history-check">
            <input
              type="checkbox"
              checked={filters.hideReviewed}
              onChange={(event) => onChange({ ...filters, hideReviewed: event.target.checked })}
            />
            <span className="choice-box" aria-hidden="true">
              {filters.hideReviewed ? '✓' : ''}
            </span>
            <span>
              <strong>Bereits angesehene ausblenden</strong>
              <small>
                {options?.reviewedCount ?? 0} Nachrichten sind bisher in der lokalen SQLite-Historie
              </small>
            </span>
          </label>

          <div className="setup-subsection">
            <h3>Newsletter</h3>
            <div className="direct-choices">
              {newsletterFilters.map((filter) => (
                <button
                  type="button"
                  key={filter.value}
                  aria-pressed={filters.newsletter === filter.value}
                  onClick={() => onChange({ ...filters, newsletter: filter.value })}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {filters.spam === 'exclude' && mailboxes.length > 0 && (
            <details className="mailbox-picker" open={selectedMailbox ? true : undefined}>
              <summary>
                <span>Postfach einschränken</span>
                <small>{selectedMailbox?.name ?? 'Alle Postfächer'}</small>
              </summary>
              <div className="mailbox-picker-body">
                <input
                  type="search"
                  value={mailboxQuery}
                  onChange={(event) => setMailboxQuery(event.target.value)}
                  placeholder="Postfach suchen …"
                  aria-label="Postfach suchen"
                />
                <div className="mailbox-choices">
                  {selectedMailbox && (
                    <button
                      type="button"
                      className="clear-mailbox"
                      onClick={() => onChange({ ...filters, mailboxId: null })}
                    >
                      Auswahl aufheben
                    </button>
                  )}
                  {visibleMailboxes.map((mailbox) => {
                    const checked = filters.mailboxId === mailbox.id
                    return (
                      <label className="setup-check compact" key={mailbox.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            onChange({ ...filters, mailboxId: checked ? null : mailbox.id })
                          }
                        />
                        <span className="choice-box" aria-hidden="true">
                          {checked ? '✓' : ''}
                        </span>
                        <span>{mailbox.name}</span>
                      </label>
                    )
                  })}
                  {visibleMailboxes.length === 0 && (
                    <p className="empty-mailboxes">Kein passendes Postfach.</p>
                  )}
                </div>
              </div>
            </details>
          )}
        </section>

        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}
        <footer className="setup-footer">
          <p>Die Auswahl wird als feste Runde geladen. Änderungen passieren erst beim Abschluss.</p>
          <button type="submit" className="button primary">
            Review starten
          </button>
        </footer>
      </form>
    </main>
  )
}

function OverviewDrawer({
  emails,
  currentIndex,
  keptUnread,
  processedIds,
  secondaryActionIds,
  isSpamReview,
  onClose,
  onDiscard,
  onSelect,
}: {
  emails: ReviewSnapshot['emails']
  currentIndex: number
  keptUnread: ReadonlySet<string>
  processedIds: ReadonlySet<string>
  secondaryActionIds: ReadonlySet<string>
  isSpamReview: boolean | undefined
  onClose: () => void
  onDiscard: () => void
  onSelect: (index: number) => void
}) {
  const drawerRef = useFocusRegion<HTMLElement>(true)
  return (
    <div className="drawer-backdrop">
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Nachrichtenübersicht"
        tabIndex={-1}
      >
        <div className="drawer-header">
          <div>
            <h2>Nachrichten</h2>
            <p>
              {processedIds.size} bearbeitet · {keptUnread.size} bleiben ungelesen ·{' '}
              {secondaryActionIds.size} {isSpamReview ? 'kein Spam' : 'für Abmeldung markiert'}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <ol className="overview-list">
          {emails.map((item, itemIndex) => (
            <li key={item.id}>
              <button
                type="button"
                className={itemIndex === currentIndex ? 'current' : ''}
                onClick={() => onSelect(itemIndex)}
              >
                <span className="overview-index">{String(itemIndex + 1).padStart(2, '0')}</span>
                <span className="overview-copy">
                  <strong>{item.subject || '(Kein Betreff)'}</strong>
                  <small>{addressLine(item.from)}</small>
                </span>
                <span className="overview-marks">
                  {processedIds.has(item.id) && <span className="processed-mark">bearbeitet</span>}
                  {keptUnread.has(item.id) && <span className="unread-mark">ungelesen</span>}
                  {secondaryActionIds.has(item.id) && (
                    <span className="unsubscribe-mark">
                      {isSpamReview ? 'kein Spam' : 'abmelden'}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="drawer-footer">
          <button type="button" className="danger-link" onClick={onDiscard}>
            Runde verwerfen und neue Auswahl treffen
          </button>
        </div>
      </aside>
    </div>
  )
}

function HelpDialog({
  isSpamReview,
  onClose,
}: {
  isSpamReview: boolean | undefined
  onClose: () => void
}) {
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
            <dd>Nachricht wechseln</dd>
          </div>
          <div>
            <dt>
              <kbd>↑</kbd>
            </dt>
            <dd>Ungelesen schützen</dd>
          </div>
          <div>
            <dt>
              <kbd>↓</kbd>
            </dt>
            <dd>
              {isSpamReview
                ? 'Als kein Spam markieren und in die Inbox verschieben'
                : 'Newsletter für spätere Abmeldung markieren'}
            </dd>
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

function CodexLoginDialog({
  authConfigured,
  busy,
  login,
  model,
  onClose,
  onStart,
}: {
  authConfigured: boolean
  busy: boolean
  login: CodexLoginState | null
  model: string
  onClose: () => void
  onStart: () => void
}) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  const waiting = login?.status === 'starting' || login?.status === 'waiting'
  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="dialog codex-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-title"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <div>
            <h2 id="codex-title">Codex verbinden</h2>
            <p className="dialog-kicker">ChatGPT-Abo · {model}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <p className="dialog-note">
          OpenAI erneuert diese OAuth-Anmeldung automatisch. Sie bleibt auf dem privaten
          App-Speicher; ein OpenAI-API-Schlüssel ist nicht nötig.
        </p>
        {login ? (
          <div className={`codex-login-state ${login.status}`} aria-live="polite">
            <strong>{login.message}</strong>
            {login.userCode && <code>{login.userCode}</code>}
            {login.url && (
              <a className="button primary" href={login.url} target="_blank" rel="noreferrer">
                OpenAI-Anmeldung öffnen
              </a>
            )}
          </div>
        ) : (
          <p className={`codex-current ${authConfigured ? 'connected' : ''}`}>
            {authConfigured ? 'Codex ist verbunden.' : 'Codex ist noch nicht verbunden.'}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="button secondary" onClick={onClose}>
            Schließen
          </button>
          {!waiting && login?.status !== 'completed' && (
            <button type="button" className="button primary" disabled={busy} onClick={onStart}>
              {authConfigured ? 'Neu anmelden' : 'Mit ChatGPT anmelden'}
            </button>
          )}
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
              value={addressesToText(editor.to)}
              onChange={(event) => onUpdate({ to: parseAddresses(event.target.value) })}
            />
          </label>
          <label>
            Cc
            <input
              type="text"
              value={addressesToText(editor.cc)}
              onChange={(event) => onUpdate({ cc: parseAddresses(event.target.value) })}
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
