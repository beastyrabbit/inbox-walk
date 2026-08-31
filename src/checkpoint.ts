import type {
  LegacyReviewCheckpoint,
  LoadedReviewCheckpoint,
  MailAddress,
  ReplyEditorState,
  ReviewCheckpoint,
} from './shared.ts'

const KEY = 'inbox-walk:checkpoint:v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let volatileLegacyCheckpoint: LegacyReviewCheckpoint | null = null

export class CheckpointLoadError extends Error {
  constructor(
    message = 'Der gespeicherte alte Rundenstand ist ungültig und wurde nicht gelöscht.',
  ) {
    super(message)
    this.name = 'CheckpointLoadError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanIds(value: unknown, optional = false): string[] | null {
  if (value === undefined && optional) return []
  if (!Array.isArray(value)) return null
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return null
  return ids
}

function cleanAddresses(value: unknown): MailAddress[] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const addresses = value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const address = candidate as Record<string, unknown>
    if (
      (address.name !== null && typeof address.name !== 'string') ||
      (typeof address.name === 'string' && address.name.length > 320) ||
      typeof address.email !== 'string' ||
      address.email.length > 320
    ) {
      return []
    }
    return [{ name: address.name ?? '', email: address.email }]
  })
  return addresses.length === value.length ? addresses : null
}

function cleanReplyDrafts(value: unknown): Record<string, ReplyEditorState> | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const entries: Array<[string, ReplyEditorState]> = []
  for (const [emailId, candidate] of Object.entries(value)) {
    if (!emailId || !isRecord(candidate)) return null
    const draft = candidate as Record<string, unknown>
    const cc = cleanAddresses(draft.cc)
    const to = cleanAddresses(draft.to)
    if (
      typeof draft.bodyText !== 'string' ||
      draft.bodyText.length > 256_000 ||
      !cc ||
      typeof draft.identityId !== 'string' ||
      draft.identityId.length > 512 ||
      typeof draft.revisionInstruction !== 'string' ||
      draft.revisionInstruction.length > 64_000 ||
      typeof draft.roughNotes !== 'string' ||
      draft.roughNotes.length > 64_000 ||
      typeof draft.subject !== 'string' ||
      draft.subject.length > 998 ||
      !to
    ) {
      return null
    }
    const clean: ReplyEditorState = {
      bodyText: draft.bodyText,
      cc,
      identityId: draft.identityId,
      revisionInstruction: draft.revisionInstruction,
      roughNotes: draft.roughNotes,
      subject: draft.subject,
      to,
    }
    if (typeof draft.draftRequestId === 'string' && UUID_PATTERN.test(draft.draftRequestId)) {
      clean.draftRequestId = draft.draftRequestId
    }
    entries.push([emailId, clean])
  }
  return Object.fromEntries(entries)
}

function invalidCheckpoint(): never {
  volatileLegacyCheckpoint = null
  throw new CheckpointLoadError()
}

export function loadCheckpoint(): LoadedReviewCheckpoint | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    throw new CheckpointLoadError('Der gespeicherte alte Rundenstand konnte nicht gelesen werden.')
  }
  if (!raw) return volatileLegacyCheckpoint

  let value: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return invalidCheckpoint()
    value = parsed
  } catch (cause) {
    if (cause instanceof CheckpointLoadError) throw cause
    return invalidCheckpoint()
  }
  if (value.version === 7 && typeof value.roundId === 'string' && value.roundId.length > 0) {
    volatileLegacyCheckpoint = null
    return { version: 7, roundId: value.roundId }
  }
  if (
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5 &&
      value.version !== 6) ||
    !isRecord(value.filters) ||
    typeof value.index !== 'number' ||
    !Number.isFinite(value.index)
  ) {
    return invalidCheckpoint()
  }

  const emailIds = cleanIds(value.emailIds)
  const keptUnreadIds = cleanIds(value.keptUnreadIds)
  const processedIds = cleanIds(value.processedIds, true)
  const secondaryActionIds = cleanIds(
    value.secondaryActionIds === undefined ? value.unsubscribeIds : value.secondaryActionIds,
    true,
  )
  const replyDrafts = cleanReplyDrafts(value.replyDrafts)
  const filters = value.filters
  const validMailbox = filters.mailboxId === null || typeof filters.mailboxId === 'string'
  const validNewsletter = ['all', 'exclude', 'only'].includes(String(filters.newsletter))
  const validSpam =
    filters.spam === undefined || filters.spam === 'exclude' || filters.spam === 'only'
  const validTimeRange = ['all', '24h', '7d', '30d'].includes(String(filters.timeRange))
  if (
    !emailIds ||
    !keptUnreadIds ||
    !processedIds ||
    !secondaryActionIds ||
    !replyDrafts ||
    !validMailbox ||
    !validNewsletter ||
    !validSpam ||
    !validTimeRange
  ) {
    return invalidCheckpoint()
  }

  let bundleGroups: string[][] = []
  if (value.version === 6 && value.bundleGroups !== undefined) {
    if (!Array.isArray(value.bundleGroups)) return invalidCheckpoint()
    const groups = value.bundleGroups.map((group) => cleanIds(group))
    if (groups.some((group) => !group)) return invalidCheckpoint()
    bundleGroups = groups as string[][]
    const groupedIds = bundleGroups.flat()
    if (new Set(groupedIds).size !== groupedIds.length) return invalidCheckpoint()
  }

  const known = new Set(emailIds)
  const referencedIds = [
    ...keptUnreadIds,
    ...processedIds,
    ...secondaryActionIds,
    ...Object.keys(replyDrafts),
    ...bundleGroups.flat(),
  ]
  if (referencedIds.some((id) => !known.has(id))) return invalidCheckpoint()

  volatileLegacyCheckpoint = {
    version: 6,
    bundleGroups,
    emailIds,
    filters: {
      hideReviewed: filters.hideReviewed === true,
      mailboxId: filters.mailboxId as string | null,
      newsletter: filters.newsletter as LegacyReviewCheckpoint['filters']['newsletter'],
      spam: filters.spam === 'only' ? 'only' : 'exclude',
      timeRange: filters.timeRange as LegacyReviewCheckpoint['filters']['timeRange'],
    },
    index: value.version === 6 ? Math.max(0, Math.floor(value.index)) : 0,
    keptUnreadIds,
    processedIds,
    secondaryActionIds,
    replyDrafts,
    ...(typeof value.migrationRoundId === 'string' && UUID_PATTERN.test(value.migrationRoundId)
      ? { migrationRoundId: value.migrationRoundId }
      : {}),
  }
  // Keep only the validated migration fields until the server accepts them. Draft text
  // remains here temporarily so a failed migration cannot silently lose user work.
  try {
    localStorage.setItem(KEY, JSON.stringify(volatileLegacyCheckpoint))
  } catch {
    // The original checkpoint remains available when storage is temporarily unwritable.
  }
  return volatileLegacyCheckpoint
}

export function stageCheckpointMigration(
  checkpoint: LegacyReviewCheckpoint,
  roundId: string,
): LegacyReviewCheckpoint | null {
  if (!UUID_PATTERN.test(roundId)) return null
  const staged = { ...checkpoint, migrationRoundId: roundId }
  try {
    localStorage.setItem(KEY, JSON.stringify(staged))
    volatileLegacyCheckpoint = staged
    return staged
  } catch {
    return null
  }
}

export function saveCheckpoint(checkpoint: ReviewCheckpoint) {
  try {
    localStorage.setItem(KEY, JSON.stringify(checkpoint))
    volatileLegacyCheckpoint = null
    return true
  } catch {
    return false
  }
}

export function clearCheckpoint() {
  volatileLegacyCheckpoint = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Storage can be unavailable in hardened or quota-constrained browser contexts.
  }
}
