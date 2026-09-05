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

export interface ReviewOptions {
  codex: CodexAuthStatus
  mailboxes: MailboxOption[]
  mode: 'demo' | 'live'
  reviewedCount: number
}

export const codexModels = [
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

export type CodexModelId = (typeof codexModels)[number]['id']

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

export function isCodexModelId(value: unknown): value is CodexModelId {
  return codexModels.some((model) => model.id === value)
}

export interface CodexAuthStatus {
  configured: boolean
  model: CodexModelId
  thinkingLevel?: CodexThinkingLevel
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

export interface ReviewSnapshot {
  analysis: ReviewAnalysisState
  bundleRun?: ReviewBundleRun
  csrfToken: string
  imageToken: string
  emails: ReviewEmailSummary[]
  finalization: ReviewFinalizationState
  filters: ReviewFilters
  missingIds: string[]
  mode: 'demo' | 'live'
  snapshotId: string
  totalBeforeLimit: number
  truncated: boolean
  userState: ReviewRoundUserState
}

export type ReviewRunStatus = 'queued' | 'fetching' | 'analyzing' | 'ready' | 'failed'

export interface ReviewRunSummary {
  analysis: ReviewAnalysisState
  createdAt: string
  csrfToken: string
  emailCount: number
  filters: ReviewFilters
  generation: number
  id: string
  mode: 'demo' | 'live'
  reanalyzable: boolean
  reviewStatus: 'active' | 'finalizing' | 'finalized'
  status: ReviewRunStatus
  updatedAt: string
}

export type ReviewAnalysisStatus = 'pending' | 'running' | 'complete'
export type ReviewAnalysisEngine = 'codex' | 'heuristic' | 'fallback'

export interface ReviewAnalysisState {
  callCount: number
  engine: ReviewAnalysisEngine
  error?: string
  model?: string
  thinkingLevel?: CodexThinkingLevel
  phase: string
  processedEmailCount: number
  progress: number
  status: ReviewAnalysisStatus
  totalEmailCount: number
}

export type BundleKind =
  | 'development_workstream'
  | 'order_delivery'
  | 'incident'
  | 'conversation'
  | 'standalone'

export interface ReviewBundleTimelineItem {
  emailId: string
  event: string
  occurredAt: string
  source: string
}

export interface ReviewBundle {
  bundleId: string
  currentState: string
  emailIds: string[]
  kind: BundleKind
  linkEvidence: string[]
  membershipConfidence: number
  summary: string
  timeline: ReviewBundleTimelineItem[]
  title: string
}

export interface ReviewBundleRun {
  bundles: ReviewBundle[]
  fallback: boolean
  snapshotId: string
}

export interface ReviewRoundUserState {
  bundleGroups: string[][]
  index: number
  keptUnreadIds: string[]
  processedIds: string[]
  revision: number
  secondaryActionIds: string[]
  selectedMemberId: string | null
  replyDrafts: Record<string, ReplyEditorState>
}

export interface ReviewCheckpoint {
  roundId: string
  version: 7
}

export interface LegacyReviewCheckpoint {
  version: 6
  bundleGroups: string[][]
  emailIds: string[]
  filters: ReviewFilters
  index: number
  keptUnreadIds: string[]
  processedIds: string[]
  secondaryActionIds: string[]
  replyDrafts: Record<string, ReplyEditorState>
  migrationRoundId?: string
}

export type LoadedReviewCheckpoint = ReviewCheckpoint | LegacyReviewCheckpoint

export interface FinalizeFailure {
  id: string
  reason: string
}

export interface FinalizeResult {
  actionFailed: FinalizeFailure[]
  failed: FinalizeFailure[]
  finalized: boolean
  keptUnread: number
  markedRead: number
  mode: 'demo' | 'live'
  processed: number
  remaining: number
  rescuedFromSpam: number
  taggedForUnsubscribe: number
  untouched: number
}

export interface ReviewFinalizationState {
  result: FinalizeResult | null
  selectionLocked: boolean
  status: 'active' | 'finalized' | 'finalizing'
}

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

export interface SupportedDetail {
  detail: string
  sourceMessageIds: string[]
}

export interface ReplyProposal {
  attachmentManifest: MailResource[]
  bodyText: string
  questions: string[]
  requestId: string
  supportedDetails: SupportedDetail[]
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

export const defaultReviewFilters: ReviewFilters = {
  hideReviewed: false,
  mailboxId: null,
  newsletter: 'all',
  spam: 'exclude',
  timeRange: 'all',
}
