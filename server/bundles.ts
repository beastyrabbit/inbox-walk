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

export type DecideBundle = (input: BundleDecisionInput) => Promise<BundleDecision>

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
  engine?: BundleAnalysisEngine
  getCodexCallCount?: () => number
  model?: string
  onProgress?: (progress: BundleBuildProgress) => void
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
  return email.from[0]?.email.split('@').at(-1)?.toLowerCase() ?? ''
}

function providerFor(email: ReviewEmailSummary) {
  const haystack = normalized(
    `${email.from.map((item) => `${item.name} ${item.email}`).join(' ')} ${email.subject}`,
  )
  if (/github/.test(haystack)) return 'GitHub'
  if (/railway/.test(haystack)) return 'Railway'
  if (/amazon/.test(haystack)) return 'Amazon'
  if (/\bdhl\b/.test(haystack)) return 'DHL'
  if (/hermes/.test(haystack)) return 'Hermes'
  return email.from[0]?.name.trim() || senderDomain(email) || 'E-Mail'
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
    /\b(?:order|bestell(?:ung|nummer|nr\.?))\s*[#:-]*\s*([a-z0-9][a-z0-9-]{4,})\b/g,
    'order',
  )
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

function ftsCandidates(emails: readonly ReviewEmailSummary[], signals: Map<string, BundleSignals>) {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE VIRTUAL TABLE mail_index USING fts5(email_id UNINDEXED, content)')
  const insert = database.prepare('INSERT INTO mail_index(email_id, content) VALUES (?, ?)')
  for (const email of emails) {
    insert.run(email.id, `${email.subject} ${email.preview}`)
  }
  const query = database.prepare(
    'SELECT email_id FROM mail_index WHERE mail_index MATCH ? ORDER BY bm25(mail_index) LIMIT 512 OFFSET ?',
  )
  const find = (emailIds: readonly string[], excluded: ReadonlySet<string>) => {
    const terms = unique(
      emailIds
        .flatMap((id) => signals.get(id)?.searchTerms ?? [])
        .filter((term) => term.length >= 4),
    ).slice(0, 12)
    if (terms.length === 0) return []
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const result: string[] = []
    let offset = 0
    while (true) {
      const page = query.all(expression, offset) as Array<{ email_id: string }>
      for (const row of page) {
        if (!excluded.has(row.email_id)) result.push(row.email_id)
      }
      if (page.length < 512) break
      offset += page.length
    }
    return unique(result)
  }
  return { close: () => database.close(), find }
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
  for (const prefix of ['repo:', 'order:', 'tracking:']) {
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
  const progress = bundleProgressReporter(emails.length, options, 'fallback')
  const signals = new Map(emails.map((email) => [email.id, extractBundleSignals(email)]))
  const run = {
    bundles: emails.map((email) => asBundle([email], signals)),
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

function stableId(ids: readonly string[]) {
  return createHash('sha256').update(ids.join('\0')).digest('hex').slice(0, 16)
}

function representativeEmails(emails: readonly ReviewEmailSummary[], maximum = 100) {
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

export async function buildReviewBundles(
  snapshotId: string,
  emails: readonly ReviewEmailSummary[],
  decide?: DecideBundle,
  examples: readonly BundleExample[] = [],
  options: BuildReviewBundlesOptions = {},
): Promise<ReviewBundleRun> {
  const progress = bundleProgressReporter(emails.length, options, decide ? 'codex' : 'heuristic')
  progress.emit('indexing', 0, 0)
  if (emails.length === 0) {
    progress.emit('complete', 1, 0)
    return { bundles: [], fallback: false, snapshotId }
  }
  const byId = new Map(emails.map((email) => [email.id, email]))
  const signals = new Map(emails.map((email) => [email.id, extractBundleSignals(email)]))
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
  progress.emit('grouping', 0.1, 0)
  const lexicalIndex = ftsCandidates(emails, signals)
  try {
    const open = new Set(emails.map((email) => union.find(email.id)))
    const membersFor = (root: string) =>
      emails.filter((email) => open.has(root) && union.find(email.id) === root)
    const bundles: ReviewBundle[] = []
    let processedEmailCount = 0

    const analysisProgress = () => 0.15 + (0.75 * processedEmailCount) / Math.max(1, emails.length)

    progress.emit('grouping', analysisProgress(), processedEmailCount)

    while (open.size > 0) {
      const seedRoot = [...open][0]
      if (!seedRoot) break
      let seed = membersFor(seedRoot)
      const excluded = new Set(seed.map((email) => email.id))
      const candidateIds = lexicalIndex
        .find(
          seed.map((email) => email.id),
          excluded,
        )
        .filter((id) => open.has(union.find(id)))
      const candidateRoots = unique(candidateIds.map((id) => union.find(id))).filter((root) => {
        if (root === seedRoot) return false
        return !hardConflict(seed, membersFor(root), signals)
      })
      let metadata: Omit<BundleDecision, 'includedEmailIds'> | undefined

      const judgeRootPages = async (
        roots: readonly string[],
        phase: Extract<BundleBuildPhase, 'deciding' | 'reconciling'> = 'deciding',
      ) => {
        if (!decide) return false
        let acceptedAny = false
        const pages =
          roots.length > 0 ? Array.from({ length: Math.ceil(roots.length / 100) }) : [null]
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
          const pageRoots = roots.slice(pageIndex * 100, (pageIndex + 1) * 100)
          const perRoot = Math.max(1, Math.floor(100 / Math.max(1, pageRoots.length)))
          const pageCandidates = pageRoots.flatMap((root) => membersFor(root).slice(0, perRoot))
          progress.codexCallStarted()
          progress.emit(phase, analysisProgress(), processedEmailCount)
          const decision = await decide({
            candidates: pageCandidates,
            examples: selectBundleExamples(
              examples,
              learningSignalsFor([...seed, ...pageCandidates]),
            ),
            seed: representativeEmails(seed),
          })
          const permitted = new Set(pageCandidates.map((email) => email.id))
          if (decision.includedEmailIds.some((id) => !permitted.has(id))) {
            throw new Error('Bundle decision contains an ID outside its candidate set.')
          }
          const acceptedRoots = new Set(decision.includedEmailIds.map((id) => union.find(id)))
          for (const root of acceptedRoots) {
            for (const member of membersFor(root)) union.join(seedRoot, member.id)
            open.delete(root)
          }
          acceptedAny ||= acceptedRoots.size > 0
          seed = emails.filter((email) => union.find(email.id) === union.find(seedRoot))
          metadata = {
            currentState: decision.currentState,
            kind: decision.kind,
            linkEvidence: decision.linkEvidence,
            membershipConfidence: decision.membershipConfidence,
            summary: decision.summary,
            title: decision.title,
          }
        }
        return acceptedAny
      }

      if (decide && (candidateRoots.length > 0 || seed.length > 1)) {
        await judgeRootPages(candidateRoots)

        // Reconcile once after accepted members expand the seed's vocabulary and exact signals.
        const alreadyConsidered = new Set(candidateRoots)
        const reconciledIds = lexicalIndex
          .find(
            seed.map((email) => email.id),
            new Set(seed.map((email) => email.id)),
          )
          .filter((id) => open.has(union.find(id)))
        const reconciledRoots = unique(reconciledIds.map((id) => union.find(id))).filter((root) => {
          if (root === seedRoot || alreadyConsidered.has(root)) return false
          return !hardConflict(seed, membersFor(root), signals)
        })
        if (reconciledRoots.length > 0) {
          await judgeRootPages(reconciledRoots, 'reconciling')
        }
      }
      open.delete(seedRoot)
      const bundle = asBundle(seed, signals, metadata)
      bundle.bundleId = `bundle-${stableId(bundle.emailIds)}`
      bundles.push(bundle)
      processedEmailCount += bundle.emailIds.length
      progress.emit('grouping', analysisProgress(), processedEmailCount)
    }

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
