# Developer guide

## Local setup

Use Node 24, pnpm 11, and Docker. Install dependencies and copy the example
environment file:

```bash
pnpm install
cp .env.example .env
```

For a safe UI run, use demo mode:

```bash
MAIL_REVIEW_DEMO=1 pnpm dev
```

For live development, set a dedicated Fastmail token in `.env`, start Tika, and
run `pnpm dev`. Keep credentials in local files or a secret manager. Do not
commit `.env`, `DATA_DIR`, OAuth files, or databases.

## Architecture

The Vite client talks to the Node HTTP server through `/api`. `server/jmap.ts`
is the Fastmail boundary. `server/api.ts` owns todo actions, CSRF tokens, and
request validation. `server/triage-store.ts` persists buckets, message
summaries, notes, and editor state. `server/triage-engine.ts` and
`server/codex.ts` handle sorting. `server/reply.ts` prepares attachment-aware
drafts. The client keeps navigation and editor state in `src/`.

The sorter may change only app-owned bucket state. Fastmail mutations require an
explicit browser action and exact message IDs. Mail and attachments are
untrusted data, and reply generation fails closed when extraction is incomplete.

## Checks

Run the project checks before a release:

```bash
pnpm check
pnpm build
pnpm test:e2e
```

Automated tests use `MAIL_REVIEW_DEMO=1` or injected local transports. They must
never call Fastmail, Codex, or another live provider.

## Production shape

Build with `pnpm build`, then run `node dist-server/index.js`. Set
`FASTMAIL_JMAP_TOKEN`, `TIKA_URL`, and a writable `DATA_DIR` through the
deployment secret manager. Put the service behind authentication and TLS and
expose `/healthz` and `/readyz` to platform probes.

Keep deployment manifests, cluster configuration, secret-manager paths, and
internal hostnames in the private deployment repository. The CI workflows retain
the repository-scoped runner and builder settings they need to run. This public
repository should otherwise contain application code and generic deployment
guidance only.
