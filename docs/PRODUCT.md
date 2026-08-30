# Product behavior

Inbox Walk is a focused personal mail-review tool, not a replacement for the
Fastmail interface. It turns unread incoming mail into a linear reading session
and makes every mailbox mutation explicit and recoverable.

## Review contract

1. Configure a new round before mail is loaded, explicitly choosing either Spam only or everything except Spam.
2. Query a stable, bounded snapshot of matching unread, non-draft incoming mail.
3. Keep only summaries in the initial payload and load bodies on demand.
4. Store every round under a stable server-side ID and URL. The browser checkpoint contains only that opaque round pointer.
5. Persist summaries, bundle analysis, decisions, editor state, and finalization in SQLite, but never received bodies or attachment content.
6. Record deliberately kept-unread message IDs in a separate history and exclude them only when the user chooses that option.
7. Let the user move backward or forward and protect any message as unread.
8. Show the exact final counts before changing Fastmail.
9. Mark only unprotected snapshot IDs as read; newer mail remains untouched.
10. Report and retry partial failures without repeating successful changes.
11. In a Spam review, move messages marked “Not Spam” from Spam to Inbox only after confirmation.
12. For normal reviews, add the `Newsletter abmelden` Fastmail label after confirmation; never contact an unsubscribe endpoint automatically.

If a body cannot be loaded, that message is protected as unread automatically.

## Bundle analysis contract

1. Create and persist the frozen round, Codex model, and hashed learning-example corpus before analysis starts.
2. Use exact identifiers and a local full-text index to find plausible related messages.
3. If Codex was connected when the round started, send only summary fields for those candidates: ID, subject, preview, time, sender, and thread ID.
4. Save every completed Codex decision before moving to the next one. Resume from those decisions after a process restart.
5. Never rerun a finished analysis. A browser reload only reads its stored status and result.
6. Keep later incoming mail outside the round. Analyze it in a new round.
7. Use the local analyzer when Codex is not connected before a new round starts. Do not silently downgrade a Codex run that was already in progress.
8. Freeze the configured Codex call limit with the round. Stop at that limit and use the safe fallback view.

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
- Round persistence stores mail summaries and review state, but never received bodies or attachment content. Retained-unread history remains ID-only.
- Mail HTML is sanitized and isolated in a sandboxed iframe.
- External images are fetched through a bounded, type-checked backend proxy; the mail document never contacts remote senders directly.
- Blob downloads are allowlisted from server-owned snapshot metadata and returned with `Cache-Control: no-store`.
- POST mutations require same-origin checks and a snapshot CSRF token.
- Codex uses the ChatGPT subscription OAuth provider in a fresh in-memory session per decision.
- Built-in tools, skills, extensions, prompts, themes, and project context are disabled; the model receives only one schema-constrained reply-submit tool.
- Message content and attachments are treated as untrusted data, never as instructions.

The app is intended for a single user behind Pangolin SSO in the Heerlab
homelab. Security is pragmatic for that boundary, while credentials and mail
content still receive normal application-level protection.
