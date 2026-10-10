# Inbox Walk

Inbox Walk is a keyboard-first Fastmail review app. It freezes one complete
snapshot of unread incoming mail, groups related notifications into review
stories, and applies read-state changes only after a final confirmation.

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
- Deletes rounds from the table, cancels abortable fetch or analysis work, and can reanalyze the same frozen snapshot. An active round keeps its review decisions and drafts. Reanalyzing a completed round clears its old decisions and completion result but keeps reply drafts. Reply generation and draft storage block deletion immediately. Finalization blocks it after taking the durable selection lock; if deletion wins the earlier mailbox-context race, finalization stops before changing the mailbox.
- Reviews either Spam only or all incoming mail except Spam, with direct mailbox, time, and newsletter choices.
- Can omit messages deliberately kept unread in an earlier round using a small local SQLite history.
- Sanitizes mail HTML in a script-free sandboxed iframe and proxies remote images through the backend.
- Uses the available window for reading mail, with one compact story title and expandable message details.
- Keeps selected messages unread and marks the rest read only after confirmation.
- Closes a round automatically after every message in its frozen snapshot is processed.
- Moves messages marked “Not Spam” back to Inbox when a Spam review is confirmed.
- Adds the Fastmail label `Newsletter abmelden` for deferred unsubscribe work instead of contacting senders automatically.
- Loads up to 100 messages from the selected reply thread; this limit does not cap a review round.
- Sends every supported image to Codex and extracts every supported document through Apache Tika.
- Selects Sol, Terra, or Luna for new Codex work without restarting the app.
- Shows the running release version in the application shell.
- Blocks reply generation if any attachment is unsupported or the 45 MiB budget is exceeded.
- Creates and reads back a normal Fastmail draft with reply headers and identity signature.
- Exposes `/healthz` and `/readyz` for Kubernetes probes.

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

Open <http://localhost:5173>.

For live development, set a dedicated Fastmail token in `.env`, start Apache
Tika, and run `pnpm dev`. Never commit `.env` or use a production credential on
a shared machine.

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
run first and freezes every matching summary. Codex receives the complete frozen
set in one request and partitions every message into a concrete multi-message
story or a standalone item. The app does not preselect candidates or join
stories before Codex sees them. Opening a message never starts analysis. Later
mail is not added to the frozen round.

The complete Codex partition is checkpointed in SQLite before the final run is
stored. A browser reload keeps the current job running. After a process crash,
the app reuses a complete saved partition; only an unfinished provider request
may be repeated. Reloading or opening a finished round does not run Codex again.
Only **Neu analysieren** starts a new analysis generation on the same snapshot.
The backend turns overlapping model suggestions into one deterministic
partition: higher-confidence stories win duplicate assignments, undersized
stories dissolve, and every otherwise unassigned snapshot message becomes a
standalone item. Unknown IDs and malformed story metadata still fail closed.
If a started Codex run later needs a new login, it fails visibly instead of
silently changing engines. Reconnect Codex and rerun the analysis on the same
frozen snapshot.

`CODEX_BUNDLE_TIMEOUT_MS` limits the one global grouping request. It defaults to
30 minutes and can be raised to at most 60 minutes. `CODEX_INFERENCE_TIMEOUT_MS`
keeps the five-minute default for other Codex work. A timeout marks the run
**Fehlgeschlagen** and leaves it available for a fresh analysis.

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
scan before commits. The GitHub Actions workflow repeats quality and browser tests,
builds the production container through the shared BuildKit service, and
publishes it to `ghcr.io/beastyrabbit/inbox-walk` on the repository's ARC runners.

## Documentation

See the [user guide](docs/USER_GUIDE.md), [developer guide](docs/DEVELOPER_GUIDE.md),
[product behavior](docs/PRODUCT.md), and [generic operations guide](docs/OPERATIONS.md).
