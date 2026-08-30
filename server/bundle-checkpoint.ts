import { createHash } from 'node:crypto'
import type { BundleDecision, BundleDecisionInput, DecideBundle } from './bundles.ts'
import type { RoundStore } from './round-store.ts'

export interface CheckpointedBundleDecider {
  callCount(): number
  decide: DecideBundle
}

function decisionKey(input: BundleDecisionInput, model: string | undefined) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidates: input.candidates.map((email) => email.id),
        examples: input.examples,
        model: model ?? null,
        seed: input.seed.map((email) => email.id),
        version: 2,
      }),
    )
    .digest('hex')
}

export function createCheckpointedBundleDecider(options: {
  decide: DecideBundle
  initialCallCount: number
  maxCallCount?: number
  model?: string
  onCallRolledBack?: (callCount: number) => void
  onCallStarted: (callCount: number) => void
  roundId: string
  shouldRollbackCall?: (error: unknown) => boolean
  store: Pick<RoundStore, 'getBundleDecision' | 'saveBundleDecision'>
}): CheckpointedBundleDecider {
  let callCount = Math.max(0, Math.floor(options.initialCallCount))
  return {
    callCount: () => callCount,
    decide: async (input) => {
      const key = decisionKey(input, options.model)
      const cached = options.store.getBundleDecision(options.roundId, key)
      if (cached) return cached
      if (options.maxCallCount !== undefined && callCount >= options.maxCallCount) {
        throw new Error(`Codex bundle call budget exhausted after ${options.maxCallCount} calls.`)
      }
      callCount += 1
      options.onCallStarted(callCount)
      try {
        const decision: BundleDecision = await options.decide(input)
        const saved = options.store.saveBundleDecision(options.roundId, key, decision)
        if (!saved) throw new Error('The Codex decision could not be persisted.')
        return saved
      } catch (error) {
        if (options.shouldRollbackCall?.(error)) {
          callCount = Math.max(0, callCount - 1)
          options.onCallRolledBack?.(callCount)
        }
        throw error
      }
    },
  }
}
