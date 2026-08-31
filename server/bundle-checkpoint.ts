import { createHash } from 'node:crypto'
import type {
  BundleDecision,
  BundleDecisionCohort,
  BundleDecisionInput,
  BundleDecisionResult,
  DecideBundle,
  DecideBundleBatch,
} from './bundles.ts'
import type { RoundStore } from './round-store.ts'

export interface CheckpointedBundleDecider {
  callCount(): number
  decide: DecideBundle
  decideBatch: DecideBundleBatch
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
  decideBatch?: DecideBundleBatch
  initialCallCount: number
  model?: string
  generation?: number
  onCallRolledBack?: (callCount: number) => void
  onCallStarted: (callCount: number) => void
  roundId: string
  shouldRollbackCall?: (error: unknown) => boolean
  store: Pick<RoundStore, 'getBundleDecision' | 'saveBundleDecision'>
}): CheckpointedBundleDecider {
  let callCount = Math.max(0, Math.floor(options.initialCallCount))

  const callProvider = async <Result>(invoke: () => Promise<Result>): Promise<Result> => {
    callCount += 1
    options.onCallStarted(callCount)
    try {
      return await invoke()
    } catch (error) {
      if (options.shouldRollbackCall?.(error)) {
        callCount = Math.max(0, callCount - 1)
        options.onCallRolledBack?.(callCount)
      }
      throw error
    }
  }

  const loadDecision = (input: BundleDecisionInput) =>
    options.store.getBundleDecision(
      options.roundId,
      decisionKey(input, options.model),
      options.generation,
    )

  const saveDecision = (input: BundleDecisionInput, decision: BundleDecision) => {
    const saved = options.store.saveBundleDecision(
      options.roundId,
      decisionKey(input, options.model),
      decision,
      options.generation,
    )
    if (!saved) throw new Error('The Codex decision could not be persisted.')
    return saved
  }

  const decideOne: DecideBundle = async (input, signal) => {
    signal?.throwIfAborted()
    const cached = loadDecision(input)
    if (cached) return cached
    const decision = await callProvider(() => options.decide(input, signal))
    signal?.throwIfAborted()
    return saveDecision(input, decision)
  }

  const decideBatch: DecideBundleBatch = async (cohorts, signal) => {
    signal?.throwIfAborted()
    const seenCohortIds = new Set<string>()
    const decisions = new Map<string, BundleDecision>()
    const missing: BundleDecisionCohort[] = []
    for (const cohort of cohorts) {
      if (seenCohortIds.has(cohort.cohortId)) {
        throw new Error('A bundle decision batch cannot contain duplicate cohort IDs.')
      }
      seenCohortIds.add(cohort.cohortId)
      const cached = loadDecision(cohort)
      if (cached) decisions.set(cohort.cohortId, cached)
      else missing.push(cohort)
    }

    if (missing.length > 0 && options.decideBatch) {
      const batchProvider = options.decideBatch
      const returned = await callProvider(() => batchProvider(missing, signal))
      signal?.throwIfAborted()
      if (!returned) throw new Error('The Codex batch provider returned no decisions.')
      const returnedByCohort = new Map<string, BundleDecisionResult>()
      for (const decision of returned) {
        if (
          !missing.some((cohort) => cohort.cohortId === decision.cohortId) ||
          returnedByCohort.has(decision.cohortId)
        ) {
          throw new Error('The Codex batch provider returned an unknown or duplicate cohort ID.')
        }
        returnedByCohort.set(decision.cohortId, decision)
      }
      if (returnedByCohort.size !== missing.length) {
        throw new Error('The Codex batch provider did not decide every uncached cohort.')
      }
      for (const cohort of missing) {
        const decision = returnedByCohort.get(cohort.cohortId)
        if (!decision) throw new Error('The Codex batch decision disappeared before persistence.')
        decisions.set(cohort.cohortId, saveDecision(cohort, decision))
      }
    } else {
      for (const cohort of missing) {
        decisions.set(cohort.cohortId, await decideOne(cohort, signal))
      }
    }
    signal?.throwIfAborted()
    return cohorts.map((cohort) => {
      const decision = decisions.get(cohort.cohortId)
      if (!decision) throw new Error('A checkpointed bundle decision is missing.')
      return { ...decision, cohortId: cohort.cohortId }
    })
  }

  return {
    callCount: () => callCount,
    decide: decideOne,
    decideBatch,
  }
}
