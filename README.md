# Inbox Walk

Inbox Walk is a private, keyboard-first Fastmail todo list. It watches your unread mail, lets Codex sort every new message into a bucket that stands for one real-world story, and changes read state only when you mark a bucket done.

## Highlights

- Nothing to start. New mail is picked up within a minute and sorted in the background.
- Every bucket shows all its messages at once, with the original mail design.
- Prepare a thread-aware Fastmail draft with Codex.
- Keep sending in Fastmail. Inbox Walk has no send endpoint.

## What it does

- Polls Fastmail over JMAP for unread incoming mail outside Spam and queues every new message.
- Sends each batch of new messages to Codex together with the open buckets and your notes. Codex may search the whole mailbox, read a thread or a message body, then creates a bucket, adds to one, merges two, or updates a title and state.
- Shows the todo as buckets ordered by newest activity. Messages that are not sorted yet appear on top and can be opened right away.
- Marks a bucket done with one key, which marks exactly its shown messages read in Fastmail and moves on to the next bucket.
- Parks a message: it stays unread in Fastmail, leaves the todo, and comes back when you fetch it.
- Adds the Fastmail label `Newsletter abmelden` for deferred unsubscribe work instead of contacting senders automatically.
- Drops messages you read or delete in Fastmail from the todo on the next poll.
- Retries a failed sort three times, then keeps the message visible as unsorted until you ask for another attempt.
- Keeps a memory note that you write in the settings. Codex reads it on every sort and may propose additions, which apply only after you accept them.
- Sanitizes mail HTML in a script-free sandboxed iframe, adapts it to the dark interface with an original-colours switch, and proxies remote images through the backend.
- Sends every supported image to Codex and extracts every supported document through Apache Tika for reply drafts, and blocks the draft if any attachment is unsupported or the 45 MiB budget is exceeded.
- Creates and reads back a normal Fastmail draft with reply headers and identity signature.
- Follows the model, reasoning effort, and speed configured in Codex without restarting the app.
- Exposes `/healthz` and `/readyz` for Kubernetes probes.

## Local development

Install dependencies, then start Apache Tika in a separate terminal:

```bash
pnpm install
docker run --rm --name inbox-walk-tika -p 9998:9998 apache/tika:3.3.1.0-full
```

Run the live app:

```bash
pnpm dev
```

Open <http://localhost:5173>.

`pnpm dev` injects the read-only `FASTMAIL_JMAP_TOKEN` from the `Kub-Homelab`
Infisical project, environment `dev`, path
`/kubernetes/tools/inbox-walk-secret`. Local development can read real mail
but cannot mark messages read or create Fastmail drafts. Live mode never falls
back to sample data. `MAIL_REVIEW_DEMO=1` serves a fixed sample inbox and sorts
it locally by exact identifiers; automated tests use that mode only.

The app follows the Codex CLI. It reads the ChatGPT login from
`$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) and takes `model`,
`model_reasoning_effort`, and `service_tier` from `$CODEX_HOME/config.toml`,
honouring the active `profile`. Refreshed tokens are written back in Codex's
own format so the CLI and the app never hold diverging refresh tokens. Run
`codex login` when that login can no longer refresh.

Without a Codex login the app reuses an existing Pi `openai-codex` login from
`~/.pi/agent/auth.json` during local development. Otherwise, open
**Einstellungen**, choose **Mit ChatGPT verbinden**, and complete the OpenAI
device-code flow. The rotating OAuth record stays server-side and is never
returned by the API.

The settings menu shows the model, thinking level, and speed in use; change
them in Codex. `CODEX_MODEL`, `CODEX_THINKING_LEVEL`, and `CODEX_SPEED`
(`standard` or `fast`) only apply when Codex has no model configured, and Sol
at high effort is the final default. Models Pi does not know yet, such as
`gpt-6-astra`, are described from `$CODEX_HOME/models_cache.json`.

## How sorting works

Every poll lists unread mail, queues new IDs with their summaries, and drops
IDs that are no longer unread. Queued messages go to Codex in batches of up to
eight. Each Codex session runs isolated: no built-in tools, skills, extensions,
or project context. It receives the new summaries, the buckets active in the
last 45 days, and your memory note. Its tools are:

| Tool | Effect |
| --- | --- |
| `search_mail`, `get_thread`, `get_email_text` | Read-only lookups in the whole mailbox, bounded to 30 calls per session |
| `create_bucket`, `add_to_bucket`, `update_bucket`, `merge_buckets` | Change buckets in this app only |
| `propose_memory` | Suggest a note for you to accept or reject |
| `finish_triage` | End the session once every new message has a bucket |

Mail content is untrusted data. No tool can mark mail read, move it, label it,
or create a draft. A sort that fails for a transient reason counts one attempt;
after three attempts the message stays visible as unsorted with a retry
button. An expired Codex login pauses sorting without counting attempts. Every
tool action is appended to an event log in SQLite; message bodies fetched for
sorting live only in the session.

`TRIAGE_POLL_INTERVAL_MS` sets the poll interval and defaults to one minute.
`TRIAGE_TIMEOUT_MS` bounds one sorting session, defaulting to 15 minutes with a
60-minute ceiling. `CODEX_INFERENCE_TIMEOUT_MS` keeps the five-minute default
for reply drafts.

`DATA_DIR/inbox-walk.sqlite` stores buckets, message summaries with their todo
state, the event log, reply editor state, memory notes and proposals. It never
stores received message bodies or attachment content; the persisted summary
includes Fastmail's short preview excerpt. Handled messages are deleted after
60 days. Databases from releases before 0.10 lose their review rounds on first
start; the Codex login is kept.

## Keyboard controls

In the list, click a bucket or use `?` for help. In a bucket:

- `E` or `ArrowRight`: bucket done, mark its shown messages read and open the next bucket
- `ArrowLeft` or `Escape`: back to the list
- `ArrowUp`: park the selected message
- `ArrowDown`: tag the selected newsletter for later unsubscribe work
- `R`: open the reply-draft panel
- `?`: keyboard help

## Quality gates

```bash
pnpm check
pnpm build
pnpm test:e2e
lefthook run pre-commit
```

Lefthook runs Biome, TypeScript, unit/API tests, and a redacted staged Gitleaks
scan before commits. The GitHub Actions workflow repeats quality and browser tests,
builds the production container through the shared BuildKit service, and
publishes it to `ghcr.io/beastyrabbit/inbox-walk` on the repository's ARC runners.

## Production

This source tree describes release `v0.10.0`. Production releases are deployed at
<https://inbox-walk.heerlab.com> behind Pangolin `BeastyOnly` authentication.

The image listens on port `3000` and requires `FASTMAIL_JMAP_TOKEN` in live mode.
The Codex OAuth record and the todo database are stored under `DATA_DIR`;
`TIKA_URL` points to the document-extraction sidecar.

Deployment is managed from `beastyrabbit/kub-homelab` on GitHub. Runtime secrets are synced by
the Infisical Operator; no secret values belong in this repository or in the
container image.

See [product behavior](docs/PRODUCT.md), [delivery status](docs/BOARD.md), and
[operations](docs/OPERATIONS.md).
