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
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.emailIds) ||
      !Array.isArray(value.keptUnreadIds) ||
      !value.filters ||
      typeof value.index !== 'number'
    ) {
      localStorage.removeItem(KEY)
      return null
    }
    return {
      version: 2,
      emailIds: value.emailIds.filter((id): id is string => typeof id === 'string').slice(0, 250),
      filters: value.filters as ReviewFilters,
      index: Math.max(0, Math.floor(value.index)),
      keptUnreadIds: value.keptUnreadIds.filter((id): id is string => typeof id === 'string'),
      unsubscribeIds: Array.isArray(value.unsubscribeIds)
        ? value.unsubscribeIds.filter((id): id is string => typeof id === 'string')
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
