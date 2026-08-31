import { createHash } from 'node:crypto'
import type {
  BundleDecision,
  BundleDecisionCohort,
  BundleDecisionInput,
  BundleDecisionResult,
  BundlePartitionDecision,
  BundlePartitionInput,
  DecideBundle,
  DecideBundleBatch,
  DecideBundlePartition,
} from './bundles.ts'
import {
  assertBundleDecisionCandidateMembership,
  BundleDecisionCandidateError,
  validateBundleDecisionPartition,
} from './bundles.ts'
import type { RoundStore } from './round-store.ts'

export interface CheckpointedBundleDecider {
  callCount(): number
  decide: DecideBundle
  decideBatch: DecideBundleBatch
}

export interface CheckpointedBundlePartitionDecider {
  callCount(): number
  decide: DecideBundlePartition
}

function decisionKey(input: BundleDecisionInput, model: string | undefined) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidates: input.candidates.map((email) => email.id),
        examples: input.examples,
        model: model ?? null,
        seed: input.seed.map((email) => email.id),
        version: 3,
      }),
    )
    .digest('hex')
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
    assertBundleDecisionCandidateMembership(input.candidates, decision.includedEmailIds)
    const saved = options.store.saveBundleDecision(
      options.roundId,
      decisionKey(input, options.model),
      decision,
      options.generation,
    )
    if (!saved) throw new Error('The Codex decision could not be persisted.')
    assertBundleDecisionCandidateMembership(input.candidates, saved.includedEmailIds)
    return saved
  }

  const reportContractEvent = (
    event: 'bundle_decision_contract_retry' | 'bundle_decision_contract_recovered',
    invalidCohortCount: number,
  ) => {
    process.stderr.write(
      `${JSON.stringify({
        event,
        generation: options.generation ?? null,
        invalidCohortCount,
        roundId: options.roundId,
        scope: 'batch',
      })}\n`,
    )
  }

  const decideOne: DecideBundle = async (input, signal) => {
    signal?.throwIfAborted()
    const cached = loadDecision(input)
    if (cached) {
      assertBundleDecisionCandidateMembership(input.candidates, cached.includedEmailIds)
      return cached
    }
    const decision = await callProvider(() => options.decide(input, signal))
    signal?.throwIfAborted()
    return saveDecision(input, decision)
  }

  const returnedByCohort = (
    cohorts: readonly BundleDecisionCohort[],
    returned: readonly BundleDecisionResult[] | undefined,
  ) => {
    if (!returned) throw new Error('The Codex batch provider returned no decisions.')
    const decisions = new Map<string, BundleDecisionResult>()
    for (const decision of returned) {
      if (
        !cohorts.some((cohort) => cohort.cohortId === decision.cohortId) ||
        decisions.has(decision.cohortId)
      ) {
        throw new Error('The Codex batch provider returned an unknown or duplicate cohort ID.')
      }
      decisions.set(decision.cohortId, decision)
    }
    if (decisions.size !== cohorts.length) {
      throw new Error('The Codex batch provider did not decide every uncached cohort.')
    }
    return decisions
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
      if (cached) {
        assertBundleDecisionCandidateMembership(cohort.candidates, cached.includedEmailIds)
        decisions.set(cohort.cohortId, cached)
      } else missing.push(cohort)
    }

    if (missing.length > 0 && options.decideBatch) {
      const batchProvider = options.decideBatch
      const returned = await callProvider(() => batchProvider(missing, signal))
      signal?.throwIfAborted()
      const batchDecisions = returnedByCohort(missing, returned)
      const invalid: BundleDecisionCohort[] = []
      for (const cohort of missing) {
        const decision = batchDecisions.get(cohort.cohortId)
        if (!decision) throw new Error('The Codex batch decision disappeared before persistence.')
        try {
          assertBundleDecisionCandidateMembership(cohort.candidates, decision.includedEmailIds)
        } catch (error) {
          if (!(error instanceof BundleDecisionCandidateError)) throw error
          invalid.push(cohort)
          continue
        }
        decisions.set(cohort.cohortId, saveDecision(cohort, decision))
      }
      if (invalid.length > 0) {
        reportContractEvent('bundle_decision_contract_retry', invalid.length)
        for (const cohort of invalid) {
          decisions.set(cohort.cohortId, await decideOne(cohort, signal))
        }
        reportContractEvent('bundle_decision_contract_recovered', invalid.length)
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
