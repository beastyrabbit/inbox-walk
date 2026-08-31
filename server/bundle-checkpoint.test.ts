import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewEmailSummary, ReviewFilters } from '../src/shared.ts'
import {
  createCheckpointedBundleDecider,
  createCheckpointedBundlePartitionDecider,
} from './bundle-checkpoint.ts'
import type {
  BundleDecision,
  BundleDecisionCohort,
  BundleDecisionInput,
  BundlePartitionDecision,
  BundlePartitionInput,
} from './bundles.ts'
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
const input: BundleDecisionInput = { candidates: [candidate], examples: [], seed: [seed] }
const decision: BundleDecision = {
  currentState: 'Current',
  includedEmailIds: ['candidate'],
  kind: 'conversation',
  linkEvidence: ['same thread'],
  membershipConfidence: 0.95,
  summary: 'Related messages.',
  title: 'One conversation',
}
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

  it('replays completed decisions after restart without another provider call', async () => {
    const path = databasePath()
    const firstStore = createRoundStore(path)
    firstStore.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const firstProvider = vi.fn(async () => decision)
    const first = createCheckpointedBundleDecider({
      decide: firstProvider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => {
        firstStore.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: firstStore,
    })

    await expect(first.decide(input)).resolves.toEqual(decision)
    expect(firstProvider).toHaveBeenCalledOnce()
    expect(first.callCount()).toBe(1)
    firstStore.close()

    const reopened = createRoundStore(path)
    const restored = reopened.get('round')
    expect(restored?.analysis.callCount).toBe(1)
    const secondProvider = vi.fn(async () => decision)
    const second = createCheckpointedBundleDecider({
      decide: secondProvider,
      initialCallCount: restored?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => {
        reopened.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: reopened,
    })

    await expect(second.decide(input)).resolves.toEqual(decision)
    expect(secondProvider).not.toHaveBeenCalled()
    expect(second.callCount()).toBe(1)
    reopened.close()
  })

  it('retries only a provider call that failed before its decision was saved', async () => {
    const path = databasePath()
    const firstStore = createRoundStore(path)
    firstStore.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const failed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => {
        throw new Error('simulated process interruption')
      }),
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => {
        firstStore.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: firstStore,
    })
    await expect(failed.decide(input)).rejects.toThrow('simulated process interruption')
    firstStore.close()

    const reopened = createRoundStore(path)
    const provider = vi.fn(async () => decision)
    const resumed = createCheckpointedBundleDecider({
      decide: provider,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => {
        reopened.updateAnalysis('round', { callCount })
      },
      roundId: 'round',
      store: reopened,
    })

    await expect(resumed.decide(input)).resolves.toEqual(decision)
    expect(provider).toHaveBeenCalledOnce()
    expect(resumed.callCount()).toBe(2)
    expect(reopened.get('round')?.analysis.callCount).toBe(2)
    reopened.close()
  })

  it('rolls back a reserved call when authentication fails before a decision', async () => {
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
    const checkpointed = createCheckpointedBundleDecider({
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

    await expect(checkpointed.decide(input)).rejects.toBe(authError)
    expect(checkpointed.callCount()).toBe(0)
    expect(store.get('round')?.analysis.callCount).toBe(0)
    store.close()
  })

  it('does not replay a decision made with different learning examples', async () => {
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
    const provider = vi.fn(async () => decision)
    const checkpointed = createCheckpointedBundleDecider({
      decide: provider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store,
    })
    await checkpointed.decide(input)
    await checkpointed.decide({
      ...input,
      examples: [
        {
          anchorSignals: ['provider:alpha'],
          candidateSignals: ['provider:beta'],
          correct: false,
          reason: 'Vom Nutzer im Review bestätigt.',
        },
      ],
    })

    expect(provider).toHaveBeenCalledTimes(2)
    expect(checkpointed.callCount()).toBe(2)
    store.close()
  })

  it('continues after the historical per-round call count instead of aborting the round', async () => {
    const path = databasePath()
    const store = createRoundStore(path)
    store.create({
      analysis: { callCount: 2, engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const provider = vi.fn(async () => decision)
    const unlimited = createCheckpointedBundleDecider({
      decide: provider,
      initialCallCount: 2,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store,
    })

    await expect(unlimited.decide(input)).resolves.toEqual(decision)
    expect(provider).toHaveBeenCalledOnce()
    expect(unlimited.callCount()).toBe(3)
    store.close()
  })

  it('checkpoints every cohort from one provider batch and replays all of them', async () => {
    const path = databasePath()
    const secondSeed = email('seed-2')
    const secondCandidate = email('candidate-2')
    const cohorts: BundleDecisionCohort[] = [
      { ...input, cohortId: 'cohort-1' },
      {
        candidates: [secondCandidate],
        cohortId: 'cohort-2',
        examples: [],
        seed: [secondSeed],
      },
    ]
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate, secondSeed, secondCandidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const batchProvider = vi.fn(async (missing: readonly BundleDecisionCohort[]) =>
      missing.map((cohort) => ({
        ...decision,
        cohortId: cohort.cohortId,
        includedEmailIds: cohort.candidates.map((item) => item.id),
      })),
    )
    const first = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: batchProvider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store,
    })

    await expect(first.decideBatch(cohorts)).resolves.toHaveLength(2)
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(first.callCount()).toBe(1)
    store.close()

    const reopened = createRoundStore(path)
    const replayProvider = vi.fn(async () => [])
    const replay = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: replayProvider,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store: reopened,
    })

    await expect(replay.decideBatch(cohorts)).resolves.toMatchObject([
      { cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { cohortId: 'cohort-2', includedEmailIds: ['candidate-2'] },
    ])
    expect(replayProvider).not.toHaveBeenCalled()
    expect(replay.callCount()).toBe(1)
    reopened.close()
  })

  it('retries only invalid batch cohorts before checkpointing and then isolates them', async () => {
    const path = databasePath()
    const secondSeed = email('seed-2')
    const secondCandidate = email('candidate-2')
    const thirdSeed = email('seed-3')
    const thirdCandidate = email('candidate-3')
    const cohorts: BundleDecisionCohort[] = [
      { ...input, cohortId: 'cohort-1' },
      {
        candidates: [secondCandidate],
        cohortId: 'cohort-2',
        examples: [],
        seed: [secondSeed],
      },
      {
        candidates: [thirdCandidate],
        cohortId: 'cohort-3',
        examples: [],
        seed: [thirdSeed],
      },
    ]
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate, secondSeed, secondCandidate, thirdSeed, thirdCandidate],
      filters,
      generation: 4,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const batchProvider = vi.fn(async (missing: readonly BundleDecisionCohort[]) =>
      missing.map((cohort) => ({
        ...decision,
        cohortId: cohort.cohortId,
        includedEmailIds:
          cohort.cohortId === 'cohort-1' ? cohort.candidates.map(({ id }) => id) : ['candidate'],
      })),
    )
    const singleProvider = vi.fn(async (cohort: BundleDecisionInput) => ({
      ...decision,
      includedEmailIds: cohort.candidates.map(({ id }) => id),
    }))
    const retryLog = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const checkpointed = createCheckpointedBundleDecider({
      decide: singleProvider,
      decideBatch: batchProvider,
      generation: 4,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store,
    })

    await expect(checkpointed.decideBatch(cohorts)).resolves.toMatchObject([
      { cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { cohortId: 'cohort-2', includedEmailIds: ['candidate-2'] },
      { cohortId: 'cohort-3', includedEmailIds: ['candidate-3'] },
    ])
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(batchProvider.mock.calls[0]?.[0]).toHaveLength(3)
    expect(singleProvider).toHaveBeenCalledTimes(2)
    expect(checkpointed.callCount()).toBe(3)
    expect(
      retryLog.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>),
    ).toEqual([
      {
        event: 'bundle_decision_contract_retry',
        generation: 4,
        invalidCohortCount: 2,
        roundId: 'round',
        scope: 'batch',
      },
      {
        event: 'bundle_decision_contract_recovered',
        generation: 4,
        invalidCohortCount: 2,
        roundId: 'round',
        scope: 'batch',
      },
    ])
    store.close()

    const reopened = createRoundStore(path)
    const replayBatch = vi.fn(async () => [])
    const replaySingle = vi.fn(async () => decision)
    const replay = createCheckpointedBundleDecider({
      decide: replaySingle,
      decideBatch: replayBatch,
      generation: 4,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store: reopened,
    })

    await expect(replay.decideBatch(cohorts)).resolves.toMatchObject([
      { cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { cohortId: 'cohort-2', includedEmailIds: ['candidate-2'] },
      { cohortId: 'cohort-3', includedEmailIds: ['candidate-3'] },
    ])
    expect(replayBatch).not.toHaveBeenCalled()
    expect(replaySingle).not.toHaveBeenCalled()
    expect(replay.callCount()).toBe(3)
    reopened.close()
  })

  it('fails closed after bounded invalid decisions without poisoning the checkpoint', async () => {
    const path = databasePath()
    const secondSeed = email('seed-2')
    const secondCandidate = email('candidate-2')
    const cohorts: BundleDecisionCohort[] = [
      { ...input, cohortId: 'cohort-1' },
      {
        candidates: [secondCandidate],
        cohortId: 'cohort-2',
        examples: [],
        seed: [secondSeed],
      },
    ]
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate, secondSeed, secondCandidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const invalid = { ...decision, includedEmailIds: ['seed'] }
    const batchProvider = vi.fn(async () => [
      { ...decision, cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { ...invalid, cohortId: 'cohort-2' },
    ])
    const singleProvider = vi.fn(async () => invalid)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const checkpointed = createCheckpointedBundleDecider({
      decide: singleProvider,
      decideBatch: batchProvider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store,
    })

    await expect(checkpointed.decideBatch(cohorts)).rejects.toThrow('outside its candidate set')
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(singleProvider).toHaveBeenCalledOnce()
    expect(checkpointed.callCount()).toBe(2)
    store.close()

    const reopened = createRoundStore(path)
    const validBatch = vi.fn(async (missing: readonly BundleDecisionCohort[]) =>
      missing.map((cohort) => ({
        ...decision,
        cohortId: cohort.cohortId,
        includedEmailIds: cohort.candidates.map(({ id }) => id),
      })),
    )
    const resumed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: validBatch,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => reopened.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store: reopened,
    })

    await expect(resumed.decideBatch(cohorts)).resolves.toMatchObject([
      { cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { cohortId: 'cohort-2', includedEmailIds: ['candidate-2'] },
    ])
    expect(validBatch).toHaveBeenCalledOnce()
    expect(validBatch.mock.calls[0]?.[0]).toHaveLength(1)
    expect(validBatch.mock.calls[0]?.[0]?.[0]?.cohortId).toBe('cohort-2')
    expect(resumed.callCount()).toBe(3)
    reopened.close()
  })

  it('keeps valid batch checkpoints when the isolated retry loses authentication', async () => {
    const path = databasePath()
    const secondSeed = email('seed-2')
    const secondCandidate = email('candidate-2')
    const cohorts: BundleDecisionCohort[] = [
      { ...input, cohortId: 'cohort-1' },
      {
        candidates: [secondCandidate],
        cohortId: 'cohort-2',
        examples: [],
        seed: [secondSeed],
      },
    ]
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate, secondSeed, secondCandidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const authError = new Error('authentication expired')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const batchProvider = vi.fn(async () => [
      { ...decision, cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { ...decision, cohortId: 'cohort-2', includedEmailIds: ['candidate'] },
    ])
    const checkpointed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => {
        throw authError
      }),
      decideBatch: batchProvider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallRolledBack: (callCount) => store.updateAnalysis('round', { callCount }),
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      shouldRollbackCall: (error) => error === authError,
      store,
    })

    await expect(checkpointed.decideBatch(cohorts)).rejects.toBe(authError)
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(checkpointed.callCount()).toBe(1)
    expect(store.get('round')?.analysis.callCount).toBe(1)
    store.close()

    const reopened = createRoundStore(path)
    const remainingProvider = vi.fn(async (missing: readonly BundleDecisionCohort[]) =>
      missing.map((cohort) => ({
        ...decision,
        cohortId: cohort.cohortId,
        includedEmailIds: cohort.candidates.map(({ id }) => id),
      })),
    )
    const resumed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: remainingProvider,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => reopened.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store: reopened,
    })

    await expect(resumed.decideBatch(cohorts)).resolves.toHaveLength(2)
    expect(remainingProvider).toHaveBeenCalledOnce()
    expect(remainingProvider.mock.calls[0]?.[0]).toHaveLength(1)
    expect(remainingProvider.mock.calls[0]?.[0]?.[0]?.cohortId).toBe('cohort-2')
    expect(resumed.callCount()).toBe(2)
    reopened.close()
  })

  it('rejects one invalid direct decision without retrying or checkpointing it', async () => {
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
    const provider = vi.fn(async () => ({ ...decision, includedEmailIds: ['seed'] }))
    const checkpointed = createCheckpointedBundleDecider({
      decide: provider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store,
    })

    await expect(checkpointed.decide(input)).rejects.toThrow('outside its candidate set')
    expect(provider).toHaveBeenCalledOnce()
    expect(checkpointed.callCount()).toBe(1)
    store.close()

    const reopened = createRoundStore(path)
    const validProvider = vi.fn(async () => decision)
    const resumed = createCheckpointedBundleDecider({
      decide: validProvider,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => reopened.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store: reopened,
    })

    await expect(resumed.decide(input)).resolves.toEqual(decision)
    expect(validProvider).toHaveBeenCalledOnce()
    expect(resumed.callCount()).toBe(2)
    reopened.close()
  })

  it('does not checkpoint a batch when its signal is aborted before validation', async () => {
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
    const controller = new AbortController()
    const batchProvider = vi.fn(async () => {
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      return [{ ...decision, cohortId: 'cohort-1' }]
    })
    const checkpointed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: batchProvider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store,
    })
    const cohort: BundleDecisionCohort = { ...input, cohortId: 'cohort-1' }

    await expect(checkpointed.decideBatch([cohort], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(checkpointed.callCount()).toBe(1)
    store.close()

    const reopened = createRoundStore(path)
    const resumedBatch = vi.fn(async () => [{ ...decision, cohortId: 'cohort-1' }])
    const resumed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: resumedBatch,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store: reopened,
    })

    await expect(resumed.decideBatch([cohort])).resolves.toHaveLength(1)
    expect(resumedBatch).toHaveBeenCalledOnce()
    reopened.close()
  })

  it('does not retry when the analysis generation changes during a batch call', async () => {
    const path = databasePath()
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate],
      filters,
      generation: 1,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const batchProvider = vi.fn(async () => {
      store.reanalyze('round', {
        callCount: 0,
        phase: 'indexing',
        processedEmailCount: 0,
        progress: 0,
        status: 'pending',
      })
      return [{ ...decision, cohortId: 'cohort-1', includedEmailIds: ['seed'] }]
    })
    const singleProvider = vi.fn(async () => decision)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const checkpointed = createCheckpointedBundleDecider({
      decide: singleProvider,
      decideBatch: batchProvider,
      generation: 1,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => {
        const updated = store.updateAnalysis('round', { callCount }, 1)
        if (!updated) throw new Error('The analysis generation was superseded.')
      },
      roundId: 'round',
      store,
    })
    const cohort: BundleDecisionCohort = { ...input, cohortId: 'cohort-1' }

    await expect(checkpointed.decideBatch([cohort])).rejects.toThrow('generation was superseded')
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(singleProvider).not.toHaveBeenCalled()
    expect(store.get('round')?.generation).toBe(2)
    store.close()
  })

  it('keeps valid checkpoints when the isolated retry is aborted', async () => {
    const path = databasePath()
    const secondSeed = email('seed-2')
    const secondCandidate = email('candidate-2')
    const cohorts: BundleDecisionCohort[] = [
      { ...input, cohortId: 'cohort-1' },
      {
        candidates: [secondCandidate],
        cohortId: 'cohort-2',
        examples: [],
        seed: [secondSeed],
      },
    ]
    const store = createRoundStore(path)
    store.create({
      analysis: { engine: 'codex', model: 'gpt-5.6-sol' },
      csrfToken: 'csrf',
      emails: [seed, candidate, secondSeed, secondCandidate],
      filters,
      id: 'round',
      imageToken: 'image',
      mailboxes: [],
      mode: 'live',
    })
    const controller = new AbortController()
    const batchProvider = vi.fn(async () => [
      { ...decision, cohortId: 'cohort-1', includedEmailIds: ['candidate'] },
      { ...decision, cohortId: 'cohort-2', includedEmailIds: ['candidate'] },
    ])
    const singleProvider = vi.fn(async () => {
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      return { ...decision, includedEmailIds: ['candidate-2'] }
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const checkpointed = createCheckpointedBundleDecider({
      decide: singleProvider,
      decideBatch: batchProvider,
      initialCallCount: 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => store.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store,
    })

    await expect(checkpointed.decideBatch(cohorts, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(batchProvider).toHaveBeenCalledOnce()
    expect(singleProvider).toHaveBeenCalledOnce()
    expect(checkpointed.callCount()).toBe(2)
    store.close()

    const reopened = createRoundStore(path)
    const remainingProvider = vi.fn(async (missing: readonly BundleDecisionCohort[]) =>
      missing.map((cohort) => ({
        ...decision,
        cohortId: cohort.cohortId,
        includedEmailIds: cohort.candidates.map(({ id }) => id),
      })),
    )
    const resumed = createCheckpointedBundleDecider({
      decide: vi.fn(async () => decision),
      decideBatch: remainingProvider,
      initialCallCount: reopened.get('round')?.analysis.callCount ?? 0,
      model: 'gpt-5.6-sol',
      onCallStarted: (callCount) => reopened.updateAnalysis('round', { callCount }),
      roundId: 'round',
      store: reopened,
    })

    await expect(resumed.decideBatch(cohorts)).resolves.toHaveLength(2)
    expect(remainingProvider).toHaveBeenCalledOnce()
    expect(remainingProvider.mock.calls[0]?.[0]).toHaveLength(1)
    expect(remainingProvider.mock.calls[0]?.[0]?.[0]?.cohortId).toBe('cohort-2')
    expect(resumed.callCount()).toBe(3)
    reopened.close()
  })

  it('rejects a legacy poisoned checkpoint without another provider call', async () => {
    const poisoned = { ...decision, includedEmailIds: ['seed'] }
    const provider = vi.fn(async () => decision)
    const getBundleDecision = vi.fn(() => poisoned)
    const saveBundleDecision = vi.fn(() => decision)
    const checkpointed = createCheckpointedBundleDecider({
      decide: provider,
      initialCallCount: 1,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store: { getBundleDecision, saveBundleDecision },
    })

    await expect(checkpointed.decide(input)).rejects.toThrow('outside its candidate set')
    expect(getBundleDecision).toHaveBeenCalledOnce()
    expect(provider).not.toHaveBeenCalled()
    expect(saveBundleDecision).not.toHaveBeenCalled()
  })
})
