# Product behavior

Inbox Walk is a focused personal mail-review tool, not a replacement for the
Fastmail interface. It turns unread incoming mail into a linear reading session
and makes every mailbox mutation explicit and recoverable.

## Review contract

1. Query a stable, bounded snapshot of unread, non-draft incoming mail.
2. Keep only summaries in the initial payload and load bodies on demand.
3. Store only snapshot IDs, filters, decisions, and reply editor state locally.
4. Let the user move backward or forward and protect any message as unread.
5. Show the exact final counts before changing Fastmail.
6. Mark only unprotected snapshot IDs as read; newer mail remains untouched.
7. Report and retry partial failures without repeating successful changes.

If a body cannot be loaded, that message is protected as unread automatically.

## Reply contract

1. Load every message in the selected Fastmail thread, up to the safety bound.
2. Compute reply-all recipients and the matching Fastmail sender identity.
3. Automatically send every supported inline and regular attachment to OpenAI.
4. Fail closed if any attachment cannot be processed or the combined budget is too large.
5. Generate editable plain text from rough notes using only thread-supported facts.
6. Allow direct edits and repeated correction instructions.
7. Add the selected Fastmail signature and create a normal JMAP draft.
8. Read the draft back and verify its recipients, subject, thread, and body.

There is deliberately no `EmailSubmission/set`, SMTP integration, send endpoint,
or send button. A finished draft must be reviewed and sent from Fastmail.

## Privacy and safety

- Credentials are backend-only runtime environment variables.
- Mail HTML is sanitized and isolated in a sandboxed iframe.
- External images remain blocked until enabled for that message.
- Blob downloads are allowlisted from server-owned snapshot metadata.
- POST mutations require same-origin checks and a snapshot CSRF token.
- OpenAI requests use `store: false`, a privacy-preserving safety identifier, and structured output.
- Message content and attachments are treated as untrusted data, never as instructions.

The app is intended for a single user behind Pangolin SSO in the Heerlab
homelab. Security is pragmatic for that boundary, while credentials and mail
content still receive normal application-level protection.
