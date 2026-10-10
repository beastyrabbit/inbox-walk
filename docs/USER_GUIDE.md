# User guide

Inbox Walk turns unread incoming mail into a review session. It freezes the matching mail when a round starts, groups related messages into stories, and changes Fastmail only after you confirm the result.

## Start a round

Choose whether to review normal mail or Spam. You can narrow the selection by mailbox, time range, newsletter status, and messages you deliberately kept unread before. Start the round and wait for analysis to finish. The round is a stable snapshot, so mail arriving later stays out of it.

Open a story to read its messages. Expand an original whenever you need the full context. A message that cannot be loaded stays unread automatically.

## Review and finish

Move through stories with the arrow keys or the on-screen controls. Mark individual originals to keep unread. Inbox Walk shows the final counts before it changes Fastmail. Confirming a normal review marks only unprotected snapshot messages read. Confirming a Spam review can move selected messages back to Inbox. Newsletter messages receive a deferred label; Inbox Walk never follows unsubscribe links.

The round closes when all stories are processed. You can reopen a stored round after a refresh or restart. Reanalysis starts a new analysis generation on the same frozen snapshot.

## Draft a reply

Press `R` on a story to open the reply editor. Inbox Walk loads the selected thread, includes supported attachments in the Codex request, and fails closed when an attachment cannot be processed. Review and edit the result before saving it as a normal Fastmail draft. Inbox Walk has no send control. Send from Fastmail after checking the recipients, subject, and body.

## Keyboard controls

- `ArrowRight` completes the current story.
- `ArrowLeft` moves to the previous story.
- `ArrowUp` toggles keep unread for the selected original.
- `ArrowDown` performs the deferred Spam or newsletter action.
- `R` opens the reply editor.
- `Escape` closes the active panel.
- `?` opens keyboard help.

## Privacy and access

Inbox Walk is intended for one authenticated user. Keep the live service behind an access gateway. The browser receives summaries first and loads bodies and attachments only when requested. Persisted review data does not contain received bodies or attachment content. Never share a live round URL outside the authenticated service.
