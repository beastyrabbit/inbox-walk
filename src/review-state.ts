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
