# Inbox Walk

Inbox Walk is a private, keyboard-first Fastmail review app. It freezes one
complete snapshot of unread incoming mail, groups related notifications into
review stories, and applies read-state changes only after a final confirmation.

For messages that need an answer, Inbox Walk can use Codex through a ChatGPT
Plus/Pro subscription to prepare a thread-aware reply and save it as a verified
Fastmail draft. It has no send-mail endpoint or send control; sending remains in
Fastmail.

## What it does

- Loads every matching unread incoming message into a stable, paginated JMAP snapshot.
- Bundles related threads, repository activity, deployments, orders, and carrier updates while keeping every original inspectable.
- Can reuse a bounded set of hashed relationship examples retained from older releases without exposing message content.
- Creates a stored run as soon as **Runde starten** is clicked and shows fetch and analysis progress in the rounds table.
- Enables **Runde öffnen** only after the complete Codex result is stored.
- Gives every round a stable URL and restores its snapshot, analysis, decisions, and finalization after a browser refresh or app restart.
- Deletes rounds from the table, cancels abortable fetch or analysis work, and can reanalyze the same frozen snapshot without discarding review decisions or drafts. Reply generation and draft storage block deletion immediately. Finalization blocks it after taking the durable selection lock; if deletion wins the earlier mailbox-context race, finalization stops before changing the mailbox.
- Reviews either Spam only or all incoming mail except Spam, with direct mailbox, time, and newsletter choices.
- Can omit messages deliberately kept unread in an earlier round using a small local SQLite history.
- Sanitizes mail HTML in a script-free sandboxed iframe and proxies remote images through the backend.
- Keeps selected messages unread and marks the rest read only after confirmation.
- Moves messages marked “Not Spam” back to Inbox when a Spam review is confirmed.
- Adds the Fastmail label `Newsletter abmelden` for deferred unsubscribe work instead of contacting senders automatically.
- Loads up to 100 messages from the selected reply thread; this limit does not cap a review round.
- Sends every supported image to Codex and extracts every supported document through Apache Tika.
- Selects Sol, Terra, or Luna for new Codex work without restarting the app.
- Blocks reply generation if any attachment is unsupported or the 45 MiB budget is exceeded.
- Creates and reads back a normal Fastmail draft with reply headers and identity signature.
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
`/kubernetes/tools/inbox-walk-secret`. Local development can review real mail
but cannot mark messages read or create Fastmail drafts. Live mode never falls
back to sample data.

The app reuses an existing Pi `openai-codex` login from
`~/.pi/agent/auth.json` during local development. Otherwise, open
**Einstellungen**, choose **Mit ChatGPT verbinden**, and complete the OpenAI
device-code flow. The rotating
OAuth record stays server-side and is never returned by the API.
Choosing **Neu anmelden** while using that local fallback also refreshes the
workstation's shared Pi login; set `DATA_DIR` to an app-specific directory if
you want isolated local credentials.

The settings menu selects the model and thinking level used for new bundle
decisions and reply drafts. Sol is the deployment default; Sol, Terra, and Luna
can be selected without restarting the app. The choices are stored together in
`DATA_DIR/codex-settings.json`.

Connect Codex in the settings menu before starting a round. The app stores the
run first, freezes every matching summary, and rebuilds its local relationship
index for that snapshot. Exact IDs and same-thread links are joined locally.
Codex then checks every remaining story seed against broad text and
cross-provider time candidates. A message accepted into an earlier story does
not need a second seed check. Opening a message never starts analysis. Later
mail is not added to the frozen round.

Codex decisions are checkpointed in SQLite as the run accepts them. A browser reload keeps
the current job running. After a process crash, the app replays saved decisions;
only work without a durable checkpoint may be repeated. Reloading or opening
a finished round does not run Codex again. Only **Neu analysieren** starts a new
analysis generation on the same snapshot. Every message in the snapshot is
covered; there is no per-round provider-call cutoff.
If a started Codex run later needs a new login, it fails visibly instead of
silently changing engines. Reconnect Codex and rerun the analysis on the same
frozen snapshot.

`CODEX_INFERENCE_TIMEOUT_MS` limits one Codex request, not the number of messages
in a round. The default is five minutes. If a request has not finished by then,
the run becomes **Fehlgeschlagen** and remains available for a fresh analysis.

`DATA_DIR/inbox-walk.sqlite` stores review rounds with their fixed IDs, filters,
mail summaries, frozen hashed learning examples, bundle-analysis status, Codex
checkpoints, decisions, reply editor state, and finalization results. It never
stores received message bodies or attachment content; the persisted summary
includes Fastmail's short preview excerpt.
Finished rounds are retained for seven days and active rounds for 30 days, with
a 200-round cap. The same database keeps a separate history of IDs deliberately
left unread, so a future round can optionally hide them. IDs marked read are
removed from that history. Leave **Zurückgestellte Nachrichten ausblenden**
unchecked to include every matching unread message as before.

## Keyboard controls

- `ArrowRight`: complete the current story and continue
- `ArrowLeft`: previous story
- `ArrowUp`: toggle “keep unread” for the selected original
- `ArrowDown`: mark “Not Spam” in Spam reviews, otherwise tag a newsletter for later unsubscribe work
- `R`: open the reply-draft panel
- `?`: keyboard help
- `Escape`: close the active panel or dialog

## Quality gates

```bash
pnpm check
pnpm build
pnpm test:e2e
lefthook run pre-commit
```

Lefthook runs Biome, TypeScript, unit/API tests, and a redacted staged Gitleaks
scan before commits. The Forgejo workflow repeats quality and browser tests,
builds the production container through the shared BuildKit service, and
publishes it to `git.heerlab.com/beasty/inbox-walk`.

## Production

This source tree describes release `v0.8.0`. Production releases are deployed at
<https://inbox-walk.heerlab.com> behind Pangolin `BeastyOnly` authentication.

The image listens on port `3000` and requires `FASTMAIL_JMAP_TOKEN` in live mode.
The Codex OAuth record, review rounds, retained-unread history, and bundle
learning data are stored under `DATA_DIR`; `TIKA_URL` points to the
document-extraction sidecar.

Deployment is managed from `beasty/kub-homelab`. Runtime secrets are synced by
the Infisical Operator; no secret values belong in this repository or in the
container image.

See [product behavior](docs/PRODUCT.md), [delivery status](docs/BOARD.md), and
[operations](docs/OPERATIONS.md).
