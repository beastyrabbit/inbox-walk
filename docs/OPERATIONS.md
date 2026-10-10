# Operations

This document describes the generic production contract. Keep provider names,
cluster paths, hostnames, runner names, and secret-manager identifiers in a
private infrastructure repository.

## Runtime contract

- Port: `3000`
- Liveness and readiness: `GET /healthz` and `GET /readyz`
- Required live secret: `FASTMAIL_JMAP_TOKEN`
- Persistent state: `DATA_DIR` for the SQLite databases, Codex OAuth record, and settings
- Document extraction: `TIKA_URL`, an internal HTTP(S) Apache Tika service
- Demo override: `MAIL_REVIEW_DEMO=1`

Live mode refuses to start without the Fastmail token and Tika URL. Demo mode
uses synthetic messages and does not contact live providers.

## Storage and replicas

Mount `DATA_DIR` on durable storage writable by the application user. Run one
application replica per SQLite volume. The process owns background jobs locally;
multiple replicas do not coordinate a round's provider calls.

The database stores review summaries, decisions, checkpoints, drafts, and
retained-unread IDs. It does not store received bodies or attachment content.
Finished rounds are pruned after seven days and active rounds after 30 days,
with a hard cap of 200 rounds.

## Deployment

1. Build and test the image from a version tag.
2. Inject runtime secrets through the deployment secret manager.
3. Mount durable storage at `DATA_DIR` and provide the Tika service URL.
4. Put the service behind TLS and user authentication before exposing it.
5. Configure platform probes for `/healthz` and `/readyz`.
6. Roll out one replica and verify the probes, demo mode, and a manual live review.

Do not put secret values in the image, repository, logs, issue tracker, or
deployment manifests. Keep the live mailbox service private even when this
source repository is public.

## Verification

```bash
pnpm check
pnpm build
pnpm test:e2e
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

Inspect only status and aggregate counts when troubleshooting. Do not print
mail IDs, subjects, previews, addresses, editor text, OAuth files, or secret
values.
