import { describe, expect, it } from 'vitest'
import { clampIndex, idsToMarkRead, toggleKeptUnread } from './review-state.ts'

describe('review decisions', () => {
  it('keeps protected messages out of the final read set', () => {
    expect(idsToMarkRead(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c'])
  })

  it('toggles a protected message without mutating the original set', () => {
    const original = new Set(['a'])
    const added = toggleKeptUnread(original, 'b')
    const removed = toggleKeptUnread(added, 'a')
    expect([...original]).toEqual(['a'])
    expect([...added]).toEqual(['a', 'b'])
    expect([...removed]).toEqual(['b'])
  })

  it('keeps navigation inside the snapshot', () => {
    expect(clampIndex(-2, 3)).toBe(0)
    expect(clampIndex(9, 3)).toBe(2)
    expect(clampIndex(2, 0)).toBe(0)
  })
})
