import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReviewEmailSummary } from '../src/shared.ts'
import { createTriageStore, TriageStoreError } from './triage-store.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function summary(id: string, receivedAt = '2026-09-01T10:00:00.000Z'): ReviewEmailSummary {
  return {
    from: [{ email: 'shop@example.test', name: 'Shop' }],
    hasAttachment: false,
    id,
    isNewsletter: false,
    mailboxNames: ['Inbox'],
    preview: `Preview ${id}`,
    receivedAt,
    subject: `Subject ${id}`,
    threadId: `thread-${id}`,
    to: [{ email: 'me@example.test', name: 'Me' }],
  }
}

const metadata = {
  currentState: 'Unterwegs',
  kind: 'order_delivery' as const,
  linkEvidence: ['Bestellung 123'],
  summary: 'Eine Bestellung.',
  title: 'Bestellung 123: unterwegs',
}

describe('triage store', () => {
  it('queues new mail once and lists it as unsorted until a bucket claims it', () => {
    const store = createTriageStore(':memory:')
    expect(store.enqueue([summary('a'), summary('b')])).toBe(2)
    expect(store.enqueue([summary('a')])).toBe(0)
    expect(store.queued(10, 3).map((item) => item.summary.id)).toEqual(['a', 'b'])
    expect(store.todo().map((bucket) => [bucket.unsorted, bucket.messages.length])).toEqual([
      [true, 1],
      [true, 1],
    ])

    const bucketId = store.createBucket(metadata, ['a', 'b'])
    expect(store.queued(10, 3)).toEqual([])
    const todo = store.todo()
    expect(todo).toHaveLength(1)
    expect(todo[0]).toMatchObject({
      bucketId,
      messages: [{ status: 'sorted' }, { status: 'sorted' }],
      title: metadata.title,
      unsorted: false,
    })
    store.close()
  })

  it('closes a bucket when its last open member is done and reopens it on new mail', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a')])
    const bucketId = store.createBucket(metadata, ['a'])
    store.markDone(['a'])
    expect(store.todo()).toEqual([])
    expect(store.bucket(bucketId)).toMatchObject({ open: false })
    expect(store.trackedIds().size).toBe(0)

    store.enqueue([summary('b')])
    store.addToBucket(bucketId, ['b'], { currentState: 'Zugestellt' })
    expect(store.todo()[0]).toMatchObject({
      bucketId,
      currentState: 'Zugestellt',
      handledCount: 1,
      messages: [{ summary: { id: 'b' } }],
    })
    store.close()
  })

  it('parks and unparks without touching other members', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a'), summary('b')])
    const bucketId = store.createBucket(metadata, ['a', 'b'])
    store.park(['a'])
    expect(store.parked().map((item) => item.summary.id)).toEqual(['a'])
    expect(store.todo()[0]?.messages.map((item) => item.summary.id)).toEqual(['b'])
    expect(store.todo()[0]?.handledCount).toBe(0)
    expect(store.trackedIds().get('a')).toBe('parked')
    store.unpark(['a'])
    expect(store.parked()).toEqual([])
    expect(store.todo()[0]?.messages.map((item) => item.summary.id)).toEqual(['a', 'b'])
    expect(store.bucket(bucketId)?.open).toBe(true)
    store.close()
  })

  it('rejects unknown, handled and malformed bucket assignments', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a')])
    expect(() => store.createBucket(metadata, ['ghost'])).toThrow(TriageStoreError)
    expect(() => store.createBucket({ ...metadata, title: '  ' }, ['a'])).toThrow(
      'must not be empty',
    )
    expect(() => store.createBucket({ ...metadata, kind: 'weird' as never }, ['a'])).toThrow(
      'kind is invalid',
    )
    expect(() => store.addToBucket('missing', ['a'])).toThrow('Unknown bucket')
    store.markDone(['a'])
    expect(() => store.createBucket(metadata, ['a'])).toThrow('cannot be sorted')
    store.close()
  })

  it('counts attempts and stops automatic retries at the limit', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a')])
    store.recordAttempt(['a'], 'Codex war nicht erreichbar.')
    store.recordAttempt(['a'], 'Codex war nicht erreichbar.')
    expect(store.queued(10, 3)).toHaveLength(1)
    store.recordAttempt(['a'], 'Codex war nicht erreichbar.')
    expect(store.queued(10, 3)).toEqual([])
    expect(store.queueCounts(3)).toEqual({ failed: 1, queued: 0 })
    expect(store.todo()[0]?.messages[0]).toMatchObject({
      attempts: 3,
      lastError: 'Codex war nicht erreichbar.',
    })
    store.resetAttempts(['a'])
    expect(store.queued(10, 3)).toHaveLength(1)
    store.close()
  })

  it('does not re-queue a message that was just marked done', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a')])
    store.markDone(['a'])
    expect(store.enqueue([summary('a')])).toBe(0)
    expect(store.trackedIds().size).toBe(0)
    store.close()
  })

  it('merges buckets and moves every member', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a'), summary('b')])
    const first = store.createBucket(metadata, ['a'])
    const second = store.createBucket({ ...metadata, title: 'Zweiter' }, ['b'])
    store.mergeBuckets(first, second)
    expect(store.bucket(first)?.open).toBe(false)
    expect(store.bucket(second)?.members.map((item) => item.summary.id)).toEqual(['a', 'b'])
    expect(() => store.mergeBuckets(second, second)).toThrow(TriageStoreError)
    store.close()
  })

  it('keeps memory notes, accepts proposals and bounds their length', () => {
    const store = createTriageStore(':memory:')
    expect(store.memory()).toEqual({ notes: '', proposals: [] })
    store.setMemoryNotes('Bahn-Buchungen gehören zur Reise.')
    store.addProposal('  Amazon-Retouren zur Bestellung.  ')
    store.addProposal('')
    const { proposals } = store.memory()
    expect(proposals).toHaveLength(1)
    const accepted = store.acceptProposal(proposals[0]?.id ?? '')
    expect(accepted?.notes).toBe(
      'Bahn-Buchungen gehören zur Reise.\nAmazon-Retouren zur Bestellung.',
    )
    expect(accepted?.proposals).toEqual([])
    expect(store.acceptProposal('missing')).toBeNull()
    expect(store.setMemoryNotes('x'.repeat(20_000)).notes).toHaveLength(8_000)
    store.close()
  })

  it('persists across reopening and replaces the old round tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-triage-'))
    directories.push(directory)
    const path = join(directory, 'inbox-walk.sqlite')
    const first = createTriageStore(path)
    first.enqueue([summary('a')])
    const bucketId = first.createBucket(metadata, ['a'])
    first.saveReplyEditor('a', {
      bodyText: 'Hallo',
      cc: [],
      identityId: 'id',
      revisionInstruction: '',
      roughNotes: 'Notiz',
      subject: 'Re',
      to: [],
    })
    const tokens = first.tokens()
    first.close()

    const second = createTriageStore(path)
    expect(second.tokens()).toEqual(tokens)
    expect(second.todo()[0]?.bucketId).toBe(bucketId)
    expect(second.replyEditor('a')?.roughNotes).toBe('Notiz')
    expect(second.replyEditor('missing')).toBeNull()
    second.close()
  })

  it('prunes handled messages after the retention window and empty closed buckets', () => {
    const store = createTriageStore(':memory:')
    store.enqueue([summary('a')])
    const bucketId = store.createBucket(metadata, ['a'])
    store.markDone(['a'])
    store.prune(Date.now())
    expect(store.bucket(bucketId)?.members).toHaveLength(1)
    store.prune(Date.now() + 61 * 24 * 60 * 60 * 1000)
    expect(store.bucket(bucketId)).toBeNull()
    expect(store.message('a')).toBeNull()
    store.close()
  })
})
