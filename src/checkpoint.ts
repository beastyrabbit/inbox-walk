import type {
  LegacyReviewCheckpoint,
  LoadedReviewCheckpoint,
  ReplyEditorState,
  ReviewCheckpoint,
  ReviewFilters,
} from './shared.ts'

const KEY = 'inbox-walk:checkpoint:v1'
let volatileLegacyCheckpoint: LegacyReviewCheckpoint | null = null

export function loadCheckpoint(): LoadedReviewCheckpoint | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return volatileLegacyCheckpoint
    const value = JSON.parse(raw) as Record<string, unknown> & { version?: number }
    if (value.version === 7 && typeof value.roundId === 'string' && value.roundId.length > 0) {
      volatileLegacyCheckpoint = null
      return { version: 7, roundId: value.roundId }
    }
    // Legacy checkpoints contain message IDs and, in some versions, full draft text.
    // Keep the parsed value in memory just long enough to migrate it, but remove the
    // durable browser copy immediately. A successful migration writes back only v7.
    localStorage.removeItem(KEY)
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
      return null
    }
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
        ...(value.filters as Omit<ReviewFilters, 'hideReviewed' | 'spam'>),
        hideReviewed: (value.filters as Partial<ReviewFilters>).hideReviewed === true,
        spam:
          (value.filters as Partial<ReviewFilters>).spam === 'only' ? 'only' : ('exclude' as const),
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
      replyDrafts: (value.replyDrafts ?? {}) as Record<string, ReplyEditorState>,
    } satisfies LegacyReviewCheckpoint
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
