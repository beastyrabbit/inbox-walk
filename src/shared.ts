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

export interface CodexAuthStatus {
  configured: boolean
  model: string
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
  csrfToken: string
  imageToken: string
  emails: ReviewEmailSummary[]
  filters: ReviewFilters
  missingIds: string[]
  mode: 'demo' | 'live'
  snapshotId: string
  totalBeforeLimit: number
  truncated: boolean
}

export interface ReviewCheckpoint {
  version: 5
  emailIds: string[]
  filters: ReviewFilters
  index: number
  keptUnreadIds: string[]
  processedIds: string[]
  secondaryActionIds: string[]
  replyDrafts: Record<string, ReplyEditorState>
}

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
  draftRequestId?: string
  identityId: string
  revisionInstruction: string
  roughNotes: string
  subject: string
  to: MailAddress[]
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
