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

beforeEach(() => {
  storage.clear()
  clearCheckpoint()
})

describe('local review checkpoint', () => {
  it('stores only the opaque round pointer', () => {
    saveCheckpoint({
      version: 7,
      roundId: 'round-123',
    })
    expect(loadCheckpoint()).toEqual({ version: 7, roundId: 'round-123' })
    expect(JSON.stringify(localStorage)).not.toContain('message body')
  })

  it('still reads a legacy checkpoint with more than 250 stable snapshot IDs', () => {
    const emailIds = Array.from({ length: 301 }, (_, index) => `mail-${index}`)
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        version: 6,
        bundleGroups: [emailIds],
        emailIds,
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        index: 0,
        keptUnreadIds: [],
        processedIds: [],
        secondaryActionIds: [],
        replyDrafts: {},
      }),
    )
    const checkpoint = loadCheckpoint()
    expect(checkpoint?.version).toBe(6)
    if (checkpoint?.version === 6) expect(checkpoint.emailIds).toEqual(emailIds)
    expect(JSON.parse(localStorage.getItem('inbox-walk:checkpoint:v1') ?? '{}')).toMatchObject({
      version: 6,
      emailIds,
    })
  })

  it('keeps a sanitized legacy checkpoint across a fresh document load', async () => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        attachmentContent: 'must-not-survive',
        version: 6,
        bundleGroups: [['mail-1']],
        emailIds: ['mail-1'],
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        index: 0,
        keptUnreadIds: [],
        processedIds: [],
        secondaryActionIds: [],
        replyDrafts: {
          'mail-1': {
            bodyText: 'Eigener Entwurf',
            cc: [],
            identityId: 'identity-1',
            injectedField: 'must-not-survive',
            revisionInstruction: '',
            roughNotes: '',
            subject: 'Re: Test',
            to: [{ email: 'partial@', name: null }],
          },
        },
      }),
    )

    const firstMount = loadCheckpoint()
    const stored = localStorage.getItem('inbox-walk:checkpoint:v1') ?? ''
    expect(stored).not.toContain('attachmentContent')
    expect(stored).not.toContain('injectedField')
    expect(stored).toContain('Eigener Entwurf')
    expect(firstMount).toMatchObject({
      replyDrafts: { 'mail-1': { to: [{ email: 'partial@', name: '' }] } },
    })

    vi.resetModules()
    const freshDocument = await import('./checkpoint.ts')
    expect(freshDocument.loadCheckpoint()).toEqual(firstMount)

    saveCheckpoint({ version: 7, roundId: 'migrated-round' })
    expect(loadCheckpoint()).toEqual({ version: 7, roundId: 'migrated-round' })
    expect(localStorage.getItem('inbox-walk:checkpoint:v1')).not.toContain('Eigener Entwurf')
  })

  it('removes invalid and explicitly cleared checkpoints', () => {
    localStorage.setItem('inbox-walk:checkpoint:v1', '{"version":2}')
    expect(loadCheckpoint()).toBeNull()
    saveCheckpoint({
      version: 7,
      roundId: 'round-123',
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
        version: 7,
        roundId: 'round-123',
      }),
    ).toBe(false)
  })

  it('keeps a volatile legacy checkpoint when writing its v7 pointer fails', () => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        version: 6,
        bundleGroups: [['mail-1']],
        emailIds: ['mail-1'],
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        index: 0,
        keptUnreadIds: ['mail-1'],
        processedIds: ['mail-1'],
        secondaryActionIds: [],
        replyDrafts: {},
      }),
    )
    const legacy = loadCheckpoint()
    vi.spyOn(storage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })

    expect(saveCheckpoint({ version: 7, roundId: 'migrated-round' })).toBe(false)
    expect(loadCheckpoint()).toEqual(legacy)
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
        unsubscribeIds: ['mail-1'],
        replyDrafts: {},
      }),
    )
    expect(loadCheckpoint()).toMatchObject({
      version: 6,
      index: 0,
      filters: { hideReviewed: false, spam: 'exclude' },
      processedIds: [],
      secondaryActionIds: ['mail-1'],
    })
    expect(JSON.parse(localStorage.getItem('inbox-walk:checkpoint:v1') ?? '{}')).toMatchObject({
      version: 6,
      secondaryActionIds: ['mail-1'],
    })
  })
})
