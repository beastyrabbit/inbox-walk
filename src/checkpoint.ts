import type { ReplyEditorState, ReviewCheckpoint, ReviewFilters } from './shared.ts'

const KEY = 'inbox-walk:checkpoint:v1'

export function loadCheckpoint(): ReviewCheckpoint | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Omit<Partial<ReviewCheckpoint>, 'version'> & {
      version?: number
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
      localStorage.removeItem(KEY)
      return null
    }
    return {
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
    }
  } catch {
    localStorage.removeItem(KEY)
    return null
  }
}

export function saveCheckpoint(checkpoint: ReviewCheckpoint) {
  try {
    localStorage.setItem(KEY, JSON.stringify(checkpoint))
    return true
  } catch {
    return false
  }
}

export function clearCheckpoint() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Storage can be unavailable in hardened or quota-constrained browser contexts.
  }
}
