import type { BundleKind, ReviewEmailSummary } from '../src/shared.ts'

export interface BundleSignals {
  conflictKeys: string[]
  exactKeys: string[]
  provider: string
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
  const senders = email.from.map((item) => `${item.name ?? ''} ${item.email ?? ''}`).join(' ')
  const haystack = normalized(`${senders} ${email.subject}`)
  if (/github/.test(haystack)) return 'GitHub'
  if (/railway/.test(haystack)) return 'Railway'
  if (/amazon/.test(haystack)) return 'Amazon'
  if (/\bdhl\b/.test(haystack)) return 'DHL'
  if (/hermes/.test(haystack)) return 'Hermes'
  return email.from[0]?.name?.trim() || senderDomain(email) || 'E-Mail'
}

const TRAILING_PUNCTUATION = new Set([')', ',', '.', ';'])

function trimTrailingPunctuation(value: string) {
  let end = value.length
  while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1] ?? '')) end--
  return value.slice(0, end)
}

// Optional separator between a label and its identifier, e.g. " #: ".
const LABEL_SEPARATOR = String.raw`\s*(?:[#:-]+\s*)?`
const TRACKING_PATTERN = new RegExp(
  String.raw`\b(?:tracking|sendungs(?:nummer|nr\.?))${LABEL_SEPARATOR}([a-z0-9][a-z0-9-]{7,})\b`,
  'g',
)
const ORDER_LABEL = String.raw`\b(?:order|bestell(?:ung|nummer|nr\.?))(?:\s+(?:nr\.?|nummer))?`
const ORDER_PATTERN = new RegExp(
  String.raw`${ORDER_LABEL}${LABEL_SEPARATOR}([a-z0-9][a-z0-9-]{4,})\b`,
  'g',
)

function matches(text: string, pattern: RegExp, prefix: string) {
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match[1] && trimTrailingPunctuation(match[1]).toLowerCase()
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
  const tracking = matches(text, TRACKING_PATTERN, 'tracking')
  const orders = matches(text, ORDER_PATTERN, 'order').filter((key) =>
    /\d/.test(key.slice('order:'.length)),
  )
  const pullRequests = matches(text, /\b(?:pull request|pr)\s*(?:#\s*)?(\d{1,8})\b/g, 'pr')
  const exactKeys = unique([
    `thread:${email.threadId}`,
    ...deployments,
    ...tracking,
    ...orders,
    ...pullRequests.flatMap((pr) => repos.map((repo) => `${repo}|${pr}`)),
    ...commits.flatMap((commit) => repos.map((repo) => `${repo}|${commit}`)),
  ])
  return {
    conflictKeys: unique([...repos, ...tracking, ...orders]),
    exactKeys,
    provider: providerFor(email),
  }
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

function currentStateFor(latestText: string, memberCount: number) {
  if (/success|successful|healthy|erfolgreich|zugestellt|delivered/.test(latestText)) {
    return 'Erfolgreich'
  }
  if (/fail|failed|error|fehler|fehlgeschlagen/.test(latestText)) return 'Fehlgeschlagen'
  return memberCount === 1 ? 'Einzelne Nachricht' : 'Letzter Stand'
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
  return {
    currentState: currentStateFor(latestText, members.length),
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

/** Local story metadata derived from the newest member, without a provider. */
export function heuristicStoryMetadata(
  members: readonly ReviewEmailSummary[],
): BundleStoryMetadata {
  const signals = new Map(members.map((email) => [email.id, extractBundleSignals(email)]))
  return heuristicMetadata(members, signals)
}

/** True when two groups carry different repository or order identifiers. */
export function bundleGroupsConflict(
  left: readonly ReviewEmailSummary[],
  right: readonly ReviewEmailSummary[],
) {
  const signals = new Map(
    [...left, ...right].map((email) => [email.id, extractBundleSignals(email)]),
  )
  return hardConflict(left, right, signals)
}

/**
 * Local grouping for demo mode: joins messages that share an exact identifier
 * such as a thread, order, tracking, pull request or commit key, unless a
 * conflicting repository or order key keeps them apart. No provider is called.
 */
/** Joins messages that share an exact identifier unless a conflicting key keeps them apart. */
function joinByExactKeys(
  emails: readonly ReviewEmailSummary[],
  signals: Map<string, BundleSignals>,
) {
  const byId = new Map(emails.map((email) => [email.id, email]))
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
  return [...membersByRoot.values()]
}

export function heuristicBundlePartition(
  emails: readonly ReviewEmailSummary[],
): BundlePartitionDecision {
  const signals = new Map(emails.map((email) => [email.id, extractBundleSignals(email)]))
  const standaloneEmailIds: string[] = []
  const stories: BundlePartitionStory[] = []
  for (const members of joinByExactKeys(emails, signals)) {
    if (members.length < 2) {
      standaloneEmailIds.push(...members.map((member) => member.id))
      continue
    }
    stories.push({
      ...heuristicMetadata(members, signals),
      emailIds: members.map((member) => member.id),
    })
  }
  return { standaloneEmailIds, stories }
}
