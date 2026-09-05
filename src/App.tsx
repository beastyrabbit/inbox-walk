import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { api, blobUrl, ClientApiError, type CodexSettings } from './api.ts'
import { restoreBundleGroups } from './bundle-groups.ts'
import {
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  stageCheckpointMigration,
} from './checkpoint.ts'
import { emailDocument } from './email-document.ts'
import {
  addressesToText,
  applyReplyProposal,
  parseAddresses,
  patchReplyEditor,
} from './reply-editor.ts'
import {
  clampIndex,
  idsToMarkRead,
  stableReviewStateJson,
  toggleKeptUnread,
} from './review-state.ts'
import {
  type CodexLoginState,
  type CodexModelId,
  type CodexThinkingLevel,
  codexModels,
  type DraftResult,
  defaultReviewFilters,
  type FinalizeResult,
  type LegacyReviewCheckpoint,
  type MailAddress,
  type ReplyEditorState,
  type ReplyProposal,
  type ReviewBundle,
  type ReviewBundleRun,
  type ReviewEmail,
  type ReviewFilters,
  type ReviewOptions,
  type ReviewRoundUserState,
  type ReviewRunSummary,
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

function roundIdFromPath() {
  const match = window.location.pathname.match(/^\/rounds\/([^/]+)\/?$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function setRoundUrl(roundId: string | null, replace = false) {
  const next = roundId ? `/rounds/${encodeURIComponent(roundId)}` : '/'
  window.history[replace ? 'replaceState' : 'pushState']({}, '', next)
}

function clearCheckpointForRound(roundId: string) {
  try {
    const checkpoint = loadCheckpoint()
    if (checkpoint?.version === 7 && checkpoint.roundId === roundId) clearCheckpoint()
  } catch {
    // Never discard a legacy checkpoint just because a URL points to an expired round.
  }
}

function analysisStatus(analysis: ReviewSnapshot['analysis']) {
  if (analysis.phase === 'waiting_for_codex') {
    return 'Die angefangene Codex-Analyse wartet auf eine erneute Anmeldung.'
  }
  if (analysis.phase === 'indexing') return 'Nachrichten werden für die Analyse vorbereitet …'
  if (analysis.phase === 'deciding') return 'Codex analysiert alle Nachrichten gemeinsam …'
  if (analysis.phase === 'reconciling') return 'Vollständigkeit der Gruppierung wird geprüft …'
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

function newestRunsFirst(runs: ReviewRunSummary[]) {
  return [...runs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

function replaceRun(runs: ReviewRunSummary[], next: ReviewRunSummary) {
  return newestRunsFirst([next, ...runs.filter((run) => run.id !== next.id)])
}

function legacyMigrationState(
  checkpoint: LegacyReviewCheckpoint,
  snapshot: ReviewSnapshot,
): ReviewStateUpdate {
  const available = new Set(snapshot.emails.map((email) => email.id))
  if (available.size === 0) {
    throw new Error(
      'Keine Nachricht der alten Runde ist noch verfügbar. Der alte Rundenstand bleibt im Browser erhalten.',
    )
  }

  const statefulIds = [
    ...checkpoint.keptUnreadIds,
    ...checkpoint.processedIds,
    ...checkpoint.secondaryActionIds,
    ...Object.keys(checkpoint.replyDrafts),
  ]
  if (statefulIds.some((id) => !available.has(id))) {
    throw new Error(
      'Mindestens eine Nachricht mit einer Entscheidung oder einem Entwurf ist nicht mehr verfügbar. Der alte Rundenstand bleibt im Browser erhalten.',
    )
  }

  const bundleGroups = checkpoint.bundleGroups
    .map((group) => group.filter((id) => available.has(id)))
    .filter((group) => group.length > 0)
  if (checkpoint.bundleGroups.length > 0) {
    const groupedIds = bundleGroups.flat()
    if (groupedIds.length !== available.size || new Set(groupedIds).size !== available.size) {
      throw new Error(
        'Die gespeicherten Storys der alten Runde sind unvollständig. Der alte Rundenstand bleibt im Browser erhalten.',
      )
    }
  }

  const byId = new Map(snapshot.emails.map((email) => [email.id, email]))
  if (
    snapshot.filters.spam === 'exclude' &&
    checkpoint.secondaryActionIds.some((id) => !byId.get(id)?.isNewsletter)
  ) {
    throw new Error(
      'Eine gespeicherte Newsletter-Aktion kann nicht mehr sicher zugeordnet werden. Der alte Rundenstand bleibt im Browser erhalten.',
    )
  }

  return {
    bundleGroups: checkpoint.bundleGroups.length > 0 ? bundleGroups : [],
    index: clampIndex(
      checkpoint.index,
      checkpoint.bundleGroups.length ||
        snapshot.bundleRun?.bundles.length ||
        snapshot.emails.length,
    ),
    keptUnreadIds: checkpoint.keptUnreadIds,
    processedIds: checkpoint.processedIds,
    replyDrafts: checkpoint.replyDrafts,
    secondaryActionIds: checkpoint.secondaryActionIds,
    selectedMemberId: null,
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
  const [options, setOptions] = useState<ReviewOptions | null>(null)
  const [codexSettings, setCodexSettings] = useState<CodexSettings | null>(null)
  const [runs, setRuns] = useState<ReviewRunSummary[]>([])
  const [filters, setFilters] = useState<ReviewFilters>(defaultReviewFilters)
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null)
  const [bundleRun, setBundleRun] = useState<ReviewBundleRun | null>(null)
  const [details, setDetails] = useState<Record<string, ReviewEmail>>({})
  const [index, setIndex] = useState(0)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [deleteRun, setDeleteRun] = useState<ReviewRunSummary | null>(null)
  const [codexLogin, setCodexLogin] = useState<CodexLoginState | null>(null)
  const [codexLoginBusy, setCodexLoginBusy] = useState(false)
  const [codexSettingsBusy, setCodexSettingsBusy] = useState(false)
  const [runActionIds, setRunActionIds] = useState<Set<string>>(new Set())
  const [deletingRunIds, setDeletingRunIds] = useState<Set<string>>(new Set())
  const [migrationRoundId, setMigrationRoundId] = useState<string | null>(null)
  const [creatingRun, setCreatingRun] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [failedDetails, setFailedDetails] = useState<Set<string>>(new Set())
  const [pendingDetails, setPendingDetails] = useState<Set<string>>(new Set())
  const roundEpochRef = useRef(0)
  const detailRequestsRef = useRef(new Map<string, Promise<ReviewEmail>>())
  const replyBodyEditsRef = useRef(new Map<string, number>())
  const [replyLoading, setReplyLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState('')
  const [stateConflict, setStateConflict] = useState(false)
  const [statePersistenceFailed, setStatePersistenceFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runStatusError, setRunStatusError] = useState<string | null>(null)
  const [result, setResult] = useState<FinalizeResult | null>(null)
  const restoredRef = useRef(false)
  const activeRoundIdRef = useRef<string | null>(null)
  const activeSnapshotRef = useRef<ReviewSnapshot | null>(null)
  const stateRevisionRef = useRef(0)
  const persistedStateRef = useRef('')
  const persistedCoreStateRef = useRef('')
  const desiredStateRef = useRef('')
  const desiredCoreStateRef = useRef('')
  const stateSavePromiseRef = useRef<Promise<void> | null>(null)
  const stateSaveTimerRef = useRef<number | null>(null)
  const stateSaveFailedRef = useRef(false)
  const creatingRunRef = useRef(false)
  const legacyMigrationRef = useRef<LegacyReviewCheckpoint | null>(null)

  const emails = snapshot?.emails ?? []
  const bundles = bundleRun?.bundles ?? []
  const hasActiveRun = runs.some((run) => ['queued', 'fetching', 'analyzing'].includes(run.status))
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
    roundEpochRef.current += 1
    detailRequestsRef.current.clear()
    replyBodyEditsRef.current.clear()
    setReplyLoading(false)
    setFailedDetails(new Set())
    setPendingDetails(new Set())
    if (stateSaveTimerRef.current !== null) {
      window.clearTimeout(stateSaveTimerRef.current)
      stateSaveTimerRef.current = null
    }
    setStateConflict(false)
    setStatePersistenceFailed(false)
    stateSaveFailedRef.current = false
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

  const closeReply = useCallback(() => {
    setReplyOpen(false)
    void flushState()
  }, [flushState])

  const refreshRuns = useCallback(async () => {
    const response = await api.reviewRuns()
    setRunStatusError(null)
    setRuns((current) => {
      if (!creatingRunRef.current) return response.runs
      const persistedIds = new Set(response.runs.map((run) => run.id))
      const pending = current.filter((run) => !run.csrfToken && !persistedIds.has(run.id))
      return newestRunsFirst([...response.runs, ...pending])
    })
    return response.runs
  }, [])

  const openReview = useCallback(
    async (roundId: string, replaceUrl = false) => {
      setLoading(true)
      setError(null)
      setStatus('Runde wird geöffnet …')
      try {
        const nextSnapshot = await api.review(roundId)
        if (!nextSnapshot.bundleRun) {
          setRoundUrl(null, true)
          await refreshRuns()
          return
        }
        setRoundUrl(nextSnapshot.snapshotId, replaceUrl)
        setDetails({})
        setThreadContexts({})
        setReplyProposals({})
        setDraftResults({})
        setOverviewOpen(false)
        setReplyOpen(false)
        applySnapshot(nextSnapshot)
      } catch (cause) {
        if (cause instanceof ClientApiError) {
          if (['REVIEW_EXPIRED', 'ROUND_NOT_FOUND'].includes(cause.code)) {
            clearCheckpointForRound(roundId)
          }
          if (
            [
              'REVIEW_EXPIRED',
              'ROUND_NOT_FOUND',
              'ROUND_NOT_READY',
              'ROUND_SNAPSHOT_INCOMPLETE',
              'REVIEW_NOT_READY',
            ].includes(cause.code)
          ) {
            setRoundUrl(null, true)
          }
        }
        try {
          await refreshRuns()
        } catch {
          setRunStatusError('Der aktuelle Rundenstatus konnte nicht geladen werden.')
        }
        setError(errorMessage(cause))
        setStatus('Runde konnte nicht geladen werden.')
      } finally {
        setLoading(false)
      }
    },
    [applySnapshot, refreshRuns],
  )

  const finishLegacyMigration = useCallback(
    async (roundId: string) => {
      const legacy = legacyMigrationRef.current
      if (!legacy || legacy.migrationRoundId !== roundId) return
      setRunActionIds((current) => new Set(current).add(roundId))
      setError(null)
      setStatus('Alter Rundenstand wird wiederhergestellt …')
      try {
        const resumed = await api.review(roundId)
        const desired = legacyMigrationState(legacy, resumed)
        const current = { ...resumed.userState, revision: undefined }
        const migratedState =
          stableReviewStateJson(current) === stableReviewStateJson(desired)
            ? resumed.userState
            : resumed.userState.revision === 0
              ? await api.updateReviewState(resumed, 0, desired)
              : (() => {
                  throw new Error(
                    'Die bereits gespeicherte Runde hat einen anderen Stand. Der alte Rundenstand bleibt im Browser erhalten.',
                  )
                })()
        if (!saveCheckpoint({ version: 7, roundId })) {
          throw new Error(
            'Die neue Runden-ID konnte nicht im Browser gespeichert werden. Der alte Rundenstand bleibt erhalten.',
          )
        }
        legacyMigrationRef.current = null
        setRoundUrl(roundId, true)
        applySnapshot({ ...resumed, userState: migratedState })
      } catch (cause) {
        setError(`Der alte Rundenstand konnte nicht übertragen werden. ${errorMessage(cause)}`)
        setStatus('Alter Rundenstand konnte nicht wiederhergestellt werden.')
      } finally {
        setRunActionIds((current) => {
          const next = new Set(current)
          next.delete(roundId)
          return next
        })
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
      const pathRoundId = roundIdFromPath()
      let legacyCheckpoint: LegacyReviewCheckpoint | null = null
      let checkpointError: string | null = null
      if (!pathRoundId) {
        try {
          const saved = loadCheckpoint()
          if (saved?.version === 6) legacyCheckpoint = saved
        } catch (cause) {
          checkpointError = errorMessage(cause)
        }
      }
      const [loadedOptions, loadedRuns, loadedRound, loadedCodexSettings] =
        await Promise.allSettled([
          api.options(),
          api.reviewRuns(),
          pathRoundId ? api.review(pathRoundId) : Promise.resolve(null),
          api.codexSettings(),
        ])
      if (!active) return
      if (loadedOptions.status === 'fulfilled') {
        setOptions(loadedOptions.value)
      } else setError(errorMessage(loadedOptions.reason))
      if (loadedCodexSettings.status === 'fulfilled') {
        setCodexSettings(loadedCodexSettings.value)
      } else if (loadedOptions.status === 'fulfilled') {
        setCodexSettings(loadedOptions.value.codex)
      }
      if (loadedRuns.status === 'fulfilled') setRuns(loadedRuns.value.runs)
      else setError(errorMessage(loadedRuns.reason))
      if (checkpointError) setError(checkpointError)
      if (loadedRound.status === 'fulfilled' && loadedRound.value) {
        if (loadedRound.value.bundleRun) {
          applySnapshot(loadedRound.value)
          setRoundUrl(loadedRound.value.snapshotId, true)
        } else {
          setRoundUrl(null, true)
        }
      } else if (loadedRound.status === 'rejected') {
        if (
          loadedRound.reason instanceof ClientApiError &&
          ['REVIEW_EXPIRED', 'ROUND_NOT_FOUND'].includes(loadedRound.reason.code)
        ) {
          if (pathRoundId) clearCheckpointForRound(pathRoundId)
          setRoundUrl(null, true)
        } else if (
          loadedRound.reason instanceof ClientApiError &&
          ['ROUND_NOT_READY', 'ROUND_SNAPSHOT_INCOMPLETE', 'REVIEW_NOT_READY'].includes(
            loadedRound.reason.code,
          )
        ) {
          setRoundUrl(null, true)
        } else {
          setError(errorMessage(loadedRound.reason))
        }
      }
      if (!pathRoundId && legacyCheckpoint) {
        legacyMigrationRef.current = legacyCheckpoint
        setFilters(legacyCheckpoint.filters)
        setStatus('Alter Rundenstand wird einmalig sicher gespeichert …')
        try {
          if (legacyCheckpoint.emailIds.length === 0) {
            throw new Error(
              'Der alte Rundenstand enthält keine Snapshot-IDs und kann nicht sicher übertragen werden. Er bleibt im Browser erhalten.',
            )
          }
          let stagedCheckpoint = legacyCheckpoint
          let migrationId = legacyCheckpoint.migrationRoundId
          if (!migrationId) {
            migrationId = crypto.randomUUID()
            const staged = stageCheckpointMigration(legacyCheckpoint, migrationId)
            if (!staged) {
              throw new Error(
                'Die Übertragung konnte nicht im Browser vorgemerkt werden. Der alte Rundenstand bleibt erhalten.',
              )
            }
            stagedCheckpoint = staged
            legacyMigrationRef.current = staged
          }
          const listedMigration =
            migrationId && loadedRuns.status === 'fulfilled'
              ? loadedRuns.value.runs.some((run) => run.id === migrationId)
              : false
          if (!listedMigration) {
            await api.resumeReview(migrationId, stagedCheckpoint.emailIds, stagedCheckpoint.filters)
          }
          if (!active) return
          setMigrationRoundId(migrationId ?? null)
          setStatus('Die alte Runde wird analysiert und danach wiederhergestellt …')
          await refreshRuns().catch(() => undefined)
        } catch (cause) {
          if (active) {
            setError(`Der alte Rundenstand konnte nicht übertragen werden. ${errorMessage(cause)}`)
          }
        }
      }
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [applySnapshot, refreshRuns])

  useEffect(() => {
    if (snapshot || (!migrationRoundId && !hasActiveRun)) return
    let active = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const response = await api.reviewRuns()
        if (active) {
          setRunStatusError(null)
          setRuns((current) => {
            if (!creatingRunRef.current) return response.runs
            const persistedIds = new Set(response.runs.map((run) => run.id))
            const pending = current.filter((run) => !run.csrfToken && !persistedIds.has(run.id))
            return newestRunsFirst([...response.runs, ...pending])
          })
        }
      } catch {
        if (active) {
          setRunStatusError(
            'Der Rundenstatus kann gerade nicht aktualisiert werden. Der letzte Stand bleibt sichtbar.',
          )
        }
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => void poll(), 1_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [hasActiveRun, migrationRoundId, snapshot])

  useEffect(() => {
    if (!migrationRoundId || snapshot) return
    const migrated = runs.find((run) => run.id === migrationRoundId)
    if (!migrated) return
    if (migrated.status === 'failed') {
      setMigrationRoundId(null)
      setError(
        migrated.analysis.error ||
          'Der alte Rundenstand wurde gespeichert, aber seine Analyse ist fehlgeschlagen.',
      )
      return
    }
    if (migrated.status !== 'ready') return
    setMigrationRoundId(null)
    if (legacyMigrationRef.current?.migrationRoundId === migrated.id) {
      void finishLegacyMigration(migrated.id)
    } else {
      void openReview(migrated.id, true)
    }
  }, [finishLegacyMigration, migrationRoundId, openReview, runs, snapshot])

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
        setSnapshot(null)
        setBundleRun(null)
        setDetails({})
        setThreadContexts({})
        setReplyProposals({})
        setDraftResults({})
        setResult(null)
        setView('review')
        setOverviewOpen(false)
        setReplyOpen(false)
        if (!roundId) {
          void refreshRuns().catch(() => undefined)
          return
        }
        setLoading(true)
        try {
          const round = await api.review(roundId)
          if (generation === currentGeneration) applySnapshot(round)
        } catch (cause) {
          if (generation === currentGeneration) {
            if (
              cause instanceof ClientApiError &&
              ['REVIEW_EXPIRED', 'ROUND_NOT_FOUND'].includes(cause.code)
            ) {
              clearCheckpointForRound(roundId)
            }
            setRoundUrl(null, true)
            setError(errorMessage(cause))
            await refreshRuns().catch(() =>
              setRunStatusError('Der aktuelle Rundenstatus konnte nicht geladen werden.'),
            )
          }
        } finally {
          if (generation === currentGeneration) setLoading(false)
        }
      })()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [applySnapshot, flushState, refreshRuns])

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
          setCodexSettings(auth)
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
  }, [codexLoginId, codexLoginStatus])

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
    const epoch = roundEpochRef.current
    const belongsToRound = () =>
      activeRoundIdRef.current === snapshot.snapshotId && roundEpochRef.current === epoch
    setPendingDetails((current) => new Set(current).add(summary.id))
    setDetailLoading(true)
    setError(null)
    const requestKey = `${epoch}/${summary.id}`
    let request = detailRequestsRef.current.get(requestKey)
    if (!request) {
      request = api.email(snapshot.snapshotId, summary.id)
      detailRequestsRef.current.set(requestKey, request)
    }
    void request
      .then((loaded) => {
        if (belongsToRound()) setDetails((current) => ({ ...current, [loaded.id]: loaded }))
      })
      .catch((cause) => {
        if (!belongsToRound()) return
        if (detailRequestsRef.current.get(requestKey) === request)
          detailRequestsRef.current.delete(requestKey)
        setFailedDetails((current) => new Set(current).add(summary.id))
        setKeptUnread((current) => new Set(current).add(summary.id))
        setError(`${errorMessage(cause)} Die Nachricht bleibt vorsichtshalber ungelesen.`)
        setStatus('Nachrichteninhalt nicht verfügbar; ungelesen geschützt.')
      })
      .finally(() => {
        if (belongsToRound())
          setPendingDetails((current) => {
            const next = new Set(current)
            next.delete(summary.id)
            return next
          })
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
    if (summary && !details[summary.id] && !failedDetails.has(summary.id)) return
    setReplyOpen(false)
    setProcessedIds((current) => {
      const nextProcessed = new Set(current)
      for (const id of currentBundle.emailIds) nextProcessed.add(id)
      return nextProcessed
    })
    if (index >= bundles.length - 1) setView('confirm')
    else setIndex((current) => current + 1)
  }, [bundles.length, currentBundle, index, view, summary, details, failedDetails])

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
    const epoch = roundEpochRef.current
    const belongsToRound = () =>
      activeRoundIdRef.current === snapshot.snapshotId && roundEpochRef.current === epoch
    setReplyOpen(true)
    setHelpOpen(false)
    if (threadContexts[summary.id]) return
    setReplyLoading(true)
    setError(null)
    try {
      const context = await api.thread(snapshot.snapshotId, summary.threadId, summary.id)
      if (!belongsToRound()) return
      setThreadContexts((current) => ({ ...current, [summary.id]: context }))
      setReplyDrafts((current) => ({
        ...current,
        [summary.id]: current[summary.id] ?? initialEditor(context),
      }))
      setStatus('Antwortkontext geladen.')
    } catch (cause) {
      if (!belongsToRound()) return
      setError(errorMessage(cause))
      setReplyOpen(false)
    } finally {
      if (belongsToRound()) setReplyLoading(false)
    }
  }, [snapshot, summary, threadContexts])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (submitting) return
      if (event.key === 'Escape') {
        if (settingsOpen || deleteRun) return
        if (helpOpen) setHelpOpen(false)
        else if (replyOpen) closeReply()
        else if (overviewOpen) setOverviewOpen(false)
        else if (view === 'confirm' && !snapshot?.finalization.selectionLocked) setView('review')
        return
      }
      if (settingsOpen || deleteRun || helpOpen || replyOpen || overviewOpen) return
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
    deleteRun,
    helpOpen,
    closeReply,
    next,
    openReply,
    overviewOpen,
    previous,
    replyLoading,
    replyOpen,
    settingsOpen,
    snapshot?.finalization.selectionLocked,
    submitting,
    toggleCurrent,
    toggleSecondaryAction,
    view,
  ])

  function updateEditor(patch: Partial<ReplyEditorState>) {
    if (!summary || !editor) return
    if ('bodyText' in patch)
      replyBodyEditsRef.current.set(
        summary.id,
        (replyBodyEditsRef.current.get(summary.id) ?? 0) + 1,
      )
    setReplyDrafts((current) =>
      current[summary.id]
        ? {
            ...current,
            [summary.id]: patchReplyEditor(current[summary.id], patch),
          }
        : current,
    )
  }

  async function generateReply() {
    if (!snapshot || !summary || !editor) return
    const bodyEditRevision = replyBodyEditsRef.current.get(summary.id) ?? 0
    const epoch = roundEpochRef.current
    const belongsToRound = () =>
      activeRoundIdRef.current === snapshot.snapshotId && roundEpochRef.current === epoch
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
      if (!belongsToRound()) return
      if ((replyBodyEditsRef.current.get(summary.id) ?? 0) !== bodyEditRevision) {
        setStatus('Vorschlag verworfen, weil der Antworttext zwischenzeitlich geändert wurde.')
        return
      }
      setReplyProposals((current) => ({ ...current, [summary.id]: nextProposal }))
      setReplyDrafts((current) =>
        current[summary.id]
          ? {
              ...current,
              [summary.id]: applyReplyProposal(current[summary.id], editor, nextProposal.bodyText),
            }
          : current,
      )
      setStatus('Antwortentwurf erstellt. Bitte prüfen und bearbeiten.')
    } catch (cause) {
      if (belongsToRound()) setError(errorMessage(cause))
    } finally {
      if (belongsToRound()) setReplyLoading(false)
    }
  }

  async function saveDraft() {
    if (!snapshot || !summary || !editor) return
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
      const draftPayload = {
        bodyText: editor.bodyText,
        cc,
        emailId: summary.id,
        identityId: editor.identityId,
        subject: editor.subject,
        to,
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
    if (!snapshot || pendingDetails.size > 0) return
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
    if (creatingRunRef.current) return
    creatingRunRef.current = true
    setCreatingRun(true)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const optimistic: ReviewRunSummary = {
      analysis: {
        callCount: 0,
        engine: options?.mode === 'demo' ? 'heuristic' : 'codex',
        model: codexSettings?.model ?? options?.codex.model,
        phase: 'queued',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
        thinkingLevel: codexSettings?.thinkingLevel ?? options?.codex.thinkingLevel,
        totalEmailCount: 0,
      },
      createdAt: now,
      csrfToken: '',
      emailCount: 0,
      filters,
      generation: 0,
      id,
      mode: options?.mode ?? 'live',
      reanalyzable: false,
      reviewStatus: 'active',
      status: 'queued',
      updatedAt: now,
    }
    setRuns((current) => replaceRun(current, optimistic))
    setRunActionIds((current) => new Set(current).add(id))
    setError(null)
    window.requestAnimationFrame(() => {
      document.getElementById(`run-${id}`)?.scrollIntoView({ block: 'center' })
    })
    try {
      const created = await api.createReview(id, filters)
      setRuns((current) => replaceRun(current, created))
    } catch (cause) {
      const message = errorMessage(cause)
      const recovered = await api
        .reviewRuns()
        .then((response) => {
          setRuns(response.runs)
          return response.runs.some((run) => run.id === id)
        })
        .catch(() => null)
      if (recovered === false) {
        setRuns((current) => current.filter((run) => run.id !== id))
        setError(message)
      } else if (recovered === null) {
        setRuns((current) =>
          current.map((run) =>
            run.id === id
              ? {
                  ...run,
                  analysis: {
                    ...run.analysis,
                    error: 'Verbindung unterbrochen. Der Rundenstatus wird erneut abgeglichen.',
                  },
                }
              : run,
          ),
        )
        setError(`${message} Der Rundenstatus wird automatisch erneut abgeglichen.`)
      }
    } finally {
      creatingRunRef.current = false
      setCreatingRun(false)
      setRunActionIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  async function showSetup() {
    if (snapshot && restoredRef.current && !(await flushState())) return
    if (snapshot) saveCheckpoint({ version: 7, roundId: snapshot.snapshotId })
    restoredRef.current = false
    activeRoundIdRef.current = null
    activeSnapshotRef.current = null
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
      const [nextOptions] = await Promise.all([api.options(), refreshRuns()])
      setOptions(nextOptions)
      setCodexSettings(nextOptions.codex)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function deleteReview(run: ReviewRunSummary) {
    if (!run.csrfToken) return
    setDeleteRun(null)
    setRunActionIds((current) => new Set(current).add(run.id))
    setDeletingRunIds((current) => new Set(current).add(run.id))
    setError(null)
    try {
      await api.deleteReview(run)
      setRuns((current) => current.filter((item) => item.id !== run.id))
      if (legacyMigrationRef.current?.migrationRoundId === run.id) {
        setMigrationRoundId(null)
      }
      try {
        const checkpoint = loadCheckpoint()
        if (checkpoint?.version === 7 && checkpoint.roundId === run.id) clearCheckpoint()
      } catch {
        // An invalid legacy checkpoint is intentionally retained for visible startup recovery.
      }
    } catch (cause) {
      setError(errorMessage(cause))
      await refreshRuns().catch(() => undefined)
    } finally {
      setRunActionIds((current) => {
        const next = new Set(current)
        next.delete(run.id)
        return next
      })
      setDeletingRunIds((current) => {
        const next = new Set(current)
        next.delete(run.id)
        return next
      })
    }
  }

  async function reanalyzeReview(run: ReviewRunSummary) {
    setRunActionIds((current) => new Set(current).add(run.id))
    setError(null)
    try {
      const nextRun = await api.reanalyzeReview(run)
      setRuns((current) => replaceRun(current, nextRun))
      if (legacyMigrationRef.current?.migrationRoundId === run.id) setMigrationRoundId(run.id)
    } catch (cause) {
      setError(errorMessage(cause))
      await refreshRuns().catch(() => undefined)
    } finally {
      setRunActionIds((current) => {
        const next = new Set(current)
        next.delete(run.id)
        return next
      })
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

  async function changeCodexSettings(model: CodexModelId, thinkingLevel: CodexThinkingLevel) {
    setCodexSettingsBusy(true)
    setSettingsError(null)
    try {
      const codex = await api.updateCodexSettings(model, thinkingLevel)
      setCodexSettings(codex)
      setOptions((current) => (current ? { ...current, codex } : current))
      setStatus('Codex-Einstellungen gespeichert.')
    } catch (cause) {
      setSettingsError(errorMessage(cause))
    } finally {
      setCodexSettingsBusy(false)
    }
  }

  const settingsDialog =
    settingsOpen && codexSettings ? (
      <SettingsDialog
        authBusy={codexLoginBusy}
        authConfigured={codexSettings.configured}
        error={settingsError}
        login={codexLogin}
        model={codexSettings.model}
        onClose={() => setSettingsOpen(false)}
        onSave={(model, thinkingLevel) => void changeCodexSettings(model, thinkingLevel)}
        onStartLogin={() => void startCodexLogin()}
        saveBusy={codexSettingsBusy}
        settingsEditable={options?.mode !== 'demo'}
        thinkingLevel={codexSettings.thinkingLevel ?? 'high'}
      />
    ) : null

  const setupPage = (
    <>
      <ReviewSetup
        actionIds={runActionIds}
        deletingIds={deletingRunIds}
        deleteRun={deleteRun}
        error={error ?? runStatusError}
        filters={filters}
        options={options}
        runs={runs}
        creatingRun={creatingRun}
        onCancelDelete={() => setDeleteRun(null)}
        onChange={setFilters}
        onConfirmDelete={(run) => void deleteReview(run)}
        onDelete={setDeleteRun}
        onOpen={(run) => void openReview(run.id)}
        onReanalyze={(run) => void reanalyzeReview(run)}
        onSettings={() => {
          setSettingsError(null)
          setSettingsOpen(true)
        }}
        onStart={() => void startNewReview()}
      />
      {settingsDialog}
    </>
  )

  if (loading) {
    return (
      <main className="state-page" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <h1>Inbox Walk</h1>
        <p>{status || 'Ungelesene Nachrichten werden geladen …'}</p>
      </main>
    )
  }

  if (error && !options && !snapshot && runs.length === 0) {
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
    return setupPage
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
    return setupPage
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
          Zur Rundenübersicht
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
            disabled={submitting || pendingDetails.size > 0}
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
          aria-label={`Nachrichtenübersicht öffnen · Inbox Walk v${__APP_VERSION__}`}
        >
          <span className="brand-name">
            <span>Inbox Walk</span>
            <span className="app-version">v{__APP_VERSION__}</span>
          </span>
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
          <button type="button" className="text-button" onClick={() => void showSetup()}>
            Runden
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
          <button
            type="button"
            className="control-button next"
            onClick={next}
            disabled={Boolean(summary && !details[summary.id] && !failedDetails.has(summary.id))}
          >
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
          onDiscard={() => void showSetup()}
        />
      )}
      {helpOpen && <HelpDialog isSpamReview={isSpamReview} onClose={() => setHelpOpen(false)} />}
      {settingsDialog}
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

function runStatus(run: ReviewRunSummary) {
  if (run.status === 'queued') return 'Wartet'
  if (run.status === 'fetching') return 'Postfach wird geladen'
  if (run.status === 'analyzing') return 'Wird analysiert'
  if (run.status === 'ready') {
    if (run.reviewStatus === 'finalizing') return 'Wird abgeschlossen'
    return run.reviewStatus === 'finalized' ? 'Abgeschlossen' : 'Bereit'
  }
  return 'Fehlgeschlagen'
}

function runProgressText(run: ReviewRunSummary) {
  if (run.status === 'ready') {
    return `${run.emailCount} ${run.emailCount === 1 ? 'Nachricht' : 'Nachrichten'} analysiert`
  }
  if (run.status === 'failed') return 'Analyse nicht abgeschlossen'
  if (run.status === 'queued') return 'Runde wird angelegt'
  if (run.status === 'fetching') {
    return run.analysis.totalEmailCount > 0
      ? `${run.analysis.processedEmailCount} von ${run.analysis.totalEmailCount} Nachrichten geladen`
      : 'Nachrichten werden von Fastmail geladen'
  }
  const phase = analysisStatus(run.analysis).replace(/ …$/, '')
  const progress =
    run.analysis.phase === 'deciding' && run.analysis.totalEmailCount > 0
      ? `${phase} · ${run.analysis.totalEmailCount} Nachrichten`
      : run.analysis.totalEmailCount > 0
        ? `${phase} · ${run.analysis.processedEmailCount} von ${run.analysis.totalEmailCount}`
        : phase
  if (run.analysis.callCount === 0) return progress
  return `${progress} · ${run.analysis.callCount} ${run.analysis.callCount === 1 ? 'Codex-Aufruf' : 'Codex-Aufrufe'}`
}

function runScope(run: ReviewRunSummary, options: ReviewOptions | null) {
  const mailbox = options?.mailboxes.find((item) => item.id === run.filters.mailboxId)?.name
  const scope = run.filters.spam === 'only' ? 'Spam' : (mailbox ?? 'Ungelesene Nachrichten')
  const range =
    run.filters.timeRange === 'all'
      ? 'alle Zeiträume'
      : run.filters.timeRange === '24h'
        ? '24 Stunden'
        : run.filters.timeRange === '7d'
          ? '7 Tage'
          : '30 Tage'
  return `${scope} · ${range}`
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17">
      <path
        d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function DeleteRunDialog({
  run,
  onCancel,
  onConfirm,
}: {
  run: ReviewRunSummary
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  const active = ['queued', 'fetching', 'analyzing'].includes(run.status)
  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="dialog delete-run-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-run-title"
        aria-describedby="delete-run-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
        tabIndex={-1}
      >
        <h2 id="delete-run-title">Runde löschen?</h2>
        <p id="delete-run-description">
          {active
            ? 'Die laufende Verarbeitung wird abgebrochen. Danach wird die Runde dauerhaft gelöscht.'
            : 'Die Runde und ihr gespeichertes Analyseergebnis werden dauerhaft gelöscht.'}
        </p>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={onCancel}>
            Abbrechen
          </button>
          <button type="button" className="button danger" onClick={onConfirm}>
            Runde löschen
          </button>
        </div>
      </section>
    </div>
  )
}

function ReviewSetup({
  actionIds,
  creatingRun,
  deletingIds,
  deleteRun,
  error,
  filters,
  options,
  runs,
  onCancelDelete,
  onChange,
  onConfirmDelete,
  onDelete,
  onOpen,
  onReanalyze,
  onSettings,
  onStart,
}: {
  actionIds: ReadonlySet<string>
  creatingRun: boolean
  deletingIds: ReadonlySet<string>
  deleteRun: ReviewRunSummary | null
  error: string | null
  filters: ReviewFilters
  options: ReviewOptions | null
  runs: ReviewRunSummary[]
  onCancelDelete: () => void
  onChange: (filters: ReviewFilters) => void
  onConfirmDelete: (run: ReviewRunSummary) => void
  onDelete: (run: ReviewRunSummary) => void
  onOpen: (run: ReviewRunSummary) => void
  onReanalyze: (run: ReviewRunSummary) => void
  onSettings: () => void
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
    <>
      <main className="setup-page">
        <header className="setup-header">
          <h1 className="setup-brand" aria-label={`Inbox Walk v${__APP_VERSION__}`}>
            <span>Inbox Walk</span>
            <span className="app-version">v{__APP_VERSION__}</span>
          </h1>
          <button type="button" className="button secondary" onClick={onSettings}>
            Einstellungen
          </button>
        </header>

        <section className="runs-section" aria-labelledby="runs-title">
          <div className="runs-heading">
            <h2 id="runs-title">Runden</h2>
            <p>Eine Runde lässt sich öffnen, sobald Codex alle Nachrichten analysiert hat.</p>
          </div>
          {runs.length === 0 ? (
            <p className="runs-empty">Noch keine Runde. Lege unten die erste an.</p>
          ) : (
            <div className="runs-table-wrap">
              <table className="runs-table">
                <thead>
                  <tr>
                    <th scope="col">Runde</th>
                    <th scope="col">Status</th>
                    <th scope="col">Fortschritt</th>
                    <th scope="col">Erstellt</th>
                    <th scope="col">
                      <span className="sr-only">Aktionen</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const busy = actionIds.has(run.id)
                    const deleting = deletingIds.has(run.id)
                    const deletionBlocked = run.reviewStatus === 'finalizing'
                    const percent =
                      run.status === 'ready'
                        ? 100
                        : Math.min(100, Math.round(run.analysis.progress * 100))
                    return (
                      <tr
                        key={run.id}
                        id={`run-${run.id}`}
                        data-status={run.status}
                        aria-busy={busy}
                      >
                        <td data-label="Runde">
                          <strong>Runde {run.id.slice(0, 8)}</strong>
                          <small>{runScope(run, options)}</small>
                        </td>
                        <td data-label="Status">
                          <span
                            className={`run-status ${run.status}`}
                            role="status"
                            aria-live="polite"
                            aria-atomic="true"
                          >
                            {deleting ? 'Wird gelöscht' : runStatus(run)}
                          </span>
                          {run.analysis.error && (
                            <small className="run-error">{run.analysis.error}</small>
                          )}
                        </td>
                        <td data-label="Fortschritt">
                          <div
                            className="run-progress"
                            role="progressbar"
                            aria-label={`Fortschritt der Runde ${run.id.slice(0, 8)}`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                            aria-valuetext={runProgressText(run)}
                          >
                            <span style={{ width: `${percent}%` }} />
                          </div>
                          <small>
                            {deleting ? 'Verarbeitung wird abgebrochen' : runProgressText(run)}
                          </small>
                        </td>
                        <td data-label="Erstellt">
                          <time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
                        </td>
                        <td className="run-actions">
                          <button
                            type="button"
                            className="button secondary run-open"
                            disabled={run.status !== 'ready' || busy}
                            onClick={() => onOpen(run)}
                          >
                            Runde öffnen
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            disabled={!run.csrfToken || !run.reanalyzable || busy}
                            onClick={() => onReanalyze(run)}
                          >
                            Mit Codex neu analysieren
                          </button>
                          <button
                            type="button"
                            className="icon-button run-delete"
                            disabled={!run.csrfToken || busy || deletionBlocked}
                            onClick={() => onDelete(run)}
                            aria-label={`Runde ${run.id.slice(0, 8)} löschen`}
                            title={
                              deletionBlocked
                                ? 'Die Runde wird gerade abgeschlossen'
                                : 'Runde löschen'
                            }
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <form
          className="setup-form"
          onSubmit={(event) => {
            event.preventDefault()
            onStart()
          }}
        >
          <h2 className="new-run-title">Neue Runde</h2>
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
            <p>Beim Start wird sofort eine gespeicherte Runde angelegt.</p>
            <button type="submit" className="button primary" disabled={creatingRun}>
              {creatingRun ? 'Runde wird angelegt …' : 'Runde starten'}
            </button>
          </footer>
        </form>
      </main>
      {deleteRun && (
        <DeleteRunDialog
          run={deleteRun}
          onCancel={onCancelDelete}
          onConfirm={() => onConfirmDelete(deleteRun)}
        />
      )}
    </>
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
            Zur Rundenübersicht
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

const thinkingLevelOptions: Array<{
  label: string
  value: CodexThinkingLevel
}> = [
  { label: 'Aus', value: 'off' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'Niedrig', value: 'low' },
  { label: 'Mittel', value: 'medium' },
  { label: 'Hoch', value: 'high' },
  { label: 'Sehr hoch', value: 'xhigh' },
  { label: 'Maximum', value: 'max' },
]

function SettingsDialog({
  authBusy,
  authConfigured,
  error,
  login,
  model,
  onClose,
  onSave,
  onStartLogin,
  saveBusy,
  settingsEditable,
  thinkingLevel,
}: {
  authBusy: boolean
  authConfigured: boolean
  error: string | null
  login: CodexLoginState | null
  model: CodexModelId
  onClose: () => void
  onSave: (model: CodexModelId, thinkingLevel: CodexThinkingLevel) => void
  onStartLogin: () => void
  saveBusy: boolean
  settingsEditable: boolean
  thinkingLevel: CodexThinkingLevel
}) {
  const dialogRef = useFocusRegion<HTMLElement>(true)
  const [selectedModel, setSelectedModel] = useState<CodexModelId>(model)
  const [selectedThinkingLevel, setSelectedThinkingLevel] =
    useState<CodexThinkingLevel>(thinkingLevel)
  const waiting = login?.status === 'starting' || login?.status === 'waiting'
  useEffect(() => setSelectedModel(model), [model])
  useEffect(() => setSelectedThinkingLevel(thinkingLevel), [thinkingLevel])
  const unchanged = selectedModel === model && selectedThinkingLevel === thinkingLevel
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
                Codex analysiert alle gespeicherten Zusammenfassungen einer neuen Runde gemeinsam
                und ordnet jede Nachricht einer Story oder der Einzelansicht zu. Modell und
                Denkaufwand gelten für neue Analysen und Antwortentwürfe.
              </p>
            </div>
            <span className={`connection-state ${authConfigured ? 'connected' : ''}`}>
              {authConfigured ? 'Verbunden' : 'Nicht verbunden'}
            </span>
          </div>
          <div className="settings-fields">
            <label>
              Modell
              <select
                value={selectedModel}
                disabled={saveBusy || !settingsEditable}
                onChange={(event) => setSelectedModel(event.target.value as CodexModelId)}
              >
                {codexModels.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small>
                {codexModels.find((option) => option.id === selectedModel)?.description}
              </small>
            </label>
            <label>
              Denkaufwand
              <select
                value={selectedThinkingLevel}
                disabled={saveBusy || !settingsEditable}
                onChange={(event) =>
                  setSelectedThinkingLevel(event.target.value as CodexThinkingLevel)
                }
              >
                {thinkingLevelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small>Mehr Denkaufwand kann gründlicher sein, braucht aber länger.</small>
            </label>
          </div>
          {!settingsEditable && (
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
          {settingsEditable && !waiting && (
            <button
              type="button"
              className="text-button settings-login"
              disabled={authBusy}
              onClick={onStartLogin}
            >
              {authConfigured ? 'Codex neu verbinden' : 'Mit ChatGPT verbinden'}
            </button>
          )}
        </section>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={onClose}>
            Schließen
          </button>
          <button
            type="button"
            className="button primary"
            disabled={saveBusy || unchanged || !settingsEditable}
            onClick={() => onSave(selectedModel, selectedThinkingLevel)}
          >
            {saveBusy ? 'Wird gespeichert …' : 'Speichern'}
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
