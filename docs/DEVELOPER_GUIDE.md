# Developer guide

## Local setup

Use Node 24, pnpm 11, and Docker. Install dependencies and copy the example environment file:

```bash
pnpm install
cp .env.example .env
```

For a safe UI run, use the explicit demo mode:

```bash
MAIL_REVIEW_DEMO=1 pnpm dev
```

For live development, set a dedicated Fastmail token in `.env`, start Tika, and run `pnpm dev`:

```bash
docker run --rm --name inbox-walk-tika -p 9998:9998 apache/tika:3.3.1.0-full
pnpm dev
```

Connect Codex from the Settings screen when reply generation or model analysis is needed. Keep credentials in local files or a secret manager. Do not commit `.env`, `DATA_DIR`, OAuth files, or databases.

## Architecture

The Vite client talks to the Node HTTP server through `/api`. `server/jmap.ts` is the Fastmail boundary. `server/api.ts` owns review snapshots, round state, CSRF tokens, and request validation. `server/round-store.ts` persists rounds in SQLite. `server/bundles.ts` and `server/codex.ts` handle story analysis. `server/reply.ts` prepares attachment-aware drafts. The client keeps navigation and editor state in `src/`.

The stable snapshot is the safety boundary. Only IDs from that snapshot can be finalized as read. Review history stores only messages deliberately kept unread. Mail and attachments are untrusted input, and reply generation fails closed when extraction is incomplete.

## Checks

Run the focused checks while editing, then the full project checks before a release:

```bash
pnpm check
pnpm build
pnpm test:e2e
```

Automated tests use `MAIL_REVIEW_DEMO=1` or injected local transports. They must never call Fastmail, Codex, or another live provider.

## Production shape

Build the client and server with `pnpm build`, then run `node dist-server/index.js`. Set `FASTMAIL_JMAP_TOKEN`, `TIKA_URL`, and a writable `DATA_DIR` through the deployment secret manager. Put the service behind authentication and TLS. Run one application replica per SQLite volume. Expose `/healthz` and `/readyz` to the platform probes.

Keep deployment manifests, cluster configuration, secret-manager paths, runner names, and internal hostnames in the private infrastructure repository. This public repository should contain application code and generic deployment guidance only.
