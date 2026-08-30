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

function cleanAddresses(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const address = candidate as Record<string, unknown>
    if (
      typeof address.name !== 'string' ||
      address.name.length > 320 ||
      typeof address.email !== 'string' ||
      address.email.length > 320
    ) {
      return []
    }
    return [{ name: address.name, email: address.email }]
  })
}

function cleanReplyDrafts(value: unknown): Record<string, ReplyEditorState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([emailId, candidate]) => {
      if (!emailId || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return []
      }
      const draft = candidate as Record<string, unknown>
      if (
        typeof draft.bodyText !== 'string' ||
        draft.bodyText.length > 256_000 ||
        typeof draft.identityId !== 'string' ||
        draft.identityId.length > 512 ||
        typeof draft.revisionInstruction !== 'string' ||
        draft.revisionInstruction.length > 64_000 ||
        typeof draft.roughNotes !== 'string' ||
        draft.roughNotes.length > 64_000 ||
        typeof draft.subject !== 'string' ||
        draft.subject.length > 998
      ) {
        return []
      }
      const clean: ReplyEditorState = {
        bodyText: draft.bodyText,
        cc: cleanAddresses(draft.cc),
        identityId: draft.identityId,
        revisionInstruction: draft.revisionInstruction,
        roughNotes: draft.roughNotes,
        subject: draft.subject,
        to: cleanAddresses(draft.to),
      }
      if (typeof draft.draftRequestId === 'string' && UUID_PATTERN.test(draft.draftRequestId)) {
        clean.draftRequestId = draft.draftRequestId
      }
      return [[emailId, clean]]
    }),
  )
}

export function loadCheckpoint(): LoadedReviewCheckpoint | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return volatileLegacyCheckpoint
    const value = JSON.parse(raw) as Record<string, unknown> & { version?: number }
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
      !Array.isArray(value.emailIds) ||
      !Array.isArray(value.keptUnreadIds) ||
      !value.filters ||
      typeof value.index !== 'number'
    ) {
      volatileLegacyCheckpoint = null
      localStorage.removeItem(KEY)
      return null
    }
    const filters = value.filters as Record<string, unknown>
    volatileLegacyCheckpoint = {
      version: 6,
      bundleGroups: Array.isArray(value.bundleGroups)
        ? value.bundleGroups
            .filter((group) => Array.isArray(group))
            .map((group) => group.filter((id): id is string => typeof id === 'string'))
            .filter((group) => group.length > 0)
        : [],
      emailIds: value.emailIds.filter((id): id is string => typeof id === 'string'),
      filters: {
        hideReviewed: filters.hideReviewed === true,
        mailboxId: typeof filters.mailboxId === 'string' ? filters.mailboxId : null,
        newsletter:
          filters.newsletter === 'exclude' || filters.newsletter === 'only'
            ? filters.newsletter
            : 'all',
        spam: filters.spam === 'only' ? 'only' : 'exclude',
        timeRange:
          filters.timeRange === '24h' || filters.timeRange === '7d' || filters.timeRange === '30d'
            ? filters.timeRange
            : 'all',
      },
      index: value.version === 6 ? Math.max(0, Math.floor(value.index)) : 0,
      keptUnreadIds: value.keptUnreadIds.filter((id): id is string => typeof id === 'string'),
      processedIds: Array.isArray(value.processedIds)
        ? value.processedIds.filter((id): id is string => typeof id === 'string')
        : [],
      secondaryActionIds: Array.isArray(value.secondaryActionIds)
        ? value.secondaryActionIds.filter((id): id is string => typeof id === 'string')
        : Array.isArray((value as { unsubscribeIds?: unknown }).unsubscribeIds)
          ? ((value as { unsubscribeIds: unknown[] }).unsubscribeIds.filter(
              (id): id is string => typeof id === 'string',
            ) as string[])
          : [],
      replyDrafts: cleanReplyDrafts(value.replyDrafts),
    } satisfies LegacyReviewCheckpoint
    // Keep a sanitized migration record until the server has accepted the round and
    // saveCheckpoint replaces it with the opaque v7 pointer. This survives a reload
    // or a transient migration failure without retaining unknown legacy fields.
    try {
      localStorage.setItem(KEY, JSON.stringify(volatileLegacyCheckpoint))
    } catch {
      // The original checkpoint remains available when storage is temporarily unwritable.
    }
    return volatileLegacyCheckpoint
  } catch {
    volatileLegacyCheckpoint = null
    try {
      localStorage.removeItem(KEY)
    } catch {
      // Storage can be unavailable in hardened browser contexts.
    }
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
