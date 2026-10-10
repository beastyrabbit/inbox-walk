# User guide

Inbox Walk keeps unread incoming Fastmail messages in a small todo list. It
groups related messages into buckets and changes Fastmail only after an explicit
action.

## Start using the todo

Copy `.env.example` to `.env`, start the app, and connect Codex from
**Einstellungen** when sorting is needed. New unread messages appear as
unsorted entries. Codex groups them into buckets in the background; later mail
is picked up by the push connection or its poll fallback.

Open a bucket to read its messages. The reader keeps the original message
layout in a script-free sandbox. A message that cannot be loaded remains
unread.

## Finish or park messages

Press `E` or `ArrowRight` to complete the current bucket. Inbox Walk marks only
that bucket's shown message IDs read in Fastmail. Press `ArrowUp` to park a
message; it stays unread and leaves the todo until you bring it back. Press
`ArrowDown` on a newsletter to add the deferred unsubscribe label. Inbox Walk
never follows unsubscribe links.

## Draft a reply

Press `R` to open the reply editor. Inbox Walk loads the selected thread, sends
supported attachments through the configured extraction path, and fails closed
when an attachment cannot be processed. Review and edit the result before
saving it as a normal Fastmail draft. Inbox Walk has no send control; send from
Fastmail after checking the recipients, subject, and body.

## Keyboard controls

- `E` or `ArrowRight`: complete the current bucket
- `ArrowLeft` or `Escape`: return to the list or close the active panel
- `ArrowUp`: park the selected message
- `ArrowDown`: add the deferred newsletter label
- `R`: open the reply editor
- `?`: open keyboard help

## Privacy and access

Keep the live service behind authentication. The browser receives summaries
first and loads bodies and attachments only when requested. Persisted state does
not contain received bodies or attachment content. Never share a live service
URL or session outside the authenticated service.
