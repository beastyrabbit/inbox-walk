// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint.ts'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

beforeEach(() => storage.clear())

describe('local review checkpoint', () => {
  it('stores IDs and decisions without message bodies', () => {
    saveCheckpoint({
      version: 3,
      emailIds: ['mail-1'],
      filters: { mailboxId: null, newsletter: 'all', timeRange: '7d' },
      index: 0,
      keptUnreadIds: ['mail-1'],
      processedIds: ['mail-1'],
      unsubscribeIds: [],
      replyDrafts: {},
    })
    expect(loadCheckpoint()).toMatchObject({
      emailIds: ['mail-1'],
      keptUnreadIds: ['mail-1'],
      processedIds: ['mail-1'],
    })
    expect(JSON.stringify(localStorage)).not.toContain('message body')
  })

  it('removes invalid and explicitly cleared checkpoints', () => {
    localStorage.setItem('inbox-walk:checkpoint:v1', '{"version":2}')
    expect(loadCheckpoint()).toBeNull()
    saveCheckpoint({
      version: 3,
      emailIds: [],
      filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' },
      index: 0,
      keptUnreadIds: [],
      processedIds: [],
      unsubscribeIds: [],
      replyDrafts: {},
    })
    clearCheckpoint()
    expect(loadCheckpoint()).toBeNull()
  })

  it('reports storage quota failures without throwing', () => {
    vi.spyOn(storage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    expect(
      saveCheckpoint({
        version: 3,
        emailIds: ['mail-1'],
        filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' },
        index: 0,
        keptUnreadIds: [],
        processedIds: [],
        unsubscribeIds: [],
        replyDrafts: {},
      }),
    ).toBe(false)
  })

  it('migrates old checkpoints without assuming messages were processed', () => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        version: 2,
        emailIds: ['mail-1'],
        filters: { mailboxId: null, newsletter: 'all', timeRange: 'all' },
        index: 1,
        keptUnreadIds: [],
        unsubscribeIds: [],
        replyDrafts: {},
      }),
    )
    expect(loadCheckpoint()).toMatchObject({ version: 3, processedIds: [] })
  })
})
