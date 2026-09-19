# Product behavior

Inbox Walk is a focused personal mail todo, not a replacement for the Fastmail
interface. It keeps unread incoming mail sorted into stories while you are away
and makes every mailbox mutation explicit and recoverable.

## Todo contract

1. Poll Fastmail for unread, non-draft incoming mail outside Spam about once a minute. Queue every new message with its summary only.
2. Drop a message from the todo when it is no longer unread in Fastmail, whatever changed it. Never re-queue a message this app marked done within the last two minutes.
3. Show queued messages as unsorted entries at the top until a bucket claims them. They can be opened, read, replied to, parked, and marked done like any other message.
4. A bucket is one real-world story. It is open while it has at least one sorted, unread member and closes on its own when the last member is done or parked. New mail that continues a closed story reopens it.
5. Marking a bucket done marks exactly its shown message IDs read in Fastmail, then records them as done. Nothing else is touched. Failures are reported per message and leave those messages in the todo.
6. Parking keeps a message unread and removes it from the todo. Fetching it back returns it to its bucket, or to the unsorted entries if the bucket is gone.
7. The newsletter action adds the `Newsletter abmelden` label; it never contacts an unsubscribe endpoint and does not change read state.
8. Reply editor state is stored per message and survives reloads. Drafts are created through JMAP and read back for verification. There is no send path.
9. Every user action needs the same-origin check and the todo CSRF token.

## Sorting contract

1. Only the sorter decides bucket membership. The app does not pre-group messages before Codex sees them, except in demo mode, where exact identifiers are grouped locally.
2. One sorting session covers up to eight new messages. It receives their summaries, the buckets active in the last 45 days with their members, and the user's memory note.
3. The session is isolated: no built-in tools, skills, extensions, prompts, themes, or project context. Its only tools are the read-only mailbox lookups, the bucket tools, the memory proposal, and `finish_triage`.
4. Read-only lookups are bounded to 30 per session and return summaries or bounded plain text. Nothing fetched for sorting is persisted.
5. Bucket tools only change this app's SQLite state. IDs outside the new batch or the open members are rejected. Every tool action is logged.
6. A transient failure or a session that leaves a message unassigned counts one attempt for the affected messages. After three attempts a message stops retrying automatically and shows a retry control.
7. An expired Codex login pauses sorting without counting attempts and shows a connect control. Sorting resumes on the next poll after login.
8. Memory proposals never take effect until the user accepts them in the settings.
9. Model, reasoning effort, and speed follow the Codex configuration at the time of each session.

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

- The Fastmail credential is a backend-only runtime secret; rotating Codex OAuth data stays on the private app volume or in the Codex home.
- Persistence stores mail summaries, bucket texts, todo state, editor state, notes and an action log, but never received bodies or attachment content.
- Mail HTML is sanitized and isolated in a sandboxed iframe.
- External images are fetched through a bounded, type-checked backend proxy; the mail document never contacts remote senders directly.
- Blob downloads are allowlisted from server-owned message metadata and returned with `Cache-Control: no-store`.
- Codex uses the ChatGPT subscription OAuth provider in a fresh in-memory session per sort and per reply.
- Message content, search results, and bucket texts are treated as untrusted data, never as instructions. The model cannot write to Fastmail.

The app is intended for a single user behind Pangolin SSO in the Heerlab
homelab. Security is pragmatic for that boundary, while credentials and mail
content still receive normal application-level protection.
