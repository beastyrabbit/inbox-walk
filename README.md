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
- Learns only from explicit bundle corrections and gives Codex at most two confirmed positive and two confirmed negative examples per decision.
- Opens every new round with a dedicated selection page instead of loading mail immediately.
- Gives every round a stable URL and restores its snapshot, analysis, decisions, and finalization after a browser refresh or app restart.
- Reviews either Spam only or all incoming mail except Spam, with direct mailbox, time, and newsletter choices.
- Can omit messages deliberately kept unread in an earlier round using a small local SQLite history.
- Sanitizes mail HTML in a script-free sandboxed iframe and proxies remote images through the backend.
- Keeps selected messages unread and marks the rest read only after confirmation.
- Moves messages marked “Not Spam” back to Inbox when a Spam review is confirmed.
- Adds the Fastmail label `Newsletter abmelden` for deferred unsubscribe work instead of contacting senders automatically.
- Loads the complete bounded thread before preparing a reply.
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
`~/.pi/agent/auth.json` during local development. Otherwise, choose **Codex
anmelden** in the app and complete the OpenAI device-code flow. The rotating
OAuth record stays server-side and is never returned by the API.
Choosing **Neu anmelden** while using that local fallback also refreshes the
workstation's shared Pi login; set `DATA_DIR` to an app-specific directory if
you want isolated local credentials.

The Codex dialog also selects the model used for new bundle decisions and reply
drafts. Sol is the deployment default; Sol, Terra, and Luna can be selected in
the UI without restarting the app. The choice is stored in
`DATA_DIR/codex-settings.json`.

Connect Codex on the selection screen before starting a round. The app first
freezes the round, then asks Codex to judge only plausible relationships found
by the local index. It does not run again when you open a message. Later mail is
not added to the frozen round. The bounded, hashed learning-example corpus is
also frozen with the round and reused after a restart. A new round gets a new
analysis.

Each completed Codex decision is checkpointed in SQLite. A browser reload keeps
the current job running. After a process crash, the app replays saved decisions
and may repeat only the provider call that was still open. A finished analysis
is never run again. `CODEX_BUNDLE_MAX_CALLS` limits provider calls per round and
defaults to 64. The resolved limit is frozen with the round, so a configuration
change during a restart cannot change an in-progress analysis. Reaching the
limit falls back to the safe individual-message view.
If a started Codex run later needs a new login, the saved round waits instead
of silently changing engines. You can reconnect Codex or explicitly finish
that round in the safe individual-message view; that choice is persisted and
Codex will not restart for the round.

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

The current usable release is `v0.6.1`, deployed at
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
