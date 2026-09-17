import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewEmailSummary, ReviewFilters } from '../src/shared.ts'
import { createCheckpointedBundlePartitionDecider } from './bundle-checkpoint.ts'
import type { BundlePartitionDecision, BundlePartitionInput } from './bundles.ts'
import { createRoundStore } from './round-store.ts'

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const filters: ReviewFilters = {
  hideReviewed: false,
  mailboxId: null,
  newsletter: 'all',
  spam: 'exclude',
  timeRange: 'all',
}

function email(id: string): ReviewEmailSummary {
  return {
    from: [{ email: 'notifications@example.com', name: 'Notifications' }],
    hasAttachment: false,
    id,
    isNewsletter: false,
    mailboxNames: ['Inbox'],
    preview: `Preview ${id}`,
    receivedAt: '2026-08-30T12:00:00.000Z',
    subject: `Subject ${id}`,
    threadId: `thread-${id}`,
    to: [{ email: 'me@example.com', name: 'Me' }],
  }
}

const seed = email('seed')
const candidate = email('candidate')
const partitionInput: BundlePartitionInput = { emails: [seed, candidate], examples: [] }
const partitionDecision: BundlePartitionDecision = {
  standaloneEmailIds: [],
  stories: [
    {
      currentState: 'Current',
      emailIds: ['seed', 'candidate'],
      kind: 'conversation',
      linkEvidence: ['same thread'],
      membershipConfidence: 0.95,
      summary: 'Related messages.',
      title: 'One conversation',
    },
  ],
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-bundle-checkpoint-'))
  directories.push(directory)
  return join(directory, 'inbox-walk.sqlite')
}

describe('persisted Codex bundle decisions', () => {
  it('replays a complete global partition after restart and keys it by configuration', async () => {
    const path = databasePath()
    const firstStore = createRoundStore(path)
    firstStore.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol', thinkingLevel: 'high' },
      csrfToken: 'csrf',
      emails: [seed, candidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const firstProvider = vi.fn(async () => partitionDecision)
    const first = createCheckpointedBundlePartitionDecider({
      configuration: 'gpt-5.6-sol:high:prompt-1',
      decide: firstProvider,
      initialCallCount: 0,
      onCallStarted: (callCount) => {
        firstStore.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: firstStore,
    })

    await expect(first.decide(partitionInput)).resolves.toEqual(partitionDecision)
    expect(firstProvider).toHaveBeenCalledOnce()
    firstStore.close()

    const reopened = createRoundStore(path)
    const replayProvider = vi.fn(async () => partitionDecision)
    const replay = createCheckpointedBundlePartitionDecider({
      configuration: 'gpt-5.6-sol:high:prompt-1',
      decide: replayProvider,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      onCallStarted: (callCount) => {
        reopened.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: reopened,
    })
    await expect(replay.decide(partitionInput)).resolves.toEqual(partitionDecision)
    expect(replayProvider).not.toHaveBeenCalled()

    const changedSummaryProvider = vi.fn(async () => partitionDecision)
    const changedSummary = createCheckpointedBundlePartitionDecider({
      configuration: 'gpt-5.6-sol:high:prompt-1',
      decide: changedSummaryProvider,
      initialCallCount: replay.callCount(),
      onCallStarted: (callCount) => {
        reopened.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: reopened,
    })
    await expect(
      changedSummary.decide({
        ...partitionInput,
        emails: [{ ...seed, preview: 'Changed frozen summary' }, candidate],
      }),
    ).resolves.toEqual(partitionDecision)
    expect(changedSummaryProvider).toHaveBeenCalledOnce()

    const changedProvider = vi.fn(async () => partitionDecision)
    const changed = createCheckpointedBundlePartitionDecider({
      configuration: 'gpt-5.6-sol:xhigh:prompt-1',
      decide: changedProvider,
      initialCallCount: changedSummary.callCount(),
      onCallStarted: (callCount) => {
        reopened.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: reopened,
    })
    await expect(changed.decide(partitionInput)).resolves.toEqual(partitionDecision)
    expect(changedProvider).toHaveBeenCalledOnce()
    expect(changed.callCount()).toBe(3)
    reopened.close()
  })

  it('does not persist an incomplete global partition', async () => {
    const provider = vi.fn(async () => ({ standaloneEmailIds: ['seed'], stories: [] }))
    const getBundlePartition = vi.fn(() => null)
    const saveBundlePartition = vi.fn(() => partitionDecision)
    const checkpointed = createCheckpointedBundlePartitionDecider({
      configuration: 'gpt-5.6-sol:high:prompt-1',
      decide: provider,
      initialCallCount: 0,
      onCallStarted: () => {},
      roundId: 'round',
      store: { getBundlePartition, saveBundlePartition },
    })

    await expect(checkpointed.decide(partitionInput)).rejects.toThrow('complete snapshot')
    expect(provider).toHaveBeenCalledOnce()
    expect(saveBundlePartition).not.toHaveBeenCalled()
  })

  it('rolls back a reserved global partition call when authentication fails', async () => {
    const path = databasePath()
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const authError = new Error('authentication expired')
    const checkpointed = createCheckpointedBundlePartitionDecider({
      configuration: 'gpt-5.6-sol:high:prompt-1',
      decide: vi.fn(async () => {
        throw authError
      }),
      initialCallCount: 0,
      onCallRolledBack: (callCount) => {
        store.updateAnalysis('round', { callCount })
      },
      onCallStarted: (callCount) => {
        store.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      shouldRollbackCall: (error) => error === authError,
      store,
    })

    await expect(checkpointed.decide(partitionInput)).rejects.toBe(authError)
    expect(checkpointed.callCount()).toBe(0)
    expect(store.get('round')?.analysis.callCount).toBe(0)
    store.close()
  })
})
