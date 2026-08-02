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
- Resumes the exact snapshot and local decisions after a browser refresh.
- Filters by mailbox, time range, and newsletter status.
- Sanitizes mail HTML in a sandboxed iframe and blocks remote images by default.
- Keeps selected messages unread and marks the rest read only after confirmation.
- Loads the complete bounded thread before preparing a reply.
- Sends every supported image to Codex and extracts every supported document through Apache Tika.
- Blocks reply generation if any attachment is unsupported or the 45 MiB budget is exceeded.
- Creates and reads back a normal Fastmail draft with reply headers and identity signature.
- Exposes `/healthz` and `/readyz` for Kubernetes probes.

## Local development

Install dependencies, start Apache Tika, and run the live app through Portless:

```bash
pnpm install
docker run --rm -p 9998:9998 apache/tika:3.3.1.0-full
pnpm dev:portless
```

Open <https://inbox-walk.localhost:1355>.

`pnpm dev` injects the read-only `FASTMAIL_JMAP_TOKEN` from the `API Tokens`
Infisical project, environment `dev`, path `/tools/fastmail`. Local development
can review real mail but cannot mark messages read or create Fastmail drafts.
Live mode never falls back to sample data. A Fastmail MCP token cannot be used
with the JMAP API.

The app reuses an existing Pi `openai-codex` login from
`~/.pi/agent/auth.json` during local development. Otherwise, choose **Codex
anmelden** in the app and complete the OpenAI device-code flow. The rotating
OAuth record stays server-side and is never returned by the API.
Choosing **Neu anmelden** while using that local fallback also refreshes the
workstation's shared Pi login; set `DATA_DIR` to an app-specific directory if
you want isolated local credentials.

## Keyboard controls

- `ArrowRight`: next message
- `ArrowLeft`: previous message
- `ArrowUp`: toggle “keep unread”
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

The image listens on port `3000` and requires `FASTMAIL_JMAP_TOKEN` in live mode.
The Codex OAuth record is stored under `DATA_DIR`; `TIKA_URL` points to the
document-extraction sidecar.

Deployment is managed from `beasty/kub-homelab`. Runtime secrets are synced by
the Infisical Operator; no secret values belong in this repository or in the
container image.

See [product behavior](docs/PRODUCT.md), [delivery status](docs/BOARD.md), and
[operations](docs/OPERATIONS.md).
