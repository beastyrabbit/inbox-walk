# Inbox Walk

Inbox Walk is a private, keyboard-first Fastmail review app. It freezes one
bounded snapshot of unread incoming mail, shows the original messages one at a
time, and applies read-state changes only after a final confirmation.

For messages that need an answer, Inbox Walk can use Codex through a ChatGPT
Plus/Pro subscription to prepare a thread-aware reply and save it as a verified
Fastmail draft. It has no send-mail endpoint or send control; sending remains in
Fastmail.

## What it does

- Loads at most 250 unread incoming messages into a stable JMAP snapshot.
- Opens every new round with a dedicated selection page instead of loading mail immediately.
- Resumes the exact snapshot and local decisions after a browser refresh.
- Reviews either Spam only or all incoming mail except Spam, with direct mailbox, time, and newsletter choices.
- Can omit messages deliberately kept unread in an earlier round using a small local SQLite history.
- Sanitizes mail HTML in a script-free sandboxed iframe and proxies remote images through the backend.
- Keeps selected messages unread and marks the rest read only after confirmation.
- Moves messages marked “Not Spam” back to Inbox when a Spam review is confirmed.
- Adds the Fastmail label `Newsletter abmelden` for deferred unsubscribe work instead of contacting senders automatically.
- Loads the complete bounded thread before preparing a reply.
- Sends every supported image to Codex and extracts every supported document through Apache Tika.
- Blocks reply generation if any attachment is unsupported or the 45 MiB budget is exceeded.
- Creates and reads back a normal Fastmail draft with reply headers and identity signature.
- Exposes `/healthz` and `/readyz` for Kubernetes probes.

## Local development

Install dependencies, then start Apache Tika in a separate terminal:

```bash
pnpm install
docker run --rm --name inbox-walk-tika -p 9998:9998 apache/tika:3.3.1.0-full
```

Run the live app through Portless:

```bash
pnpm dev:portless
```

Open <http://inbox-walk.localhost:1355>.

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

Fastmail message IDs are recorded in `DATA_DIR/inbox-walk.sqlite` only when a
completed round deliberately keeps them unread. A future round can optionally
hide those deferred messages. The database stores IDs, timestamps, and a retain
count only—never senders, subjects, bodies, or attachments. Messages marked read
are removed from the history. Leave **Zurückgestellte Nachrichten ausblenden**
unchecked to include every matching unread message as before.

## Keyboard controls

- `ArrowRight`: next message
- `ArrowLeft`: previous message
- `ArrowUp`: toggle “keep unread”
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

The current usable release is `v0.5.2`, deployed at
<https://inbox-walk.heerlab.com> behind Pangolin `BeastyOnly` authentication.

The image listens on port `3000` and requires `FASTMAIL_JMAP_TOKEN` in live mode.
The Codex OAuth record and retained-unread SQLite history are stored under
`DATA_DIR`; `TIKA_URL` points to the document-extraction sidecar.

Deployment is managed from `beasty/kub-homelab`. Runtime secrets are synced by
the Infisical Operator; no secret values belong in this repository or in the
container image.

See [product behavior](docs/PRODUCT.md), [delivery status](docs/BOARD.md), and
[operations](docs/OPERATIONS.md).
