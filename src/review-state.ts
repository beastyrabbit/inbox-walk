export function toggleKeptUnread(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function idsToMarkRead(allIds: readonly string[], keptUnread: ReadonlySet<string>) {
  return allIds.filter((id) => !keptUnread.has(id))
}

export function clampIndex(index: number, count: number) {
  if (count <= 0) return 0
  return Math.max(0, Math.min(index, count - 1))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  )
}

export function stableReviewStateJson(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}
