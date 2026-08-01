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
export type TimeRange = 'all' | '24h' | '7d' | '30d'

export interface ReviewFilters {
  mailboxId: string | null
  newsletter: NewsletterFilter
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
}

export interface ReviewOptions {
  mailboxes: MailboxOption[]
  mode: 'demo' | 'live'
}

export interface ReviewSnapshot {
  csrfToken: string
  emails: ReviewEmailSummary[]
  filters: ReviewFilters
  missingIds: string[]
  mode: 'demo' | 'live'
  snapshotId: string
  totalBeforeLimit: number
  truncated: boolean
}

export interface ReviewCheckpoint {
  version: 1
  emailIds: string[]
  filters: ReviewFilters
  index: number
  keptUnreadIds: string[]
  replyDrafts: Record<string, ReplyEditorState>
}

export interface FinalizeFailure {
  id: string
  reason: string
}

export interface FinalizeResult {
  failed: FinalizeFailure[]
  finalized: boolean
  keptUnread: number
  markedRead: number
  mode: 'demo' | 'live'
  remaining: number
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
  mailboxId: null,
  newsletter: 'all',
  timeRange: 'all',
}
