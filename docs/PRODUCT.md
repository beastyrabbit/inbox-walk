# Product behavior

Inbox Walk is a focused personal mail-review tool, not a replacement for the
Fastmail interface. It turns unread incoming mail into a linear reading session
and makes every mailbox mutation explicit and recoverable.

## Review contract

1. Configure a new round before mail is loaded, explicitly choosing either Spam only or everything except Spam.
2. Query a stable, bounded snapshot of matching unread, non-draft incoming mail.
3. Keep only summaries in the initial payload and load bodies on demand.
4. Store snapshot IDs, filters, decisions, and reply editor state in the browser checkpoint.
5. Record only message IDs deliberately kept unread at finalization in a server-side SQLite history, and exclude them only when the user chooses that option.
6. Let the user move backward or forward and protect any message as unread.
7. Show the exact final counts before changing Fastmail.
8. Mark only unprotected snapshot IDs as read; newer mail remains untouched.
9. Report and retry partial failures without repeating successful changes.
10. In a Spam review, move messages marked “Not Spam” from Spam to Inbox only after confirmation.
11. For normal reviews, add the `Newsletter abmelden` Fastmail label after confirmation; never contact an unsubscribe endpoint automatically.

If a body cannot be loaded, that message is protected as unread automatically.

## Reply contract

1. Load every message in the selected Fastmail thread, up to the safety bound.
2. Compute reply-all recipients and the matching Fastmail sender identity.
3. Send every supported image to Codex and every supported document to Apache Tika for complete text extraction.
4. Fail closed if any attachment cannot be processed or the combined budget is too large.
5. Generate editable plain text from rough notes using only thread-supported facts.
6. Allow direct edits and repeated correction instructions.
7. Add the selected Fastmail signature and create a normal JMAP draft.
8. Read the draft back and verify its recipients, subject, thread, and body.

There is deliberately no `EmailSubmission/set`, SMTP integration, send endpoint,
or send button. A finished draft must be reviewed and sent from Fastmail.

## Privacy and safety

- The Fastmail credential is a backend-only runtime secret; rotating Codex OAuth data stays on the private app volume.
- The retained-unread database stores Fastmail IDs and retention metadata only, never message content or address metadata.
- Mail HTML is sanitized and isolated in a sandboxed iframe.
- External images are fetched through a bounded, type-checked backend proxy; the mail document never contacts remote senders directly.
- Blob downloads are allowlisted from server-owned snapshot metadata.
- POST mutations require same-origin checks and a snapshot CSRF token.
- Codex uses the ChatGPT subscription OAuth provider in a fresh in-memory session per request.
- Built-in tools, skills, extensions, prompts, themes, and project context are disabled; the model receives only one schema-constrained reply-submit tool.
- Message content and attachments are treated as untrusted data, never as instructions.

The app is intended for a single user behind Pangolin SSO in the Heerlab
homelab. Security is pragmatic for that boundary, while credentials and mail
content still receive normal application-level protection.
