import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { api, blobUrl, ClientApiError } from './api.ts'
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint.ts'
import { emailDocument } from './email-document.ts'
import {
  clampIndex,
  idsToMarkRead,
  stableReviewStateJson,
  toggleKeptUnread,
} from './review-state.ts'
import {
  type CodexLoginState,
  type CodexModelId,
  codexModels,
  type DraftResult,
  defaultReviewFilters,
  type FinalizeResult,
  type LoadedReviewCheckpoint,
  type MailAddress,
  type ReplyEditorState,
  type ReplyProposal,
  type ReviewBundle,
  type ReviewBundleRun,
  type ReviewEmail,
  type ReviewFilters,
  type ReviewOptions,
  type ReviewRoundUserState,
  type ReviewSnapshot,
  type ThreadContext,
} from './shared.ts'

export { emailDocument } from './email-document.ts'

type View = 'review' | 'confirm' | 'done'

const DRAFT_STATE_SAVE_DELAY_MS = 750

type ReviewStateUpdate = Omit<ReviewRoundUserState, 'revision'>

function reviewStateCore(state: ReviewRoundUserState | ReviewStateUpdate) {
  const { replyDrafts: _replyDrafts, ...withRevision } = state
  if ('revision' in withRevision) {
    const { revision: _revision, ...core } = withRevision
    return core
  }
  return withRevision
}

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

function restoreBundleGroups(
  run: ReviewBundleRun,
  groups: readonly (readonly string[])[],
  emails: ReviewSnapshot['emails'],
) {
  const expected = new Set(emails.map((email) => email.id))
  const restoredIds = groups.flat()
  if (
    restoredIds.length !== expected.size ||
    new Set(restoredIds).size !== expected.size ||
    restoredIds.some((id) => !expected.has(id))
  ) {
    return run
  }
  const timelineById = new Map(
    run.bundles.flatMap((bundle) => bundle.timeline.map((item) => [item.emailId, item] as const)),
  )
  return {
    ...run,
    bundles: groups.map((group, groupIndex) => {
      const sources = run.bundles.filter((bundle) =>
        bundle.emailIds.some((id) => group.includes(id)),
      )
      const primary = sources[0]
      const original = emails.find((email) => email.id === group[0])
      return {
        bundleId: `restored-${groupIndex}-${group[0]}`,
        currentState:
          group.length === 1 ? 'Einzelne Nachricht' : (primary?.currentState ?? 'Letzter Stand'),
        emailIds: [...group],
        kind: group.length === 1 ? 'standalone' : (primary?.kind ?? 'standalone'),
        linkEvidence: [...new Set(sources.flatMap((bundle) => bundle.linkEvidence))],
        membershipConfidence: 1,
        summary:
          group.length === 1
            ? original?.preview || original?.subject || ''
            : sources.map((bundle) => bundle.summary).join(' '),
        timeline: group
          .map((id) => timelineById.get(id))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)),
        title:
          group.length === 1
            ? original?.subject || '(Kein Betreff)'
            : primary?.title || original?.subject || '(Kein Betreff)',
      } satisfies ReviewBundle
    }),
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

function roundIdFromPath() {
  const match = window.location.pathname.match(/^\/rounds\/([^/]+)\/?$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function setRoundUrl(roundId: string | null, replace = false) {
  const next = roundId ? `/rounds/${encodeURIComponent(roundId)}` : '/'
  window.history[replace ? 'replaceState' : 'pushState']({}, '', next)
}

function analysisStatus(analysis: ReviewSnapshot['analysis']) {
  if (analysis.phase === 'waiting_for_codex') {
    return 'Die angefangene Codex-Analyse wartet auf eine erneute Anmeldung.'
  }
  if (analysis.phase === 'indexing') return 'Nachrichten werden für die Analyse vorbereitet …'
  if (analysis.phase === 'deciding') return 'Codex prüft mögliche Zusammenhänge …'
  if (analysis.phase === 'reconciling') return 'Neue Zusammenhänge werden noch einmal abgeglichen …'
  if (analysis.phase === 'finalizing') return 'Storys werden fertiggestellt …'
  if (analysis.phase === 'fallback') return 'Sichere Einzelansicht wird vorbereitet …'
  if (analysis.phase === 'grouping') return 'Zusammengehörige Nachrichten werden gebündelt …'
  return 'Analyse wird gestartet …'
}

function analysisOrigin(analysis: ReviewSnapshot['analysis']) {
  const label = codexModels.find((model) => model.id === analysis.model)?.label
  if (analysis.engine === 'fallback') {
    return analysis.callCount > 0 && label
      ? `Sichere Einzelansicht · Codex-Versuch ${label}`
      : 'Sichere Einzelansicht'
  }
  if (analysis.engine === 'heuristic') return 'Lokale Analyse'
  return label ? `Codex · ${label}` : 'Codex'
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
  const [checkpoint, setCheckpoint] = useState<LoadedReviewCheckpoint | null>(null)
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null)
  const [bundleRun, setBundleRun] = useState<ReviewBundleRun | null>(null)
  const [details, setDetails] = useState<Record<string, ReviewEmail>>({})
  const [index, setIndex] = useState(0)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [confirmedBundleIds, setConfirmedBundleIds] = useState<Set<string>>(new Set())
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
  const [mergeOpen, setMergeOpen] = useState(false)
  const [codexLoginOpen, setCodexLoginOpen] = useState(false)
  const [codexLogin, setCodexLogin] = useState<CodexLoginState | null>(null)
  const [codexLoginBusy, setCodexLoginBusy] = useState(false)
  const [codexModelBusy, setCodexModelBusy] = useState(false)
  const [codexFallbackBusy, setCodexFallbackBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [replyLoading, setReplyLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState('')
  const [stateConflict, setStateConflict] = useState(false)
  const [statePersistenceFailed, setStatePersistenceFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FinalizeResult | null>(null)
  const restoredRef = useRef(false)
  const activeRoundIdRef = useRef<string | null>(null)
  const activeSnapshotRef = useRef<ReviewSnapshot | null>(null)
  const codexFallbackRequestedRef = useRef(false)
  const stateRevisionRef = useRef(0)
  const persistedStateRef = useRef('')
  const persistedCoreStateRef = useRef('')
  const desiredStateRef = useRef('')
  const desiredCoreStateRef = useRef('')
  const stateSavePromiseRef = useRef<Promise<void> | null>(null)
  const stateSaveTimerRef = useRef<number | null>(null)
  const stateSaveFailedRef = useRef(false)

  const emails = snapshot?.emails ?? []
  const bundles = bundleRun?.bundles ?? []
  const currentBundle = bundles[index]
  const summary = currentBundle
    ? (emails.find(
        (item) => item.id === selectedMemberId && currentBundle.emailIds.includes(item.id),
      ) ?? emails.find((item) => item.id === currentBundle.emailIds[0]))
    : undefined
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
  const analysisPollTarget =
    snapshot && !bundleRun && snapshot.analysis.status !== 'complete' && !codexFallbackBusy
      ? `${snapshot.snapshotId}\0${snapshot.csrfToken}\0${options?.codex.configured ? 'codex-ready' : 'codex-missing'}`
      : null
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

  const applySnapshot = useCallback((nextSnapshot: ReviewSnapshot) => {
    if (stateSaveTimerRef.current !== null) {
      window.clearTimeout(stateSaveTimerRef.current)
      stateSaveTimerRef.current = null
    }
    setStateConflict(false)
    setStatePersistenceFailed(false)
    stateSaveFailedRef.current = false
    if (activeRoundIdRef.current !== nextSnapshot.snapshotId) {
      codexFallbackRequestedRef.current = false
    }
    activeRoundIdRef.current = nextSnapshot.snapshotId
    activeSnapshotRef.current = nextSnapshot
    const state = nextSnapshot.userState
    const nextBundleRun = nextSnapshot.bundleRun
      ? restoreBundleGroups(nextSnapshot.bundleRun, state.bundleGroups, nextSnapshot.emails)
      : null
    const nextIndex = clampIndex(state.index, nextBundleRun?.bundles.length ?? 0)
    setSnapshot(nextSnapshot)
    setBundleRun(nextBundleRun)
    setFilters(nextSnapshot.filters)
    setIndex(nextIndex)
    setSelectedMemberId(
      state.selectedMemberId &&
        nextBundleRun?.bundles[nextIndex]?.emailIds.includes(state.selectedMemberId)
        ? state.selectedMemberId
        : (nextBundleRun?.bundles[nextIndex]?.emailIds[0] ?? null),
    )
    setKeptUnread(new Set(state.keptUnreadIds))
    setProcessedIds(new Set(state.processedIds))
    setSecondaryActionIds(new Set(state.secondaryActionIds))
    setReplyDrafts(state.replyDrafts)
    setResult(nextSnapshot.finalization.result)
    setView(
      nextSnapshot.finalization.status === 'finalized' && nextSnapshot.finalization.result
        ? 'done'
        : nextSnapshot.finalization.selectionLocked
          ? 'confirm'
          : 'review',
    )
    stateRevisionRef.current = state.revision
    const stateFingerprint = stableReviewStateJson({ ...state, revision: undefined })
    const coreStateFingerprint = stableReviewStateJson(reviewStateCore(state))
    persistedStateRef.current = stateFingerprint
    persistedCoreStateRef.current = coreStateFingerprint
    desiredStateRef.current = stateFingerprint
    desiredCoreStateRef.current = coreStateFingerprint
    setCheckpoint({ version: 7, roundId: nextSnapshot.snapshotId })
    saveCheckpoint({ version: 7, roundId: nextSnapshot.snapshotId })
    restoredRef.current = true
    if (nextBundleRun?.fallback) {
      setStatus('Die Analyse nutzt eine sichere Einzelansicht.')
    } else if (nextBundleRun) {
      setStatus(
        `${nextSnapshot.emails.length} Nachrichten in ${nextBundleRun.bundles.length} Storys gebündelt.`,
      )
    } else {
      setStatus(analysisStatus(nextSnapshot.analysis))
    }
  }, [])

  const clearStateSaveTimer = useCallback(() => {
    if (stateSaveTimerRef.current === null) return
    window.clearTimeout(stateSaveTimerRef.current)
    stateSaveTimerRef.current = null
  }, [])

  const triggerStateSave = useCallback(
    (immediate: boolean) => {
      clearStateSaveTimer()
      const roundId = activeRoundIdRef.current
      const currentSnapshot = activeSnapshotRef.current
      if (
        !roundId ||
        currentSnapshot?.snapshotId !== roundId ||
        stateSaveFailedRef.current ||
        desiredStateRef.current === persistedStateRef.current
      ) {
        return
      }
      if (!immediate) {
        stateSaveTimerRef.current = window.setTimeout(() => {
          stateSaveTimerRef.current = null
          triggerStateSave(true)
        }, DRAFT_STATE_SAVE_DELAY_MS)
        return
      }
      if (stateSavePromiseRef.current) return

      const submittedFingerprint = desiredStateRef.current
      const submitted = JSON.parse(submittedFingerprint) as ReviewStateUpdate
      const saving = api
        .updateReviewState(currentSnapshot, stateRevisionRef.current, submitted)
        .then((saved) => {
          if (activeRoundIdRef.current !== roundId) return
          const savedFingerprint = stableReviewStateJson({ ...saved, revision: undefined })
          if (savedFingerprint !== submittedFingerprint) {
            throw new Error(
              'Der gespeicherte Rundenstand weicht von der Anfrage ab. Bitte lade die Runde neu.',
            )
          }
          stateRevisionRef.current = saved.revision
          persistedStateRef.current = savedFingerprint
          persistedCoreStateRef.current = stableReviewStateJson(reviewStateCore(saved))
        })
        .catch((cause) => {
          if (activeRoundIdRef.current !== roundId) return
          stateSaveFailedRef.current = true
          restoredRef.current = false
          if (cause instanceof ClientApiError && cause.code === 'ROUND_REVISION_CONFLICT') {
            setStateConflict(true)
          } else {
            setStatePersistenceFailed(true)
            setError(errorMessage(cause))
          }
        })
        .finally(() => {
          if (stateSavePromiseRef.current === saving) stateSavePromiseRef.current = null
          if (
            !stateSaveFailedRef.current &&
            activeRoundIdRef.current === roundId &&
            desiredStateRef.current !== persistedStateRef.current
          ) {
            const coreChanged = desiredCoreStateRef.current !== persistedCoreStateRef.current
            triggerStateSave(coreChanged)
          }
        })
      stateSavePromiseRef.current = saving
    },
    [clearStateSaveTimer],
  )

  const flushState = useCallback(async () => {
    clearStateSaveTimer()
    while (
      activeRoundIdRef.current &&
      !stateSaveFailedRef.current &&
      desiredStateRef.current !== persistedStateRef.current
    ) {
      triggerStateSave(true)
      const saving = stateSavePromiseRef.current
      if (!saving) break
      await saving
    }
    return !stateSaveFailedRef.current && desiredStateRef.current === persistedStateRef.current
  }, [clearStateSaveTimer, triggerStateSave])

  const applyAnalysisProgress = useCallback((nextSnapshot: ReviewSnapshot) => {
    setSnapshot((current) => {
      if (!current || current.snapshotId !== nextSnapshot.snapshotId) return current
      const next = { ...current, analysis: nextSnapshot.analysis }
      activeSnapshotRef.current = next
      return next
    })
    setStatus(analysisStatus(nextSnapshot.analysis))
  }, [])

  const closeReply = useCallback(() => {
    setReplyOpen(false)
    void flushState()
  }, [flushState])

  const startReview = useCallback(
    async (nextFilters: ReviewFilters, resume: LoadedReviewCheckpoint | null = null) => {
      setLoading(true)
      setError(null)
      setStatus(resume ? 'Offene Runde wird geladen …' : 'Postfach wird abgefragt …')
      try {
        let nextSnapshot: ReviewSnapshot
        if (resume?.version === 7) {
          nextSnapshot = await api.review(resume.roundId)
        } else if (resume?.version === 6 && resume.emailIds.length > 0) {
          nextSnapshot = await api.resumeReview(resume.emailIds, resume.filters)
          const available = new Set(nextSnapshot.emails.map((item) => item.id))
          const availableGroups = resume.bundleGroups.map((group) =>
            group.filter((id) => available.has(id)),
          )
          const groupsCoverRound =
            availableGroups.flat().length === available.size &&
            new Set(availableGroups.flat()).size === available.size
          const migrated = await api.updateReviewState(nextSnapshot, 0, {
            bundleGroups: groupsCoverRound
              ? availableGroups.filter((group) => group.length > 0)
              : [],
            index: resume.index,
            keptUnreadIds: resume.keptUnreadIds.filter((id) => available.has(id)),
            processedIds: resume.processedIds.filter((id) => available.has(id)),
            replyDrafts: Object.fromEntries(
              Object.entries(resume.replyDrafts).filter(([id]) => available.has(id)),
            ),
            secondaryActionIds: resume.secondaryActionIds.filter(
              (id) =>
                available.has(id) &&
                (nextSnapshot.filters.spam === 'only' ||
                  nextSnapshot.emails.some((item) => item.id === id && item.isNewsletter)),
            ),
            selectedMemberId: null,
          })
          nextSnapshot = { ...nextSnapshot, userState: migrated }
        } else {
          nextSnapshot = await api.createReview(nextFilters)
        }
        setRoundUrl(nextSnapshot.snapshotId, resume?.version === 7)
        setConfirmedBundleIds(new Set())
        setDetails({})
        setThreadContexts({})
        setReplyProposals({})
        setDraftResults({})
        setOverviewOpen(false)
        setReplyOpen(false)
        applySnapshot(nextSnapshot)
      } catch (cause) {
        if (
          resume?.version === 7 &&
          cause instanceof ClientApiError &&
          cause.code === 'REVIEW_EXPIRED'
        ) {
          clearCheckpoint()
          setCheckpoint(null)
          setRoundUrl(null, true)
        }
        setError(errorMessage(cause))
        setStatus('Runde konnte nicht geladen werden.')
      } finally {
        setLoading(false)
      }
    },
    [applySnapshot],
  )

  useEffect(() => {
    if (!currentBundle) return
    if (!selectedMemberId || !currentBundle.emailIds.includes(selectedMemberId)) {
      setSelectedMemberId(currentBundle.emailIds[0] ?? null)
    }
  }, [currentBundle, selectedMemberId])

  useEffect(() => {
    let active = true
    void (async () => {
      const savedCheckpoint = loadCheckpoint()
      const pathRoundId = roundIdFromPath()
      const [loadedOptions, loadedRound] = await Promise.allSettled([
        api.options(),
        pathRoundId ? api.review(pathRoundId) : Promise.resolve(null),
      ])
      if (!active) return
      if (loadedOptions.status === 'fulfilled') setOptions(loadedOptions.value)
      else setError(errorMessage(loadedOptions.reason))
      setCheckpoint(savedCheckpoint)
      if (savedCheckpoint?.version === 6) setFilters(savedCheckpoint.filters)
      if (loadedRound.status === 'fulfilled' && loadedRound.value) {
        applySnapshot(loadedRound.value)
        setRoundUrl(loadedRound.value.snapshotId, true)
      } else if (loadedRound.status === 'rejected') {
        if (
          loadedRound.reason instanceof ClientApiError &&
          loadedRound.reason.code === 'REVIEW_EXPIRED'
        ) {
          if (savedCheckpoint?.version === 7 && savedCheckpoint.roundId === pathRoundId) {
            clearCheckpoint()
            setCheckpoint(null)
          }
          setRoundUrl(null, true)
        }
        setError(errorMessage(loadedRound.reason))
      }
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [applySnapshot])

  useEffect(() => {
    let generation = 0
    const onPopState = () => {
      generation += 1
      const currentGeneration = generation
      const roundId = roundIdFromPath()
      void (async () => {
        const previousRoundId = activeRoundIdRef.current
        if (restoredRef.current && !(await flushState())) {
          if (previousRoundId) setRoundUrl(previousRoundId, true)
          return
        }
        if (generation !== currentGeneration) return
        restoredRef.current = false
        activeRoundIdRef.current = null
        activeSnapshotRef.current = null
        setError(null)
        if (!roundId) {
          setSnapshot(null)
          setBundleRun(null)
          setResult(null)
          setView('review')
          setCheckpoint(loadCheckpoint())
          return
        }
        setLoading(true)
        try {
          const round = await api.review(roundId)
          if (generation === currentGeneration) applySnapshot(round)
        } catch (cause) {
          if (generation === currentGeneration) setError(errorMessage(cause))
        } finally {
          if (generation === currentGeneration) setLoading(false)
        }
      })()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [applySnapshot, flushState])

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
          setOptions((current) => (current ? { ...current, codex: auth } : current))
          const resumableSnapshot = activeSnapshotRef.current
          if (
            auth.configured &&
            !codexFallbackRequestedRef.current &&
            resumableSnapshot?.analysis.phase === 'waiting_for_codex' &&
            resumableSnapshot.analysis.status === 'pending'
          ) {
            try {
              const resumed = await api.bundles(resumableSnapshot)
              if (!active) return
              applySnapshot(resumed)
            } catch (cause) {
              if (active) {
                setError(errorMessage(cause))
                setStatus('Codex ist verbunden, aber die Analyse konnte nicht fortgesetzt werden.')
              }
            }
          }
          if (active) setCodexLogin(next)
          return
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
  }, [applySnapshot, codexLoginId, codexLoginStatus])

  useEffect(() => {
    if (!analysisPollTarget || codexFallbackRequestedRef.current) return
    const [analysisRoundId, analysisCsrfToken] = analysisPollTarget.split('\0')
    if (!analysisRoundId || !analysisCsrfToken) return
    let active = true
    let timer = 0
    void (async () => {
      try {
        if (codexFallbackRequestedRef.current) return
        let nextSnapshot = await api.bundles({
          csrfToken: analysisCsrfToken,
          snapshotId: analysisRoundId,
        })
        while (
          active &&
          nextSnapshot.analysis.status !== 'complete' &&
          nextSnapshot.analysis.phase !== 'waiting_for_codex' &&
          !(nextSnapshot.analysis.status === 'pending' && nextSnapshot.analysis.error)
        ) {
          applyAnalysisProgress(nextSnapshot)
          await new Promise<void>((resolve) => {
            timer = window.setTimeout(resolve, 500)
          })
          if (!active) return
          nextSnapshot = await api.review(analysisRoundId)
        }
        if (active) applySnapshot(nextSnapshot)
      } catch (cause) {
        if (active) {
          setError(errorMessage(cause))
          setStatus('Der Analysestatus konnte nicht geladen werden. Die Runde bleibt erhalten.')
        }
      }
    })()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [analysisPollTarget, applyAnalysisProgress, applySnapshot])

  useLayoutEffect(() => {
    if (
      !snapshot ||
      !bundleRun ||
      !restoredRef.current ||
      stateConflict ||
      statePersistenceFailed ||
      snapshot.finalization.selectionLocked ||
      emails.length === 0
    )
      return
    const state: ReviewStateUpdate = {
      bundleGroups: bundles.map((bundle) => bundle.emailIds),
      index,
      keptUnreadIds: [...keptUnread],
      processedIds: [...processedIds],
      replyDrafts,
      secondaryActionIds: [...secondaryActionIds],
      selectedMemberId,
    }
    const fingerprint = stableReviewStateJson(state)
    const coreFingerprint = stableReviewStateJson(reviewStateCore(state))
    desiredStateRef.current = fingerprint
    desiredCoreStateRef.current = coreFingerprint
    if (fingerprint === persistedStateRef.current) {
      clearStateSaveTimer()
      return
    }
    triggerStateSave(coreFingerprint !== persistedCoreStateRef.current)
  }, [
    bundleRun,
    bundles,
    clearStateSaveTimer,
    emails.length,
    index,
    keptUnread,
    processedIds,
    replyDrafts,
    secondaryActionIds,
    selectedMemberId,
    snapshot,
    stateConflict,
    statePersistenceFailed,
    triggerStateSave,
  ])

  useEffect(() => {
    const saveBeforeLeaving = () => {
      if (desiredStateRef.current !== persistedStateRef.current) triggerStateSave(true)
    }
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') saveBeforeLeaving()
    }
    window.addEventListener('pagehide', saveBeforeLeaving)
    document.addEventListener('visibilitychange', saveWhenHidden)
    return () => {
      window.removeEventListener('pagehide', saveBeforeLeaving)
      document.removeEventListener('visibilitychange', saveWhenHidden)
      clearStateSaveTimer()
    }
  }, [clearStateSaveTimer, triggerStateSave])

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
      if (snapshot?.finalization.selectionLocked) return
      setView('review')
      return
    }
    setReplyOpen(false)
    setIndex((current) => Math.max(0, current - 1))
  }, [snapshot?.finalization.selectionLocked, view])

  const next = useCallback(() => {
    if (view !== 'review' || !currentBundle) return
    setReplyOpen(false)
    setProcessedIds((current) => {
      const nextProcessed = new Set(current)
      for (const id of currentBundle.emailIds) nextProcessed.add(id)
      return nextProcessed
    })
    if (index >= bundles.length - 1) setView('confirm')
    else setIndex((current) => current + 1)
  }, [bundles.length, currentBundle, index, view])

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
      if (submitting) return
      if (event.key === 'Escape') {
        if (helpOpen) setHelpOpen(false)
        else if (mergeOpen) setMergeOpen(false)
        else if (replyOpen) closeReply()
        else if (overviewOpen) setOverviewOpen(false)
        else if (view === 'confirm' && !snapshot?.finalization.selectionLocked) setView('review')
        return
      }
      if (replyLoading) return
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
    closeReply,
    mergeOpen,
    next,
    openReply,
    overviewOpen,
    previous,
    replyLoading,
    replyOpen,
    snapshot?.finalization.selectionLocked,
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
      if (!(await flushState()) || !restoredRef.current) return
      const nextResult = await api.finalize(
        snapshot,
        stateRevisionRef.current,
        finalizedEmailIds,
        finalizedKeptUnreadIds,
        finalizedSecondaryActionIds,
      )
      setResult(nextResult)
      setSnapshot((current) =>
        current
          ? {
              ...current,
              finalization: {
                result: nextResult,
                selectionLocked: true,
                status: nextResult.finalized ? 'finalized' : 'active',
              },
            }
          : current,
      )
      if (nextResult.finalized) {
        clearCheckpoint()
        restoredRef.current = false
        activeRoundIdRef.current = null
        setView('done')
        setStatus('Review abgeschlossen.')
      } else {
        setView('confirm')
        setError(
          `${nextResult.remaining} Änderungen sind fehlgeschlagen. Du kannst sie erneut versuchen.`,
        )
        setStatus('Review teilweise gespeichert.')
      }
    } catch (cause) {
      try {
        const latest = await api.review(snapshot.snapshotId)
        if (latest.finalization.selectionLocked) applySnapshot(latest)
      } catch {
        // Keep the original finalization error. Reload remains available if recovery also fails.
      }
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function startNewReview() {
    clearCheckpoint()
    setCheckpoint(null)
    restoredRef.current = false
    activeRoundIdRef.current = null
    activeSnapshotRef.current = null
    setRoundUrl(null, true)
    await startReview(filters, null)
  }

  async function showSetup(discardCheckpoint = false) {
    if (snapshot && restoredRef.current && !(await flushState())) return
    if (discardCheckpoint) clearCheckpoint()
    else if (snapshot) saveCheckpoint({ version: 7, roundId: snapshot.snapshotId })
    restoredRef.current = false
    activeRoundIdRef.current = null
    activeSnapshotRef.current = null
    setCheckpoint(
      discardCheckpoint
        ? null
        : snapshot
          ? { version: 7, roundId: snapshot.snapshotId }
          : loadCheckpoint(),
    )
    setSnapshot(null)
    setBundleRun(null)
    setDetails({})
    setThreadContexts({})
    setReplyProposals({})
    setDraftResults({})
    setReplyDrafts({})
    setResult(null)
    setView('review')
    setOverviewOpen(false)
    setReplyOpen(false)
    setError(null)
    setRoundUrl(null)
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

  async function changeCodexModel(model: CodexModelId) {
    setCodexModelBusy(true)
    setError(null)
    try {
      const codex = await api.selectCodexModel(model)
      setOptions((current) => (current ? { ...current, codex } : current))
      setStatus(`Codex verwendet jetzt ${codexModels.find((item) => item.id === model)?.label}.`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCodexModelBusy(false)
    }
  }

  async function continueWithoutCodex() {
    if (!snapshot) return
    if (codexFallbackRequestedRef.current) return
    codexFallbackRequestedRef.current = true
    setCodexFallbackBusy(true)
    setError(null)
    setStatus('Sichere Einzelansicht wird vorbereitet …')
    try {
      applySnapshot(await api.continueWithoutCodex(snapshot))
    } catch (cause) {
      codexFallbackRequestedRef.current = false
      setError(errorMessage(cause))
      setStatus('Die Runde wartet weiter auf Codex.')
    } finally {
      setCodexFallbackBusy(false)
    }
  }

  async function splitSelectedOriginal() {
    if (!snapshot || !bundleRun || !currentBundle || !summary || currentBundle.emailIds.length < 2)
      return
    const remainingIds = currentBundle.emailIds.filter((id) => id !== summary.id)
    const selectedTimeline = currentBundle.timeline.filter((item) => item.emailId === summary.id)
    const remainingTimeline = currentBundle.timeline.filter((item) => item.emailId !== summary.id)
    const selectedBundle: ReviewBundle = {
      bundleId: `split-${summary.id}`,
      currentState: 'Einzelne Nachricht',
      emailIds: [summary.id],
      kind: 'standalone',
      linkEvidence: [],
      membershipConfidence: 1,
      summary: summary.preview || summary.subject,
      timeline: selectedTimeline,
      title: summary.subject || '(Kein Betreff)',
    }
    const remainingBundle: ReviewBundle = {
      ...currentBundle,
      emailIds: remainingIds,
      timeline: remainingTimeline,
    }
    setBundleRun({
      ...bundleRun,
      bundles: [
        ...bundleRun.bundles.slice(0, index),
        remainingBundle,
        selectedBundle,
        ...bundleRun.bundles.slice(index + 1),
      ],
    })
    setSelectedMemberId(remainingIds[0] ?? summary.id)
    setStatus('Original aus der Story gelöst. Die Korrektur wird für spätere Läufe gemerkt.')
    try {
      await api.bundleLabel(snapshot, {
        anchorEmailIds: remainingIds,
        candidateEmailIds: [summary.id],
        label: 'split',
      })
    } catch (cause) {
      setError(`Die Story wurde getrennt, aber die Lernkorrektur fehlte: ${errorMessage(cause)}`)
    }
  }

  async function confirmCurrentBundle() {
    if (!snapshot || !currentBundle || currentBundle.emailIds.length < 2) return
    setConfirmedBundleIds((current) => new Set(current).add(currentBundle.bundleId))
    setStatus('Verknüpfung bestätigt. Sie kann in späteren Läufen als Beispiel dienen.')
    try {
      await api.bundleLabel(snapshot, {
        anchorEmailIds: [currentBundle.emailIds[0] as string],
        candidateEmailIds: currentBundle.emailIds.slice(1),
        label: 'merge',
      })
    } catch (cause) {
      setConfirmedBundleIds((current) => {
        const nextConfirmed = new Set(current)
        nextConfirmed.delete(currentBundle.bundleId)
        return nextConfirmed
      })
      setError(`Die Bestätigung konnte nicht gespeichert werden: ${errorMessage(cause)}`)
    }
  }

  async function mergeCurrentBundle(targetIndex: number) {
    if (!snapshot || !bundleRun || !currentBundle || targetIndex === index) return
    const target = bundleRun.bundles[targetIndex]
    if (!target) return
    const mergedEmailIds = [...currentBundle.emailIds, ...target.emailIds].sort((left, right) => {
      const leftEmail = emails.find((email) => email.id === left)
      const rightEmail = emails.find((email) => email.id === right)
      return Date.parse(leftEmail?.receivedAt ?? '') - Date.parse(rightEmail?.receivedAt ?? '')
    })
    const merged: ReviewBundle = {
      ...currentBundle,
      bundleId: `merged-${currentBundle.bundleId}-${target.bundleId}`,
      emailIds: mergedEmailIds,
      linkEvidence: [...new Set([...currentBundle.linkEvidence, ...target.linkEvidence])],
      membershipConfidence: 1,
      summary: `${currentBundle.summary} ${target.summary}`,
      timeline: [...currentBundle.timeline, ...target.timeline].sort(
        (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
      ),
    }
    const keepIndex = Math.min(index, targetIndex)
    const nextBundles = bundleRun.bundles.filter(
      (_bundle, bundleIndex) => bundleIndex !== index && bundleIndex !== targetIndex,
    )
    nextBundles.splice(keepIndex, 0, merged)
    setBundleRun({ ...bundleRun, bundles: nextBundles })
    setIndex(keepIndex)
    setSelectedMemberId(merged.emailIds[0] ?? null)
    setMergeOpen(false)
    setStatus('Storys verbunden. Die Korrektur wird für spätere Läufe gemerkt.')
    try {
      await api.bundleLabel(snapshot, {
        anchorEmailIds: currentBundle.emailIds,
        candidateEmailIds: target.emailIds,
        label: 'merge',
      })
    } catch (cause) {
      setError(`Die Storys wurden verbunden, aber die Lernkorrektur fehlte: ${errorMessage(cause)}`)
    }
  }

  const codexDialog =
    codexLoginOpen && options ? (
      <CodexLoginDialog
        authConfigured={options.codex.configured}
        busy={codexLoginBusy}
        login={codexLogin}
        model={options.codex.model}
        modelBusy={codexModelBusy}
        onClose={() => setCodexLoginOpen(false)}
        onModelChange={(model) => void changeCodexModel(model)}
        onStart={() => void startCodexLogin()}
      />
    ) : null

  if (loading) {
    return (
      <main className="state-page" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <h1>Inbox Walk</h1>
        <p>{status || 'Ungelesene Nachrichten werden geladen …'}</p>
      </main>
    )
  }

  if (error && !options && !snapshot && !checkpoint) {
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
      <>
        <ReviewSetup
          checkpoint={checkpoint}
          error={error}
          filters={filters}
          options={options}
          onChange={setFilters}
          onCodex={() => setCodexLoginOpen(true)}
          onResume={() =>
            checkpoint &&
            void startReview(
              checkpoint.version === 6 ? checkpoint.filters : defaultReviewFilters,
              checkpoint,
            )
          }
          onStart={() => void startNewReview()}
        />
        {codexDialog}
      </>
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

  if (stateConflict) {
    return (
      <main className="state-page">
        <h1>Runde wurde in einem anderen Tab geändert</h1>
        <p>
          Deine Ansicht ist veraltet. Lade die Runde neu, damit keine Entscheidung überschrieben
          wird.
        </p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Runde neu laden
        </button>
      </main>
    )
  }

  if (statePersistenceFailed) {
    return (
      <main className="state-page">
        <h1>Rundenstand konnte nicht gespeichert werden</h1>
        <p>
          Die letzte Entscheidung wurde nicht bestätigt. Lade die Runde neu, bevor du
          weiterarbeitest.
        </p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Runde neu laden
        </button>
      </main>
    )
  }

  if (!bundleRun) {
    const percent = Math.round(snapshot.analysis.progress * 100)
    const waitingForCodex = snapshot.analysis.phase === 'waiting_for_codex'
    return (
      <>
        <main
          className="state-page analysis-page"
          aria-busy={snapshot.analysis.status !== 'complete'}
        >
          {snapshot.analysis.status !== 'complete' && !waitingForCodex && (
            <div className="spinner" aria-hidden="true" />
          )}
          <p className="analysis-origin">{analysisOrigin(snapshot.analysis)}</p>
          <h1>
            {waitingForCodex ? 'Codex-Anmeldung erforderlich' : 'Zusammenhänge werden analysiert'}
          </h1>
          <p>{analysisStatus(snapshot.analysis)}</p>
          <div
            className="analysis-progress"
            role="progressbar"
            aria-label="Analysefortschritt"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="analysis-detail">
            {snapshot.analysis.processedEmailCount} von {snapshot.analysis.totalEmailCount}{' '}
            Nachrichten · Runde {snapshot.snapshotId.slice(0, 8)}
            {snapshot.analysis.callCount > 0 && ` · ${snapshot.analysis.callCount} Codex-Aufrufe`}
          </p>
          {waitingForCodex && (
            <>
              <div className="analysis-actions">
                <button
                  type="button"
                  className="button primary analysis-login"
                  disabled={codexFallbackBusy}
                  onClick={() => setCodexLoginOpen(true)}
                >
                  Codex wieder verbinden
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={codexFallbackBusy}
                  onClick={() => void continueWithoutCodex()}
                >
                  {codexFallbackBusy ? 'Wird vorbereitet …' : 'Ohne Codex fortsetzen'}
                </button>
              </div>
              <p className="analysis-fallback-note">
                Ohne Codex wird jede Nachricht einzeln angezeigt. Codex startet für diese Runde
                später nicht erneut.
              </p>
            </>
          )}
          {(error ||
            (snapshot.analysis.error && !waitingForCodex) ||
            snapshot.analysis.status === 'complete') && (
            <div className="inline-error" role="alert">
              <strong>Die Runde bleibt gespeichert.</strong>
              <p>
                {error ||
                  snapshot.analysis.error ||
                  'Das Analyseergebnis ist unvollständig. Lade dieselbe Runde erneut.'}
              </p>
              <button
                type="button"
                className="button secondary"
                onClick={() => window.location.reload()}
              >
                Dieselbe Runde neu laden
              </button>
            </div>
          )}
        </main>
        {codexDialog}
      </>
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
        <button type="button" className="button primary" onClick={() => void showSetup(true)}>
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
            disabled={submitting || Boolean(result) || snapshot.finalization.selectionLocked}
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

  if (!summary || !currentBundle) {
    return (
      <main className="state-page">
        <h1>Storys nicht verfügbar</h1>
        <p>Die Runde ist gespeichert, aber das Analyseergebnis ist unvollständig.</p>
        <button type="button" className="button secondary" onClick={() => window.location.reload()}>
          Dieselbe Runde neu laden
        </button>
      </main>
    )
  }

  const progress = ((index + 1) / bundles.length) * 100

  return (
    <div className={`app-shell ${replyOpen ? 'with-reply' : ''}`}>
      {snapshot.analysis.error && (
        <p className="snapshot-warning" role="status">
          {snapshot.analysis.error}
        </p>
      )}
      <header className="topbar">
        <button
          type="button"
          className="brand-button"
          onClick={() => setOverviewOpen(true)}
          aria-label="Nachrichtenübersicht öffnen"
        >
          <span>Inbox Walk</span>
          <span className="counter">
            Story {index + 1} / {bundles.length} · {emails.length} Nachrichten
          </span>
        </button>
        <div className="top-actions">
          {snapshot.mode === 'demo' && <span className="mode-label">Demo</span>}
          <span
            className={`analysis-badge ${snapshot.analysis.engine}`}
            title={analysisOrigin(snapshot.analysis)}
          >
            {analysisOrigin(snapshot.analysis)}
            {snapshot.analysis.callCount > 0 &&
              ` · ${snapshot.analysis.callCount} ${snapshot.analysis.callCount === 1 ? 'Aufruf' : 'Aufrufe'}`}
          </span>
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

      <main className="reader">
        <section className="bundle-story" aria-labelledby="bundle-title">
          <header className="bundle-heading">
            <div>
              <p className="bundle-kicker">
                {currentBundle.timeline
                  .map((item) => item.source)
                  .filter((source, sourceIndex, sources) => sources.indexOf(source) === sourceIndex)
                  .join(' · ')}
              </p>
              <h1 id="bundle-title">{currentBundle.title}</h1>
            </div>
            <span className="bundle-state">{currentBundle.currentState}</span>
          </header>
          <p className="bundle-summary">{currentBundle.summary}</p>
          <ol className="bundle-timeline" aria-label="Verlauf der Story">
            {currentBundle.timeline.map((item) => {
              const original = emails.find((emailItem) => emailItem.id === item.emailId)
              return (
                <li key={item.emailId}>
                  <button
                    type="button"
                    className={summary.id === item.emailId ? 'selected' : ''}
                    onClick={() => {
                      setSelectedMemberId(item.emailId)
                      setReplyOpen(false)
                    }}
                  >
                    <time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>
                    <strong>
                      {item.source} · {item.event}
                    </strong>
                    <span>
                      {keptUnread.has(item.emailId) ? 'Bleibt ungelesen' : original?.preview}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="bundle-tools">
            <span>
              {currentBundle.emailIds.length}{' '}
              {currentBundle.emailIds.length === 1 ? 'Original' : 'Originale'}
            </span>
            <div>
              <button
                type="button"
                className="text-button"
                disabled={bundles.length < 2}
                onClick={() => setMergeOpen(true)}
              >
                Mit anderer Story verbinden
              </button>
              <button
                type="button"
                className="text-button"
                disabled={
                  currentBundle.emailIds.length < 2 ||
                  confirmedBundleIds.has(currentBundle.bundleId)
                }
                onClick={() => void confirmCurrentBundle()}
              >
                {confirmedBundleIds.has(currentBundle.bundleId)
                  ? 'Verknüpfung bestätigt'
                  : 'Verknüpfung stimmt'}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={currentBundle.emailIds.length < 2}
                onClick={() => void splitSelectedOriginal()}
              >
                Ausgewähltes Original lösen
              </button>
            </div>
          </div>
        </section>
        <article className="message-card">
          <header className="message-header">
            <div className="message-heading">
              <div>
                <p className="sender" title={fullAddress(summary.from)}>
                  {addressLine(summary.from)}
                </p>
                <p className="original-subject">{summary.subject || '(Kein Betreff)'}</p>
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
            <span>{index === bundles.length - 1 ? 'Abschließen' : 'Story erledigt'}</span>
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
          bundles={bundles}
          currentIndex={index}
          keptUnread={keptUnread}
          processedIds={processedIds}
          secondaryActionIds={secondaryActionIds}
          isSpamReview={isSpamReview}
          onClose={() => setOverviewOpen(false)}
          onSelect={(nextIndex) => {
            setIndex(nextIndex)
            setSelectedMemberId(bundles[nextIndex]?.emailIds[0] ?? null)
            setReplyOpen(false)
            setOverviewOpen(false)
          }}
          onDiscard={() => void showSetup(true)}
        />
      )}
      {helpOpen && <HelpDialog isSpamReview={isSpamReview} onClose={() => setHelpOpen(false)} />}
      {mergeOpen && (
        <MergeDialog
          bundles={bundles}
          currentIndex={index}
          onClose={() => setMergeOpen(false)}
          onSelect={(targetIndex) => void mergeCurrentBundle(targetIndex)}
        />
      )}
      {codexDialog}
      {replyOpen && (
        <ReplyPanel
          context={thread}
          draftResult={draftResult}
          editor={editor}
          loading={replyLoading}
          proposal={proposal}
          submitting={submitting}
          onClose={closeReply}
          onGenerate={() => void generateReply()}
          onSave={() => void saveDraft()}
          onUpdate={updateEditor}
        />
      )}
    </div>
  )
}

function MergeDialog({
  bundles,
  currentIndex,
  onClose,
  onSelect,
}: {
  bundles: ReviewBundle[]
  currentIndex: number
  onClose: () => void
  onSelect: (index: number) => void
}) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="dialog merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <div>
            <h2 id="merge-title">Story verbinden</h2>
            <p className="dialog-kicker">Welche Story beschreibt denselben Zusammenhang?</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <div className="merge-list">
          {bundles.map((bundle, bundleIndex) =>
            bundleIndex === currentIndex ? null : (
              <button type="button" key={bundle.bundleId} onClick={() => onSelect(bundleIndex)}>
                <strong>{bundle.title}</strong>
                <span>{bundle.emailIds.length} Nachrichten</span>
              </button>
            ),
          )}
        </div>
      </section>
    </div>
  )
}

function ReviewSetup({
  checkpoint,
  error,
  filters,
  options,
  onChange,
  onCodex,
  onResume,
  onStart,
}: {
  checkpoint: LoadedReviewCheckpoint | null
  error: string | null
  filters: ReviewFilters
  options: ReviewOptions | null
  onChange: (filters: ReviewFilters) => void
  onCodex: () => void
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

      {checkpoint && (checkpoint.version === 7 || checkpoint.emailIds.length > 0) && (
        <section className="resume-review" aria-labelledby="resume-title">
          <div>
            <h2 id="resume-title">Offene Runde</h2>
            <p>
              {checkpoint.version === 7
                ? `Runde ${checkpoint.roundId.slice(0, 8)} · serverseitig gespeichert`
                : `${checkpoint.emailIds.length} Nachrichten · ${checkpoint.processedIds.length} bearbeitet`}
            </p>
          </div>
          <button type="button" className="button secondary" onClick={onResume}>
            Runde fortsetzen
          </button>
        </section>
      )}

      {options?.mode === 'live' && (
        <section className="setup-integration" aria-labelledby="setup-codex-title">
          <div>
            <h2 id="setup-codex-title">Zusammenhänge mit Codex</h2>
            <p>
              {options.codex.configured
                ? `Verbunden mit ${codexModels.find((model) => model.id === options.codex.model)?.label}. Codex prüft die Kandidaten einmal beim Start einer neuen Runde.`
                : 'Nicht verbunden. Eine neue Runde nutzt sonst nur die lokale Analyse.'}
            </p>
          </div>
          <button type="button" className="button secondary" onClick={onCodex}>
            {options.codex.configured ? 'Codex einstellen' : 'Codex verbinden'}
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
              <strong>Zurückgestellte Nachrichten ausblenden</strong>
              <small>
                {options?.reviewedCount === 1
                  ? '1 Nachricht wurde angesehen und bewusst ungelesen behalten'
                  : `${options?.reviewedCount ?? 0} Nachrichten wurden angesehen und bewusst ungelesen behalten`}
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
  bundles,
  currentIndex,
  keptUnread,
  processedIds,
  secondaryActionIds,
  isSpamReview,
  onClose,
  onDiscard,
  onSelect,
}: {
  bundles: ReviewBundle[]
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
          {bundles.map((bundle, itemIndex) => (
            <li key={bundle.bundleId}>
              <button
                type="button"
                className={itemIndex === currentIndex ? 'current' : ''}
                onClick={() => onSelect(itemIndex)}
              >
                <span className="overview-index">{String(itemIndex + 1).padStart(2, '0')}</span>
                <span className="overview-copy">
                  <strong>{bundle.title || '(Kein Betreff)'}</strong>
                  <small>
                    {bundle.emailIds.length}{' '}
                    {bundle.emailIds.length === 1 ? 'Nachricht' : 'Nachrichten'} ·{' '}
                    {bundle.timeline
                      .map((item) => item.source)
                      .filter(
                        (source, sourceIndex, sources) => sources.indexOf(source) === sourceIndex,
                      )
                      .join(', ')}
                  </small>
                </span>
                <span className="overview-marks">
                  {bundle.emailIds.every((id) => processedIds.has(id)) && (
                    <span className="processed-mark">bearbeitet</span>
                  )}
                  {bundle.emailIds.some((id) => keptUnread.has(id)) && (
                    <span className="unread-mark">ungelesen</span>
                  )}
                  {bundle.emailIds.some((id) => secondaryActionIds.has(id)) && (
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
            <dd>Story wechseln</dd>
          </div>
          <div>
            <dt>
              <kbd>↑</kbd>
            </dt>
            <dd>Ausgewähltes Original ungelesen schützen</dd>
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
  modelBusy,
  onClose,
  onModelChange,
  onStart,
}: {
  authConfigured: boolean
  busy: boolean
  login: CodexLoginState | null
  model: CodexModelId
  modelBusy: boolean
  onClose: () => void
  onModelChange: (model: CodexModelId) => void
  onStart: () => void
}) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  const [selectedModel, setSelectedModel] = useState<CodexModelId>(model)
  const waiting = login?.status === 'starting' || login?.status === 'waiting'
  useEffect(() => setSelectedModel(model), [model])
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
            <h2 id="codex-title">Codex einrichten</h2>
            <p className="dialog-kicker">ChatGPT-Abo</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <p className="dialog-note">
          OpenAI erneuert diese OAuth-Anmeldung automatisch. Sie bleibt auf dem privaten
          App-Speicher; ein OpenAI-API-Schlüssel ist nicht nötig.
        </p>
        <fieldset className="codex-model-section">
          <legend>Modell</legend>
          <p>Gilt für neue Bundles und Antwortentwürfe.</p>
          <div className="codex-model-list">
            {codexModels.map((option) => (
              <label
                className="codex-model-choice"
                data-selected={selectedModel === option.id}
                key={option.id}
              >
                <input
                  type="radio"
                  name="codex-model"
                  value={option.id}
                  checked={selectedModel === option.id}
                  disabled={modelBusy}
                  onChange={() => setSelectedModel(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="button secondary codex-model-save"
            disabled={modelBusy || selectedModel === model}
            onClick={() => onModelChange(selectedModel)}
          >
            {modelBusy ? 'Wird gespeichert …' : 'Modell speichern'}
          </button>
        </fieldset>
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
