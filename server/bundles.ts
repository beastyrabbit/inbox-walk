import { createHash, randomUUID } from 'node:crypto'
import type {
  BundleKind,
  ReviewBundle,
  ReviewBundleRun,
  ReviewEmailSummary,
} from '../src/shared.ts'

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

export type BundleStoryMetadata = Omit<BundlePartitionStory, 'emailIds'>

export type DecideBundlePartition = (
  input: BundlePartitionInput,
  signal?: AbortSignal,
) => Promise<BundlePartitionDecision>

export type BundleAnalysisEngine = 'codex' | 'heuristic'

export type BundleBuildPhase = 'indexing' | 'deciding' | 'reconciling' | 'finalizing' | 'complete'

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
  engine?: BundleAnalysisEngine
  getCodexCallCount?: () => number
  model?: string
  onProgress?: (progress: BundleBuildProgress) => void
  signal?: AbortSignal
}

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

function heuristicMetadata(
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
  metadata?: BundleStoryMetadata,
): ReviewBundle {
  const ordered = [...members].sort(
    (left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt),
  )
  const resolved = metadata ?? heuristicMetadata(ordered, signals)
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
  validateBundlePartitionDecisionShape(decision, snapshotIds.length)
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
  maximum = Number.MAX_SAFE_INTEGER,
): asserts decision is BundlePartitionDecision {
  if (!decision || typeof decision !== 'object') {
    throw new Error('Bundle partition must be an object.')
  }
  const candidate = decision as Record<string, unknown>
  if (!Array.isArray(candidate.stories) || candidate.stories.length > maximum) {
    throw new Error('Bundle partition stories exceed the snapshot size or are not an array.')
  }
  if (
    !Array.isArray(candidate.standaloneEmailIds) ||
    candidate.standaloneEmailIds.length > maximum ||
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
      item.emailIds.length > maximum ||
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
  validateBundlePartitionDecisionShape(decision, snapshotIds.length)
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
  const emailById = new Map(emails.map((email) => [email.id, email]))
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

  if ((options.engine ?? 'codex') === 'codex') progress.codexCallStarted()
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
    metadata?: BundleStoryMetadata
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
      } satisfies BundleStoryMetadata,
    })),
    ...decision.standaloneEmailIds.map((id) => ({ ids: new Set([id]) })),
  ].sort((left, right) => {
    const firstOrdinal = (ids: ReadonlySet<string>) =>
      [...ids].reduce(
        (first, id) => Math.min(first, ordinalById.get(id) ?? Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      )
    return firstOrdinal(left.ids) - firstOrdinal(right.ids)
  })

  const bundles = groups.map((group) => {
    options.signal?.throwIfAborted()
    const members = [...group.ids]
      .sort((left, right) => (ordinalById.get(left) ?? 0) - (ordinalById.get(right) ?? 0))
      .map((id) => emailById.get(id) as ReviewEmailSummary)
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

/**
 * Local grouping for demo mode: joins messages that share an exact identifier
 * such as a thread, order, tracking, pull request or commit key, unless a
 * conflicting repository or order key keeps them apart. No provider is called.
 */
export function heuristicBundlePartition(
  emails: readonly ReviewEmailSummary[],
): BundlePartitionDecision {
  const byId = new Map<string, ReviewEmailSummary>()
  const signals = new Map<string, BundleSignals>()
  for (const email of emails) {
    byId.set(email.id, email)
    signals.set(email.id, extractBundleSignals(email))
  }
  const union = new UnionFind()
  const keyOwners = new Map<string, string>()
  for (const email of emails) {
    union.add(email.id)
    for (const key of signals.get(email.id)?.exactKeys ?? []) {
      const owner = keyOwners.get(key)
      const ownerEmail = owner ? byId.get(owner) : undefined
      if (owner && ownerEmail && !hardConflict([ownerEmail], [email], signals)) {
        union.join(owner, email.id)
      } else keyOwners.set(key, email.id)
    }
  }
  const membersByRoot = new Map<string, ReviewEmailSummary[]>()
  for (const email of emails) {
    const root = union.find(email.id)
    const members = membersByRoot.get(root) ?? []
    members.push(email)
    membersByRoot.set(root, members)
  }
  const standaloneEmailIds: string[] = []
  const stories: BundlePartitionStory[] = []
  for (const members of membersByRoot.values()) {
    if (members.length < 2) {
      for (const member of members) standaloneEmailIds.push(member.id)
      continue
    }
    stories.push({
      ...heuristicMetadata(members, signals),
      emailIds: members.map((member) => member.id),
    })
  }
  return { standaloneEmailIds, stories }
}
