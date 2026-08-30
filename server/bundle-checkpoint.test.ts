import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewEmailSummary, ReviewFilters } from '../src/shared.ts'
import { createCheckpointedBundleDecider } from './bundle-checkpoint.ts'
import type { BundleDecision, BundleDecisionInput } from './bundles.ts'
import { createRoundStore } from './round-store.ts'

const directories: string[] = []

afterEach(() => {
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

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-walk-bundle-checkpoint-'))
  directories.push(directory)
  return join(directory, 'inbox-walk.sqlite')
}

describe('persisted Codex bundle decisions', () => {
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
      maxCallCount: 1,
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

  it('fails closed before exceeding the per-round Codex call budget', async () => {
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
    const limited = createCheckpointedBundleDecider({
      decide: provider,
      initialCallCount: 2,
      maxCallCount: 2,
      model: 'gpt-5.6-sol',
      onCallStarted: () => {},
      roundId: 'round',
      store,
    })

    await expect(limited.decide(input)).rejects.toThrow('call budget exhausted')
    expect(provider).not.toHaveBeenCalled()
    expect(limited.callCount()).toBe(2)
    store.close()
  })
})
