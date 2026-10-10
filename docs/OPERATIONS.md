# Operations

This document describes the generic production contract. Keep provider names,
cluster paths, hostnames, and secret-manager identifiers in the private
deployment repository. The repository workflows may still reference the
repository-scoped runner and builder needed to execute CI.

## Runtime contract

- Port: `3000`
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Required live secret: `FASTMAIL_JMAP_TOKEN`
- Persistent state: `DATA_DIR` for the SQLite database and Codex OAuth record
- Codex defaults: `CODEX_MODEL`, `CODEX_THINKING_LEVEL`, and `CODEX_SPEED`
- Document extraction: `TIKA_URL`, an internal HTTP(S) Apache Tika service
- Poll fallback: `TRIAGE_POLL_INTERVAL_MS` (60 seconds by default)
- Sort timeout: `TRIAGE_TIMEOUT_MS` (15 minutes by default, one hour maximum)
- Reply timeout: `CODEX_INFERENCE_TIMEOUT_MS` (five minutes by default)
- Demo override: `MAIL_REVIEW_DEMO=1`

Live mode refuses to start without the Fastmail token and Tika URL. Demo mode
uses synthetic messages and does not contact live providers.

## Storage and replicas

Mount `DATA_DIR` on durable storage writable by the application user. Run one
application replica per SQLite volume. The push, poll, and sorting loops are
process-local; multiple replicas would sort the same mail twice.

The database stores message summaries, bucket state, sorting events, notes,
reply editor state, and CSRF/image tokens. It does not store received bodies or
attachment content. Completed todo entries are pruned after 60 days. Deleting
the database while the app is stopped rebuilds the todo from current unread
mail on the next poll; it does not change mail in Fastmail.

## Deployment

1. Build and test the image from a version tag whose version matches `package.json`.
2. Inject runtime secrets through the deployment secret manager.
3. Mount durable storage at `DATA_DIR` and provide the Tika service URL.
4. Put the service behind TLS and user authentication before exposing it.
5. Configure platform probes for `/healthz` and `/readyz`.
6. Run one replica and verify demo mode, probes, sorting, and draft creation.

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
mail IDs, subjects, previews, addresses, notes, editor text, OAuth files, or
secret values.
