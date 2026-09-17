import { createHash } from 'node:crypto'
import type {
  BundlePartitionDecision,
  BundlePartitionInput,
  DecideBundlePartition,
} from './bundles.ts'
import { validateBundleDecisionPartition } from './bundles.ts'
import type { RoundStore } from './round-store.ts'

export interface CheckpointedBundlePartitionDecider {
  callCount(): number
  decide: DecideBundlePartition
}

function partitionDecisionKey(input: BundlePartitionInput, configuration: string | undefined) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        configuration: configuration ?? null,
        emails: input.emails,
        examples: input.examples,
        scope: 'global-partition',
        version: 2,
      }),
    )
    .digest('hex')
}

export function createCheckpointedBundlePartitionDecider(options: {
  configuration?: string
  decide: DecideBundlePartition
  generation?: number
  initialCallCount: number
  onCallRolledBack?: (callCount: number) => void
  onCallStarted: (callCount: number) => void
  roundId: string
  shouldRollbackCall?: (error: unknown) => boolean
  store: Pick<RoundStore, 'getBundlePartition' | 'saveBundlePartition'>
}): CheckpointedBundlePartitionDecider {
  let callCount = Math.max(0, Math.floor(options.initialCallCount))

  const decide: DecideBundlePartition = async (input, signal) => {
    signal?.throwIfAborted()
    const inputIds = input.emails.map((email) => email.id)
    const key = partitionDecisionKey(input, options.configuration)
    const cached = options.store.getBundlePartition(options.roundId, key, options.generation)
    if (cached) {
      validateBundleDecisionPartition(inputIds, cached)
      return cached
    }

    callCount += 1
    options.onCallStarted(callCount)
    let decision: BundlePartitionDecision
    try {
      decision = await options.decide(input, signal)
    } catch (error) {
      if (options.shouldRollbackCall?.(error)) {
        callCount = Math.max(0, callCount - 1)
        options.onCallRolledBack?.(callCount)
      }
      throw error
    }
    signal?.throwIfAborted()
    validateBundleDecisionPartition(inputIds, decision)
    const saved = options.store.saveBundlePartition(
      options.roundId,
      key,
      decision,
      options.generation,
    )
    if (!saved) throw new Error('The Codex bundle partition could not be persisted.')
    validateBundleDecisionPartition(inputIds, saved)
    return saved
  }

  return { callCount: () => callCount, decide }
}
