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
      (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) ||
      !Array.isArray(value.emailIds) ||
      !Array.isArray(value.keptUnreadIds) ||
      !value.filters ||
      typeof value.index !== 'number'
    ) {
      localStorage.removeItem(KEY)
      return null
    }
    return {
      version: 4,
      emailIds: value.emailIds.filter((id): id is string => typeof id === 'string').slice(0, 250),
      filters: {
        ...(value.filters as Omit<ReviewFilters, 'spam'>),
        spam:
          (value.filters as Partial<ReviewFilters>).spam === 'only' ? 'only' : ('exclude' as const),
      },
      index: Math.max(0, Math.floor(value.index)),
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
