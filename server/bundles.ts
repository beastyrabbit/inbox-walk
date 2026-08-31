import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type {
  BundleKind,
  ReviewBundle,
  ReviewBundleRun,
  ReviewEmailSummary,
} from '../src/shared.ts'

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const GENERIC_TERMS = new Set([
  'about',
  'and',
  'bestellung',
  'deine',
  'deployment',
  'der',
  'die',
  'email',
  'for',
  'from',
  'github',
  'ist',
  'mail',
  'message',
  'mit',
  'nachricht',
  'railway',
  'the',
  'und',
  'von',
  'your',
])

export interface BundleSignals {
  conflictKeys: string[]
  exactKeys: string[]
  provider: string
  searchTerms: string[]
}

export interface BundleExample {
  anchorSignals: string[]
  candidateSignals: string[]
  correct: boolean
  reason: string
}

export interface BundleDecisionInput {
  candidates: ReviewEmailSummary[]
  examples: BundleExample[]
  seed: ReviewEmailSummary[]
}

export interface BundleDecision {
  currentState: string
  includedEmailIds: string[]
  kind: BundleKind
  linkEvidence: string[]
  membershipConfidence: number
  summary: string
  title: string
}

export interface BundleDecisionCohort extends BundleDecisionInput {
  cohortId: string
}

export interface BundleDecisionResult extends BundleDecision {
  cohortId: string
}

export interface BundlePartitionInput {
  emails: ReviewEmailSummary[]
  examples: BundleExample[]
}

export interface BundlePartitionStory {
  currentState: string
  emailIds: string[]
  kind: BundleKind
  linkEvidence: string[]
  membershipConfidence: number
  summary: string
  title: string
}

export interface BundlePartitionDecision {
  standaloneEmailIds: string[]
  stories: BundlePartitionStory[]
}

export type DecideBundlePartition = (
  input: BundlePartitionInput,
  signal?: AbortSignal,
) => Promise<BundlePartitionDecision>

export class BundleDecisionCandidateError extends Error {
  constructor() {
    super('Bundle decision contains an ID outside its candidate set.')
    this.name = 'BundleDecisionCandidateError'
  }
}

export function assertBundleDecisionCandidateMembership(
  candidates: readonly Pick<ReviewEmailSummary, 'id'>[],
  includedEmailIds: readonly string[],
) {
  const permitted = new Set(candidates.map((email) => email.id))
  if (includedEmailIds.some((id) => !permitted.has(id))) {
    throw new BundleDecisionCandidateError()
  }
}

export type DecideBundle = (
  input: BundleDecisionInput,
  signal?: AbortSignal,
) => Promise<BundleDecision>

export type DecideBundleBatch = (
  cohorts: readonly BundleDecisionCohort[],
  signal?: AbortSignal,
) => Promise<BundleDecisionResult[]>

export type BundleAnalysisEngine = 'codex' | 'fallback' | 'heuristic'

export type BundleBuildPhase =
  | 'indexing'
  | 'grouping'
  | 'deciding'
  | 'reconciling'
  | 'finalizing'
  | 'fallback'
  | 'complete'

export interface BundleBuildProgress {
  codexCallCount: number
  engine: BundleAnalysisEngine
  model?: string
  phase: BundleBuildPhase
  processedEmailCount: number
  progress: number
  totalEmailCount: number
}

export interface BuildReviewBundlesOptions {
  codexCallCount?: number
  decideBatch?: DecideBundleBatch
  engine?: BundleAnalysisEngine
  getCodexCallCount?: () => number
  model?: string
  onProgress?: (progress: BundleBuildProgress) => void
  signal?: AbortSignal
}

const MAX_BATCH_COHORTS = 8
const MAX_CANDIDATE_ROOTS_PER_COHORT = 24
const MAX_CROSS_SOURCE_RECALL_ROOTS = 8
const MAX_CROSS_SOURCE_TEMPORAL_NEIGHBORS = 64
const MAX_LEXICAL_HITS = 512
const MAX_QUERY_TERMS = 12
const CROSS_SOURCE_RECALL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function bundleProgressReporter(
  totalEmailCount: number,
  options: BuildReviewBundlesOptions,
  defaultEngine: BundleAnalysisEngine,
) {
  let lastProgress = 0
  let codexCallCount = Math.max(0, Math.floor(options.codexCallCount ?? 0))
  const currentCodexCallCount = () =>
    Math.max(0, Math.floor(options.getCodexCallCount?.() ?? codexCallCount))
  const emit = (
    phase: BundleBuildPhase,
    progress: number,
    processedEmailCount: number,
    engine = options.engine ?? defaultEngine,
  ) => {
    lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, progress)))
    options.onProgress?.({
      codexCallCount: currentCodexCallCount(),
      engine,
      ...(options.model ? { model: options.model } : {}),
      phase,
      processedEmailCount: Math.min(totalEmailCount, Math.max(0, Math.floor(processedEmailCount))),
      progress: lastProgress,
      totalEmailCount,
    })
  }
  return {
    codexCallStarted() {
      if (!options.getCodexCallCount) codexCallCount += 1
    },
    emit,
  }
}

function normalized(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function unique(values: Iterable<string>) {
  return [...new Set(values)]
}

function senderDomain(email: ReviewEmailSummary) {
  return email.from[0]?.email?.split('@').at(-1)?.toLowerCase() ?? ''
}

function providerFor(email: ReviewEmailSummary) {
  const haystack = normalized(
    `${email.from.map((item) => `${item.name ?? ''} ${item.email ?? ''}`).join(' ')} ${email.subject}`,
  )
  if (/github/.test(haystack)) return 'GitHub'
  if (/railway/.test(haystack)) return 'Railway'
  if (/amazon/.test(haystack)) return 'Amazon'
  if (/\bdhl\b/.test(haystack)) return 'DHL'
  if (/hermes/.test(haystack)) return 'Hermes'
  return email.from[0]?.name?.trim() || senderDomain(email) || 'E-Mail'
}

function matches(text: string, pattern: RegExp, prefix: string) {
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.replace(/[),.;]+$/, '').toLowerCase()
    if (value) found.push(`${prefix}:${value}`)
  }
  return found
}

export function extractBundleSignals(email: ReviewEmailSummary): BundleSignals {
  const text = normalized(`${email.subject}\n${email.preview}`)
  const repos = matches(text, /\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/g, 'repo').filter((key) => {
    const [owner, repository] = key.slice('repo:'.length).split('/')
    return Boolean(
      owner &&
        repository &&
        /[a-z]/.test(owner) &&
        /[a-z]/.test(repository) &&
        !owner.includes('.'),
    )
  })
  const commits = matches(text, /\b([0-9a-f]{7,40})\b/g, 'commit').filter((key) => {
    const value = key.slice('commit:'.length)
    return /[a-f]/.test(value) && /\d/.test(value)
  })
  const deployments = matches(
    text,
    /\b(?:deployment|deploy)(?: id)?\s*[#:\-/]\s*([a-z0-9][a-z0-9_-]{5,})\b/g,
    'deployment',
  )
  const tracking = matches(
    text,
    /\b(?:tracking|sendungs(?:nummer|nr\.?))\s*[#:-]*\s*([a-z0-9][a-z0-9-]{7,})\b/g,
    'tracking',
  )
  const orders = matches(
    text,
    /\b(?:order|bestell(?:ung|nummer|nr\.?))(?:\s+(?:nr\.?|nummer))?\s*[#:-]*\s*([a-z0-9][a-z0-9-]{4,})\b/g,
    'order',
  ).filter((key) => /\d/.test(key.slice('order:'.length)))
  const pullRequests = matches(text, /\b(?:pull request|pr)\s*#?\s*(\d{1,8})\b/g, 'pr')
  const exactKeys = unique([
    `thread:${email.threadId}`,
    ...deployments,
    ...tracking,
    ...orders,
    ...pullRequests.flatMap((pr) => repos.map((repo) => `${repo}|${pr}`)),
    ...commits.flatMap((commit) => repos.map((repo) => `${repo}|${commit}`)),
  ])
  const searchTerms = unique(
    text
      .split(/[^\p{L}\p{N}_./-]+/u)
      .map((term) => term.replace(/^[-./]+|[-./]+$/g, ''))
      .filter((term) => term.length >= 4 && !GENERIC_TERMS.has(term))
      .sort((left, right) => right.length - left.length)
      .slice(0, 16),
  )
  return {
    conflictKeys: unique([...repos, ...tracking, ...orders]),
    exactKeys,
    provider: providerFor(email),
    searchTerms,
  }
}

export function learningSignalsFor(emails: readonly ReviewEmailSummary[]) {
  return unique(
    emails.flatMap((email) => {
      const signals = extractBundleSignals(email)
      return [
        hashLearningSignal(`provider:${signals.provider}`),
        ...[...signals.exactKeys, ...signals.conflictKeys].flatMap((signal) =>
          unique([hashLearningSignal(signal), legacyHashedLearningSignal(signal)]),
        ),
      ]
    }),
  ).slice(0, 100)
}

const HASHED_LEARNING_SIGNAL = /^([a-z][a-z0-9_-]{0,31}):sha256:([a-f0-9]{64})$/i

export function hashLearningSignal(signal: string) {
  const canonical = normalized(signal.trim())
  const alreadyHashed = HASHED_LEARNING_SIGNAL.exec(canonical)
  if (alreadyHashed) {
    return `${alreadyHashed[1]}:sha256:${alreadyHashed[2]}`
  }
  const separator = canonical.indexOf(':')
  const proposedType = separator > 0 ? canonical.slice(0, separator) : 'signal'
  const type = /^[a-z][a-z0-9_-]{0,31}$/.test(proposedType) ? proposedType : 'signal'
  return `${type}:sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

function legacyHashedLearningSignal(signal: string) {
  const type = signal.split(':')[0]
  return `${type}:sha256:${createHash('sha256').update(signal).digest('hex')}`
}

class UnionFind {
  private readonly parent = new Map<string, string>()

  add(id: string) {
    this.parent.set(id, id)
  }

  find(id: string): string {
    const parent = this.parent.get(id)
    if (!parent) throw new Error(`Unknown bundle member: ${id}`)
    if (parent === id) return id
    const root = this.find(parent)
    this.parent.set(id, root)
    return root
  }

  join(left: string, right: string) {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot)
  }
}

function ftsCandidates(
  emails: readonly ReviewEmailSummary[],
  signals: Map<string, BundleSignals>,
  signal?: AbortSignal,
) {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE VIRTUAL TABLE mail_index USING fts5(email_id UNINDEXED, content)')
    const insert = database.prepare('INSERT INTO mail_index(email_id, content) VALUES (?, ?)')
    const documentFrequency = new Map<string, number>()
    for (const email of emails) {
      signal?.throwIfAborted()
      insert.run(email.id, `${email.subject} ${email.preview}`)
      for (const term of new Set(signals.get(email.id)?.searchTerms ?? [])) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
    }
    const query = database.prepare(
      'SELECT email_id FROM mail_index WHERE mail_index MATCH ? ORDER BY bm25(mail_index), email_id LIMIT ?',
    )
    const maximumDocumentFrequency = Math.max(8, Math.ceil(emails.length * 0.1))
    const find = (
      emailIds: readonly string[],
      excluded: ReadonlySet<string>,
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted()
      const terms = unique(
        emailIds
          .flatMap((id) => signals.get(id)?.searchTerms ?? [])
          .filter((term) => {
            const frequency = documentFrequency.get(term) ?? 0
            return term.length >= 4 && frequency > 1 && frequency <= maximumDocumentFrequency
          }),
      )
        .sort(
          (left, right) =>
            (documentFrequency.get(left) ?? 0) - (documentFrequency.get(right) ?? 0) ||
            left.localeCompare(right),
        )
        .slice(0, MAX_QUERY_TERMS)
      if (terms.length === 0) return []
      const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
      const rows = query.all(expression, MAX_LEXICAL_HITS) as Array<{ email_id: string }>
      signal?.throwIfAborted()
      return unique(rows.map((row) => row.email_id).filter((id) => !excluded.has(id)))
    }
    return { close: () => database.close(), find }
  } catch (error) {
    database.close()
    throw error
  }
}

export function selectBundleExamples(
  examples: readonly BundleExample[],
  relevantSignals: readonly string[] = [],
) {
  const relevant = new Set(relevantSignals)
  const relevantTypes = new Set(relevantSignals.map((signal) => signal.split(':')[0]))
  const ranked = examples
    .map((example, index) => {
      const signals = [...example.anchorSignals, ...example.candidateSignals]
      const exact = signals.filter((signal) => relevant.has(signal)).length
      const sameType = signals.filter((signal) => relevantTypes.has(signal.split(':')[0])).length
      return { example, index, score: exact * 10 + sameType }
    })
    .filter((entry) => relevantSignals.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.example)
  const positives = ranked.filter((example) => example.correct).slice(0, 2)
  const negatives = ranked.filter((example) => !example.correct).slice(0, 2)
  return [...positives, ...negatives]
}

function defaultKind(providers: readonly string[]): BundleKind {
  if (providers.some((provider) => provider === 'GitHub' || provider === 'Railway')) {
    return 'development_workstream'
  }
  if (providers.some((provider) => ['Amazon', 'DHL', 'Hermes'].includes(provider))) {
    return 'order_delivery'
  }
  return 'standalone'
}

function hardConflict(
  left: readonly ReviewEmailSummary[],
  right: readonly ReviewEmailSummary[],
  signals: Map<string, BundleSignals>,
) {
  for (const prefix of ['repo:', 'order:']) {
    const leftKeys = new Set(
      left
        .flatMap((email) => signals.get(email.id)?.conflictKeys ?? [])
        .filter((key) => key.startsWith(prefix)),
    )
    const rightKeys = new Set(
      right
        .flatMap((email) => signals.get(email.id)?.conflictKeys ?? [])
        .filter((key) => key.startsWith(prefix)),
    )
    if (
      leftKeys.size > 0 &&
      rightKeys.size > 0 &&
      ![...leftKeys].some((key) => rightKeys.has(key))
    ) {
      return true
    }
  }
  return false
}

function fallbackMetadata(
  members: readonly ReviewEmailSummary[],
  signals: Map<string, BundleSignals>,
) {
  const latest = [...members].sort(
    (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
  )[0]
  if (!latest) throw new Error('Cannot describe an empty bundle')
  const providers = unique(members.map((member) => signals.get(member.id)?.provider ?? 'E-Mail'))
  const latestText = normalized(`${latest.subject} ${latest.preview}`)
  const currentState = /success|successful|healthy|erfolgreich|zugestellt|delivered/.test(
    latestText,
  )
    ? 'Erfolgreich'
    : /fail|failed|error|fehler|fehlgeschlagen/.test(latestText)
      ? 'Fehlgeschlagen'
      : members.length === 1
        ? 'Einzelne Nachricht'
        : 'Letzter Stand'
  return {
    currentState,
    kind: defaultKind(providers),
    linkEvidence: unique(
      members
        .flatMap((member) => signals.get(member.id)?.exactKeys ?? [])
        .filter((key) => !key.startsWith('thread:')),
    ).slice(0, 12),
    membershipConfidence: members.length === 1 ? 1 : 0.98,
    summary:
      members.length === 1
        ? latest.preview || latest.subject
        : `${members.length} zusammengehörige Nachrichten von ${providers.join(' und ')}. Zuletzt: ${latest.preview || latest.subject}`,
    title: latest.subject || '(Kein Betreff)',
  }
}

function asBundle(
  members: readonly ReviewEmailSummary[],
  signals: Map<string, BundleSignals>,
  metadata?: Omit<BundleDecision, 'includedEmailIds'>,
): ReviewBundle {
  const ordered = [...members].sort(
    (left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt),
  )
  const resolved = metadata ?? fallbackMetadata(ordered, signals)
  return {
    bundleId: randomUUID(),
    ...resolved,
    emailIds: ordered.map((email) => email.id),
    timeline: ordered.map((email) => ({
      emailId: email.id,
      event: email.subject || '(Kein Betreff)',
      occurredAt: email.receivedAt,
      source: signals.get(email.id)?.provider ?? 'E-Mail',
    })),
  }
}

export function singletonBundleRun(
  snapshotId: string,
  emails: readonly ReviewEmailSummary[],
  options: BuildReviewBundlesOptions = {},
) {
  options.signal?.throwIfAborted()
  const progress = bundleProgressReporter(emails.length, options, 'fallback')
  const signals = new Map<string, BundleSignals>()
  for (const email of emails) {
    options.signal?.throwIfAborted()
    signals.set(email.id, extractBundleSignals(email))
  }
  const run = {
    bundles: emails.map((email) => {
      options.signal?.throwIfAborted()
      return asBundle([email], signals)
    }),
    fallback: true,
    snapshotId,
  } satisfies ReviewBundleRun
  progress.emit('fallback', 0.95, emails.length, 'fallback')
  progress.emit('complete', 1, emails.length, 'fallback')
  return run
}

export function validateBundlePartition(
  snapshotIds: readonly string[],
  bundles: readonly Pick<ReviewBundle, 'emailIds'>[],
) {
  const expected = new Set(snapshotIds)
  const seen = new Set<string>()
  for (const bundle of bundles) {
    if (bundle.emailIds.length === 0) throw new Error('A bundle cannot be empty.')
    for (const id of bundle.emailIds) {
      if (!expected.has(id)) throw new Error(`Bundle contains an unknown snapshot ID: ${id}`)
      if (seen.has(id)) throw new Error(`Snapshot ID appears in more than one bundle: ${id}`)
      seen.add(id)
    }
  }
  if (seen.size !== expected.size)
    throw new Error('Bundle run does not cover the complete snapshot.')
}

export function validateBundleDecisionPartition(
  snapshotIds: readonly string[],
  decision: unknown,
): asserts decision is BundlePartitionDecision {
  validateBundlePartitionDecisionShape(decision)
  const expected = new Set(snapshotIds)
  if (expected.size !== snapshotIds.length) {
    throw new Error('The snapshot contains duplicate email IDs.')
  }
  const seen = new Set<string>()
  const include = (id: string) => {
    if (!expected.has(id)) {
      throw new Error(`Bundle partition contains an unknown snapshot ID: ${id}`)
    }
    if (seen.has(id)) {
      throw new Error(`Snapshot ID appears more than once in the bundle partition: ${id}`)
    }
    seen.add(id)
  }
  for (const story of decision.stories) {
    if (story.emailIds.length < 2) {
      throw new Error('A bundle partition story must contain at least two emails.')
    }
    for (const id of story.emailIds) include(id)
  }
  for (const id of decision.standaloneEmailIds) include(id)
  if (seen.size !== expected.size) {
    throw new Error('Bundle partition does not cover the complete snapshot.')
  }
}

const BUNDLE_KINDS = new Set<BundleKind>([
  'conversation',
  'development_workstream',
  'incident',
  'order_delivery',
  'standalone',
])

function boundedString(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`Bundle partition ${label} must be a string of at most ${maximum} characters.`)
  }
}

export function validateBundlePartitionDecisionShape(
  decision: unknown,
): asserts decision is BundlePartitionDecision {
  if (!decision || typeof decision !== 'object') {
    throw new Error('Bundle partition must be an object.')
  }
  const candidate = decision as Record<string, unknown>
  if (!Array.isArray(candidate.stories) || candidate.stories.length > 10_000) {
    throw new Error('Bundle partition stories must be an array of at most 10000 items.')
  }
  if (
    !Array.isArray(candidate.standaloneEmailIds) ||
    candidate.standaloneEmailIds.length > 10_000 ||
    candidate.standaloneEmailIds.some(
      (id) => typeof id !== 'string' || id.length === 0 || id.length > 512,
    )
  ) {
    throw new Error('Bundle partition standalone IDs are invalid.')
  }
  for (const story of candidate.stories) {
    if (!story || typeof story !== 'object') {
      throw new Error('Bundle partition story must be an object.')
    }
    const item = story as Record<string, unknown>
    if (
      !Array.isArray(item.emailIds) ||
      item.emailIds.length < 2 ||
      item.emailIds.length > 10_000 ||
      item.emailIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 512)
    ) {
      throw new Error('A bundle partition story must contain at least two emails with valid IDs.')
    }
    if (typeof item.kind !== 'string' || !BUNDLE_KINDS.has(item.kind as BundleKind)) {
      throw new Error('Bundle partition story kind is invalid.')
    }
    boundedString(item.title, 500, 'story title')
    boundedString(item.currentState, 500, 'story current state')
    boundedString(item.summary, 4_000, 'story summary')
    if (
      !Array.isArray(item.linkEvidence) ||
      item.linkEvidence.length > 100 ||
      item.linkEvidence.some((evidence) => typeof evidence !== 'string' || evidence.length > 500)
    ) {
      throw new Error('Bundle partition story evidence is invalid.')
    }
    if (
      typeof item.membershipConfidence !== 'number' ||
      !Number.isFinite(item.membershipConfidence) ||
      item.membershipConfidence < 0 ||
      item.membershipConfidence > 1
    ) {
      throw new Error('Bundle partition story confidence is invalid.')
    }
  }
}

export function normalizeBundleDecisionPartition(
  snapshotIds: readonly string[],
  decision: unknown,
): BundlePartitionDecision {
  validateBundlePartitionDecisionShape(decision)
  const expected = new Set(snapshotIds)
  if (expected.size !== snapshotIds.length) {
    throw new Error('The snapshot contains duplicate email IDs.')
  }
  for (const story of decision.stories) {
    for (const id of story.emailIds) {
      if (!expected.has(id)) {
        throw new Error(`Bundle partition contains an unknown snapshot ID: ${id}`)
      }
    }
  }
  for (const id of decision.standaloneEmailIds) {
    if (!expected.has(id)) {
      throw new Error(`Bundle partition contains an unknown snapshot ID: ${id}`)
    }
  }

  const winningStoryById = new Map<string, number>()
  for (const [storyIndex, story] of decision.stories.entries()) {
    for (const id of new Set(story.emailIds)) {
      const previousIndex = winningStoryById.get(id)
      if (
        previousIndex === undefined ||
        story.membershipConfidence >
          (decision.stories[previousIndex]?.membershipConfidence ?? Number.NEGATIVE_INFINITY)
      ) {
        winningStoryById.set(id, storyIndex)
      }
    }
  }

  const claimedStoryIds = new Set<string>()
  const stories = decision.stories.flatMap((story, storyIndex) => {
    const seen = new Set<string>()
    const emailIds = story.emailIds.filter((id) => {
      if (seen.has(id) || winningStoryById.get(id) !== storyIndex) return false
      seen.add(id)
      return true
    })
    if (emailIds.length < 2) return []
    for (const id of emailIds) claimedStoryIds.add(id)
    return [
      {
        currentState: story.currentState,
        emailIds,
        kind: story.kind,
        linkEvidence: [...story.linkEvidence],
        membershipConfidence: story.membershipConfidence,
        summary: story.summary,
        title: story.title,
      },
    ]
  })
  const normalized = {
    standaloneEmailIds: snapshotIds.filter((id) => !claimedStoryIds.has(id)),
    stories,
  } satisfies BundlePartitionDecision
  validateBundleDecisionPartition(snapshotIds, normalized)
  return normalized
}

function stableId(ids: readonly string[]) {
  return createHash('sha256').update(ids.join('\0')).digest('hex').slice(0, 16)
}

export async function buildReviewBundlesFromPartition(
  snapshotId: string,
  emails: readonly ReviewEmailSummary[],
  decidePartition: DecideBundlePartition,
  examples: readonly BundleExample[] = [],
  options: BuildReviewBundlesOptions = {},
): Promise<ReviewBundleRun> {
  const progress = bundleProgressReporter(emails.length, options, 'codex')
  options.signal?.throwIfAborted()
  progress.emit('indexing', 0, 0)
  if (emails.length === 0) {
    progress.emit('complete', 1, 0)
    return { bundles: [], fallback: false, snapshotId }
  }

  const snapshotIds = emails.map((email) => email.id)
  if (new Set(snapshotIds).size !== snapshotIds.length) {
    throw new Error('The snapshot contains duplicate email IDs.')
  }
  const signals = new Map<string, BundleSignals>()
  const ordinalById = new Map<string, number>()
  for (const [ordinal, email] of emails.entries()) {
    options.signal?.throwIfAborted()
    signals.set(email.id, {
      conflictKeys: [],
      exactKeys: [],
      provider: providerFor(email),
      searchTerms: [],
    })
    ordinalById.set(email.id, ordinal)
  }

  progress.codexCallStarted()
  progress.emit('deciding', 0.15, 0)
  const decision = await decidePartition(
    { emails: [...emails], examples: [...examples] },
    options.signal,
  )
  options.signal?.throwIfAborted()
  validateBundleDecisionPartition(snapshotIds, decision)
  progress.emit('reconciling', 0.85, emails.length)

  const groups: Array<{
    ids: Set<string>
    metadata?: Omit<BundleDecision, 'includedEmailIds'>
  }> = [
    ...decision.stories.map((story) => ({
      ids: new Set(story.emailIds),
      metadata: {
        currentState: story.currentState,
        kind: story.kind,
        linkEvidence: [...story.linkEvidence],
        membershipConfidence: story.membershipConfidence,
        summary: story.summary,
        title: story.title,
      } satisfies Omit<BundleDecision, 'includedEmailIds'>,
    })),
    ...decision.standaloneEmailIds.map((id) => ({ ids: new Set([id]) })),
  ].sort((left, right) => {
    const firstOrdinal = (ids: ReadonlySet<string>) =>
      Math.min(...[...ids].map((id) => ordinalById.get(id) ?? Number.POSITIVE_INFINITY))
    return firstOrdinal(left.ids) - firstOrdinal(right.ids)
  })

  const bundles = groups.map((group) => {
    options.signal?.throwIfAborted()
    const members = emails.filter((email) => group.ids.has(email.id))
    const bundle = asBundle(members, signals, group.metadata)
    bundle.bundleId = `bundle-${stableId(bundle.emailIds)}`
    return bundle
  })
  progress.emit('finalizing', 0.95, emails.length)
  validateBundlePartition(snapshotIds, bundles)
  options.signal?.throwIfAborted()
  progress.emit('complete', 1, emails.length)
  return { bundles, fallback: false, snapshotId }
}

function representativeEmails(emails: readonly ReviewEmailSummary[], maximum = 24) {
  if (maximum <= 1) {
    const latest = [...emails].sort(
      (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
    )[0]
    return latest ? [latest] : []
  }
  if (emails.length <= maximum) return [...emails]
  const ordered = [...emails].sort(
    (left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt),
  )
  const selected = new Map<string, ReviewEmailSummary>()
  for (const email of [ordered[0], ordered.at(-1)]) {
    if (email) selected.set(email.id, email)
  }
  const stride = (ordered.length - 1) / (maximum - 1)
  for (let index = 0; index < maximum; index += 1) {
    const email = ordered[Math.round(index * stride)]
    if (email) selected.set(email.id, email)
  }
  return [...selected.values()].slice(0, maximum)
}

function receivedAtRange(emails: readonly ReviewEmailSummary[]) {
  const timestamps = emails
    .map((email) => Date.parse(email.receivedAt))
    .filter((timestamp) => Number.isFinite(timestamp))
  if (timestamps.length === 0) return undefined
  return { maximum: Math.max(...timestamps), minimum: Math.min(...timestamps) }
}

function rangeDistance(
  left: { maximum: number; minimum: number },
  right: { maximum: number; minimum: number },
) {
  if (left.maximum < right.minimum) return right.minimum - left.maximum
  if (right.maximum < left.minimum) return left.minimum - right.maximum
  return 0
}

function crossSourceRecallByRoot(
  membersByRoot: ReadonlyMap<string, readonly ReviewEmailSummary[]>,
  signals: Map<string, BundleSignals>,
  signal?: AbortSignal,
) {
  const entries = [...membersByRoot]
    .flatMap(([root, members]) => {
      const range = receivedAtRange(members)
      if (!range) return []
      return [
        {
          anchor: range.minimum + (range.maximum - range.minimum) / 2,
          providers: unique(
            members.map((email) => signals.get(email.id)?.provider ?? 'E-Mail'),
          ).sort(),
          range,
          root,
        },
      ]
    })
    .sort((left, right) => left.anchor - right.anchor || left.root.localeCompare(right.root))
  const recall = new Map<string, string[]>()
  for (let seedIndex = 0; seedIndex < entries.length; seedIndex += 1) {
    signal?.throwIfAborted()
    const seed = entries[seedIndex]
    if (!seed) continue
    const seedProviders = new Set(seed.providers)
    const firstNeighbor = Math.max(0, seedIndex - MAX_CROSS_SOURCE_TEMPORAL_NEIGHBORS)
    const lastNeighbor = Math.min(
      entries.length,
      seedIndex + MAX_CROSS_SOURCE_TEMPORAL_NEIGHBORS + 1,
    )
    const ranked = entries
      .slice(firstNeighbor, lastNeighbor)
      .filter((candidate) => candidate.root !== seed.root)
      .flatMap((candidate) => {
        const providers = candidate.providers.filter((provider) => !seedProviders.has(provider))
        if (providers.length === 0) return []
        const distance = rangeDistance(seed.range, candidate.range)
        if (distance > CROSS_SOURCE_RECALL_WINDOW_MS) return []
        return [{ distance, providers, root: candidate.root }]
      })
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          left.providers[0]?.localeCompare(right.providers[0] ?? '') ||
          left.root.localeCompare(right.root),
      )

    const selected: string[] = []
    const selectedRoots = new Set<string>()
    const representedProviders = new Set<string>()
    for (const candidate of ranked) {
      if (selected.length >= MAX_CROSS_SOURCE_RECALL_ROOTS) break
      if (candidate.providers.every((provider) => representedProviders.has(provider))) continue
      selected.push(candidate.root)
      selectedRoots.add(candidate.root)
      for (const provider of candidate.providers) representedProviders.add(provider)
    }
    for (const candidate of ranked) {
      if (selected.length >= MAX_CROSS_SOURCE_RECALL_ROOTS) break
      if (selectedRoots.has(candidate.root)) continue
      selected.push(candidate.root)
    }
    recall.set(seed.root, selected)
  }
  return recall
}

export async function buildReviewBundles(
  snapshotId: string,
  emails: readonly ReviewEmailSummary[],
  decide?: DecideBundle,
  examples: readonly BundleExample[] = [],
  options: BuildReviewBundlesOptions = {},
): Promise<ReviewBundleRun> {
  const hasDecider = Boolean(decide || options.decideBatch)
  const progress = bundleProgressReporter(
    emails.length,
    options,
    hasDecider ? 'codex' : 'heuristic',
  )
  options.signal?.throwIfAborted()
  progress.emit('indexing', 0, 0)
  if (emails.length === 0) {
    progress.emit('complete', 1, 0)
    return { bundles: [], fallback: false, snapshotId }
  }
  const byId = new Map<string, ReviewEmailSummary>()
  const signals = new Map<string, BundleSignals>()
  for (const email of emails) {
    options.signal?.throwIfAborted()
    byId.set(email.id, email)
    signals.set(email.id, extractBundleSignals(email))
  }
  const union = new UnionFind()
  const keyOwners = new Map<string, string>()
  for (const email of emails) {
    options.signal?.throwIfAborted()
    union.add(email.id)
    for (const key of signals.get(email.id)?.exactKeys ?? []) {
      const owner = keyOwners.get(key)
      const ownerEmail = owner ? byId.get(owner) : undefined
      if (owner && ownerEmail && !hardConflict([ownerEmail], [email], signals)) {
        union.join(owner, email.id)
      } else keyOwners.set(key, email.id)
    }
  }
  progress.emit('grouping', 0.1, 0)
  const lexicalIndex = ftsCandidates(emails, signals, options.signal)
  try {
    const open = new Set(emails.map((email) => union.find(email.id)))
    const initialMembersByRoot = new Map<string, ReviewEmailSummary[]>()
    for (const email of emails) {
      const root = union.find(email.id)
      const members = initialMembersByRoot.get(root) ?? []
      members.push(email)
      initialMembersByRoot.set(root, members)
    }
    const crossSourceRecall = crossSourceRecallByRoot(initialMembersByRoot, signals, options.signal)
    const membersFor = (root: string) =>
      emails.filter((email) => open.has(root) && union.find(email.id) === root)
    const bundles: ReviewBundle[] = []
    const analyzedRoots = new Set<string>()
    const consideredRoots = new Map<string, Set<string>>()
    const metadataByRoot = new Map<string, Omit<BundleDecision, 'includedEmailIds'>>()
    let processedEmailCount = 0

    const analysisProgress = () => 0.15 + (0.75 * processedEmailCount) / Math.max(1, emails.length)

    progress.emit('grouping', analysisProgress(), processedEmailCount)

    const finalize = (seedRoot: string, metadata?: Omit<BundleDecision, 'includedEmailIds'>) => {
      const members = emails.filter((email) => union.find(email.id) === union.find(seedRoot))
      open.delete(seedRoot)
      const bundle = asBundle(members, signals, metadata)
      bundle.bundleId = `bundle-${stableId(bundle.emailIds)}`
      bundles.push(bundle)
      processedEmailCount += bundle.emailIds.length
      progress.emit('grouping', analysisProgress(), processedEmailCount)
    }

    while (open.size > 0) {
      options.signal?.throwIfAborted()
      const reserved = new Set<string>()
      const deferred = new Set<string>()
      const cohortRoots = new Map<string, { candidateRoots: string[]; seedRoot: string }>()
      const cohorts: BundleDecisionCohort[] = []

      while (cohorts.length < MAX_BATCH_COHORTS) {
        options.signal?.throwIfAborted()
        const seedRoot = [...open].find((root) => !reserved.has(root) && !deferred.has(root))
        if (!seedRoot) break
        const seed = membersFor(seedRoot)
        const candidateIds = lexicalIndex
          .find(
            seed.map((email) => email.id),
            new Set(seed.map((email) => email.id)),
            options.signal,
          )
          .filter((id) => open.has(union.find(id)))
        const considered = consideredRoots.get(seedRoot) ?? new Set<string>()
        const eligible = (root: string) => {
          if (root === seedRoot) return false
          if (considered.has(root)) return false
          return !hardConflict(seed, membersFor(root), signals)
        }
        const lexicalRoots = unique(candidateIds.map((id) => union.find(id))).filter(eligible)
        const recallRoots = unique(
          (crossSourceRecall.get(seedRoot) ?? []).map((root) => union.find(root)),
        )
          .filter((root) => open.has(root))
          .filter(eligible)
        const eligibleRoots = unique([...lexicalRoots, ...recallRoots])
        if (recallRoots.some((root) => reserved.has(root))) {
          deferred.add(seedRoot)
          continue
        }
        const recalledCandidateRoots = recallRoots
        const recalled = new Set(recalledCandidateRoots)
        const lexicalCandidateRoots = lexicalRoots.filter(
          (root) => !reserved.has(root) && !recalled.has(root),
        )
        const candidateRoots = [
          ...lexicalCandidateRoots.slice(
            0,
            MAX_CANDIDATE_ROOTS_PER_COHORT - recalledCandidateRoots.length,
          ),
          ...recalledCandidateRoots,
        ]

        if (!hasDecider) {
          finalize(seedRoot)
          continue
        }
        if (eligibleRoots.length === 0 && analyzedRoots.has(seedRoot)) {
          finalize(seedRoot, metadataByRoot.get(seedRoot))
          continue
        }
        if (eligibleRoots.length > 0 && candidateRoots.length === 0) {
          deferred.add(seedRoot)
          continue
        }

        reserved.add(seedRoot)
        for (const root of candidateRoots) reserved.add(root)
        const candidatesPerRoot = Math.max(1, Math.floor(24 / Math.max(1, candidateRoots.length)))
        const candidates = candidateRoots.flatMap((root) =>
          representativeEmails(membersFor(root), candidatesPerRoot),
        )
        const cohortId = `cohort-${stableId(seed.map((email) => email.id))}-${stableId(
          candidates.map((email) => email.id),
        )}`
        cohortRoots.set(cohortId, { candidateRoots, seedRoot })
        cohorts.push({
          candidates,
          cohortId,
          examples: selectBundleExamples(examples, learningSignalsFor([...seed, ...candidates])),
          seed: representativeEmails(seed),
        })
      }

      if (cohorts.length === 0) continue
      options.signal?.throwIfAborted()
      progress.emit('deciding', analysisProgress(), processedEmailCount)
      let decisions: BundleDecisionResult[]
      if (options.decideBatch) {
        progress.codexCallStarted()
        decisions = await options.decideBatch(cohorts, options.signal)
      } else {
        if (!decide) throw new Error('Bundle analysis has no decision provider.')
        decisions = []
        for (const cohort of cohorts) {
          options.signal?.throwIfAborted()
          progress.codexCallStarted()
          const decision = await decide(cohort, options.signal)
          decisions.push({ ...decision, cohortId: cohort.cohortId })
        }
      }
      options.signal?.throwIfAborted()

      const decisionsByCohort = new Map<string, BundleDecisionResult>()
      for (const decision of decisions) {
        if (!cohortRoots.has(decision.cohortId) || decisionsByCohort.has(decision.cohortId)) {
          throw new Error('Bundle batch decision contains an unknown or duplicate cohort ID.')
        }
        decisionsByCohort.set(decision.cohortId, decision)
      }
      if (decisionsByCohort.size !== cohorts.length) {
        throw new Error('Bundle batch decision does not cover every cohort.')
      }

      for (const cohort of cohorts) {
        options.signal?.throwIfAborted()
        const roots = cohortRoots.get(cohort.cohortId)
        const decision = decisionsByCohort.get(cohort.cohortId)
        if (!roots || !decision) throw new Error('Bundle cohort disappeared before finalization.')
        assertBundleDecisionCandidateMembership(cohort.candidates, decision.includedEmailIds)
        const acceptedRoots = new Set(decision.includedEmailIds.map((id) => union.find(id)))
        const considered = consideredRoots.get(roots.seedRoot) ?? new Set<string>()
        for (const root of roots.candidateRoots) considered.add(root)
        consideredRoots.set(roots.seedRoot, considered)
        for (const root of acceptedRoots) {
          if (!roots.candidateRoots.includes(root) || !open.has(root)) {
            throw new Error('Bundle decision contains a candidate that is no longer open.')
          }
          for (const member of membersFor(root)) union.join(roots.seedRoot, member.id)
          open.delete(root)
        }
        analyzedRoots.add(roots.seedRoot)
        metadataByRoot.set(roots.seedRoot, {
          currentState: decision.currentState,
          kind: decision.kind,
          linkEvidence: decision.linkEvidence,
          membershipConfidence: decision.membershipConfidence,
          summary: decision.summary,
          title: decision.title,
        })
      }
    }

    options.signal?.throwIfAborted()
    progress.emit('finalizing', 0.95, processedEmailCount)
    validateBundlePartition(
      emails.map((email) => email.id),
      bundles,
    )
    progress.emit('complete', 1, emails.length)
    return { bundles, fallback: false, snapshotId }
  } finally {
    lexicalIndex.close()
  }
}
