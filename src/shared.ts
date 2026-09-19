export interface MailAddress {
  name: string
  email: string
}

export interface MailResource {
  blobId: string
  cid?: string
  disposition?: string | null
  name: string
  type: string
  size: number
}

export interface MailboxOption {
  id: string
  name: string
  role?: string | null
}

export type NewsletterFilter = 'all' | 'exclude' | 'only'
export type SpamFilter = 'exclude' | 'only'
export type TimeRange = 'all' | '24h' | '7d' | '30d'

export interface ReviewFilters {
  hideReviewed: boolean
  mailboxId: string | null
  newsletter: NewsletterFilter
  spam: SpamFilter
  timeRange: TimeRange
}

export interface ReviewEmailSummary {
  id: string
  threadId: string
  subject: string
  receivedAt: string
  from: MailAddress[]
  to: MailAddress[]
  preview: string
  mailboxNames: string[]
  hasAttachment: boolean
  isNewsletter: boolean
}

export interface ReviewEmail extends ReviewEmailSummary {
  cc: MailAddress[]
  replyTo: MailAddress[]
  messageId: string[]
  inReplyTo: string[]
  references: string[]
  html: string | null
  text: string
  bodyTruncated: boolean
  inlineResources: MailResource[]
  attachments: MailResource[]
  remoteImageIds?: Record<string, string>
}

export const codexModels = [
  {
    description: 'Neuestes und stärkstes Modell.',
    id: 'gpt-6-astra',
    label: 'Astra',
  },
  {
    description: 'Gründlich bei schwierigen Zusammenhängen.',
    id: 'gpt-5.6-sol',
    label: 'Sol',
  },
  {
    description: 'Gute Balance für die tägliche Inbox.',
    id: 'gpt-5.6-terra',
    label: 'Terra',
  },
  {
    description: 'Am schnellsten für große Mengen.',
    id: 'gpt-5.6-luna',
    label: 'Luna',
  },
] as const

/** Any model slug Codex can be configured with; known slugs get a short label. */
export type CodexModelId = string

export function codexModelLabel(id: string | undefined) {
  if (!id) return undefined
  return codexModels.find((model) => model.id === id)?.label ?? id
}

export const codexThinkingLevels = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type CodexThinkingLevel = (typeof codexThinkingLevels)[number]

export function isCodexThinkingLevel(value: unknown): value is CodexThinkingLevel {
  return codexThinkingLevels.some((level) => level === value)
}

export const codexSpeeds = ['standard', 'fast'] as const

export type CodexSpeed = (typeof codexSpeeds)[number]

export function isCodexSpeed(value: unknown): value is CodexSpeed {
  return codexSpeeds.some((speed) => speed === value)
}

export function isCodexModelId(value: unknown): value is CodexModelId {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)
}

export type CodexSettingsSource = 'codex' | 'environment' | 'default'
export type CodexAuthSource = 'codex' | 'pi'

export interface CodexAuthStatus {
  configured: boolean
  model: CodexModelId
  modelLabel?: string
  thinkingLevel?: CodexThinkingLevel
  speed?: CodexSpeed
  authSource?: CodexAuthSource
  settingsSource?: CodexSettingsSource
  settingsPath?: string
  source?:
    | 'stored'
    | 'runtime'
    | 'environment'
    | 'fallback'
    | 'models_json_key'
    | 'models_json_command'
}

export interface CodexLoginState {
  id: string
  message: string
  status: 'starting' | 'waiting' | 'completed' | 'failed'
  url?: string
  userCode?: string
}

export type BundleKind =
  | 'development_workstream'
  | 'order_delivery'
  | 'incident'
  | 'conversation'
  | 'standalone'

export interface MailIdentity {
  id: string
  name: string
  email: string
  textSignature: string
  htmlSignature: string
}

export interface ReplyRecipients {
  identityId: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
}

export interface ThreadMessage extends ReviewEmail {
  sentAt: string | null
}

export interface ThreadContext {
  attachmentManifest: MailResource[]
  identities: MailIdentity[]
  messages: ThreadMessage[]
  recipients: ReplyRecipients
}

export interface ReplyProposal {
  attachmentManifest: MailResource[]
  bodyText: string
  questions: string[]
  requestId: string
  supportedDetails: Array<{ detail: string; sourceMessageIds: string[] }>
  warnings: string[]
}

export interface ReplyEditorState {
  bodyText: string
  cc: MailAddress[]
  ccText?: string
  draftRequestId?: string
  identityId: string
  revisionInstruction: string
  roughNotes: string
  subject: string
  to: MailAddress[]
  toText?: string
}

export interface DraftResult {
  draftId: string
  recovered: boolean
  threadId: string
  verified: boolean
}

export interface ApiError {
  error: {
    code: string
    message: string
    retryable: boolean
    details?: unknown
  }
}

export type TriageMessageStatus = 'queued' | 'sorted' | 'parked' | 'done' | 'gone'

export interface TriageMessage {
  /** Failed automatic sorting attempts; sorting pauses at the retry limit. */
  attempts: number
  bucketId: string | null
  lastError?: string
  status: TriageMessageStatus
  summary: ReviewEmailSummary
}

export interface TriageBucket {
  activityAt: string
  bucketId: string
  currentState: string
  /** Members already handled; kept so a reopened story shows its history size. */
  handledCount: number
  kind: BundleKind
  linkEvidence: string[]
  /** Open members in chronological order. */
  messages: TriageMessage[]
  summary: string
  title: string
  /** A message Codex has not sorted yet, shown as its own entry. */
  unsorted: boolean
}

export interface TriageStatus {
  engine: 'codex' | 'heuristic'
  /** Messages whose automatic sorting stopped at the retry limit. */
  failedCount: number
  lastPollAt: string | null
  lastPollError: string | null
  lastSortAt: string | null
  lastSortError: string | null
  model?: string
  polling: boolean
  queuedCount: number
  sorting: boolean
  waitingForCodex: boolean
}

export interface TriageMemoryProposal {
  createdAt: string
  id: string
  note: string
}

export interface TriageMemory {
  notes: string
  proposals: TriageMemoryProposal[]
}

export interface TriageSnapshot {
  buckets: TriageBucket[]
  codex: CodexAuthStatus
  csrfToken: string
  imageToken: string
  memory: TriageMemory
  mode: 'demo' | 'live'
  parked: TriageMessage[]
  status: TriageStatus
}

export interface TriageActionResult {
  failed: Array<{ id: string; reason: string }>
  snapshot: TriageSnapshot
}

export const TRIAGE_MAX_ATTEMPTS = 3
export const TRIAGE_MEMORY_MAX_LENGTH = 8_000
