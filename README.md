# Inbox Walk

Inbox Walk is a keyboard-first Fastmail todo list. It watches unread incoming
mail, lets Codex sort messages into buckets that represent real-world stories,
and changes read state only when you mark a bucket done.

For messages that need an answer, Inbox Walk prepares a thread-aware Fastmail
draft. It has no send endpoint or send control; sending remains in Fastmail.

## What it does

- Watches Fastmail through JMAP push with a poll fallback and queues new unread
  incoming messages outside Spam.
- Groups related messages into buckets while keeping every original available
  for inspection.
- Shows unsorted mail immediately and retries transient sorting failures.
- Marks exactly the shown bucket messages read when you complete a bucket.
- Parks a message so it stays unread and can return to the todo later.
- Adds a newsletter label for deferred unsubscribe work without following links.
- Sanitizes mail HTML in a script-free sandbox and proxies remote images safely.
- Prepares editable drafts with supported attachment extraction and fails closed
  when an attachment cannot be processed.
- Keeps bucket state, notes, and draft editor state in a local SQLite database.
- Exposes `/healthz` and `/readyz` for platform probes.

## Local development

Install dependencies and copy the example environment file:

```bash
pnpm install
cp .env.example .env
```

Run the safe demo mode:

```bash
MAIL_REVIEW_DEMO=1 pnpm dev
```

Open <http://localhost:5173>. Demo mode uses synthetic mail and never contacts
Fastmail or Codex. For live development, put a dedicated Fastmail token in
`.env`, start Apache Tika, and run `pnpm dev`:

```bash
docker run --rm --name inbox-walk-tika -p 9998:9998 apache/tika:3.3.1.0-full
pnpm dev
```

Connect Codex from **Einstellungen** when sorting or reply generation needs it.
Keep `.env`, OAuth files, databases, and production credentials out of Git.

## How sorting works

The app queues new messages in batches, sends summaries and the active buckets
to an isolated Codex session, and applies only the bucket changes returned by
that session. Mailbox lookups are read-only and bounded. Message content is
untrusted input. A failed message remains visible for retry; after repeated
failures it stops retrying automatically until you ask again.

The app stores summaries, bucket text, todo state, notes, and an action log. It
never stores received bodies or attachment content. Marking mail read, parking
mail, and adding the newsletter label require explicit browser actions.

## Keyboard controls

- `E` or `ArrowRight`: complete the current bucket
- `ArrowLeft` or `Escape`: return to the list or close the active panel
- `ArrowUp`: park the selected message
- `ArrowDown`: add the deferred newsletter label
- `R`: open the reply-draft panel
- `?`: keyboard help

## Quality gates

```bash
pnpm check
pnpm build
pnpm test:e2e
lefthook run pre-commit
```

See the [user guide](docs/USER_GUIDE.md), [developer guide](docs/DEVELOPER_GUIDE.md),
[product behavior](docs/PRODUCT.md), and [operations guide](docs/OPERATIONS.md)
for more detail.
