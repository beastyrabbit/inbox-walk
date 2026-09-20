# Operations

## Production contract

- Release described by this source tree: `v0.10.0`
- URL: <https://inbox-walk.heerlab.com>
- Access: Pangolin `BeastyOnly`
- Namespace: `tools`
- GitOps source: `beastyrabbit/kub-homelab` on GitHub

## Runtime contract

- Port: `3000`
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Required live secret: `FASTMAIL_JMAP_TOKEN`
- Persistent state: `DATA_DIR=/data` for Pi's rotating Codex OAuth record and `inbox-walk.sqlite`
- Codex home: `CODEX_HOME` (default `~/.codex`) with `auth.json`, `config.toml`, and `models_cache.json` takes precedence for login, model, reasoning effort, and speed
- Assisted-reply services: `CODEX_MODEL=gpt-5.6-sol`, `CODEX_THINKING_LEVEL=high`, `CODEX_SPEED=standard` as fallbacks, `TIKA_URL=http://inbox-walk-tika.tools.svc.cluster.local:9998`
- Fallback poll interval: `TRIAGE_POLL_INTERVAL_MS=60000` by default, between 5 seconds and one hour; JMAP push is always on in live mode
- Sorting session timeout: `TRIAGE_TIMEOUT_MS=900000` by default, maximum `3600000`
- Reply inference timeout: `CODEX_INFERENCE_TIMEOUT_MS=300000`
- Explicit demo override: `MAIL_REVIEW_DEMO=1`

The process refuses to start in live mode unless the Fastmail credential is
present. Codex can be connected after startup through the app's device-code
flow; until then new mail is queued and shown as unsorted, and reply generation
fails visibly. The pod must mount `/data` writable for UID/GID `1000`;
kub-homelab supplies `fsGroup: 1000`. Document extraction uses the pinned
`apache/tika:3.3.1.0-full` image with PDF OCR enabled and still fails closed
when no complete content can be recovered. Live mode refuses to start without
an explicit HTTP(S) `TIKA_URL`.

`inbox-walk.sqlite` stores buckets, message summaries with their todo state,
the sorting event log, reply editor state, memory notes and proposals, and the
CSRF and image tokens. It does not store received message bodies or attachment
content. Handled messages are deleted 60 days after they were done or read
elsewhere; empty closed buckets go with them. Deleting the database while the
app is stopped rebuilds the todo from the current unread mail on the next poll;
it does not change mail in Fastmail, but loses bucket titles, notes and parked
state.

Run one Inbox Walk replica against this SQLite volume. The push, poll and sort
loop is process-local; two replicas would sort the same mail twice.

The engine only reads from Fastmail. Marking read and adding the newsletter
label happen exclusively in response to user actions in the browser.

## Upgrade to v0.10.0

This release replaces review rounds with a continuous todo. On first start the
old round, decision, finalization and kept-unread tables are dropped from
`inbox-walk.sqlite`, and the separate `bundle-learning.sqlite` is no longer
read and can be deleted. The Codex login is unaffected. Within a minute of
start the todo lists every currently unread incoming message; Codex sorts them
in batches of eight, so a large backlog takes a while and shows unsorted
entries in the meantime.

`CODEX_BUNDLE_TIMEOUT_MS` is no longer read. Optional new variables are
`TRIAGE_POLL_INTERVAL_MS` and `TRIAGE_TIMEOUT_MS`.

## Earlier upgrades

Releases 0.9.x kept review rounds in the same database; see the release
history for their migration notes. None of them require action before
upgrading to 0.10.

## Deployment path

1. GitHub Actions runs on `arc-inbox-walk`, validates the project, boots a demo container, and publishes `ghcr.io/beastyrabbit/inbox-walk` for `v*` tags. The tag must match the package version.
2. The Infisical Operator syncs the Fastmail token to namespace `tools`.
3. Pin the verified image tag and digest in `cluster/homelab/apps/tools/inbox-walk/helmrelease.yaml` in `beastyrabbit/kub-homelab`. Flux applies the workload, Longhorn PVC, Tika Service, and Infisical resources.
4. The tools Pangolin blueprint exposes `https://inbox-walk.heerlab.com` to the `BeastyOnly` role.
5. Homepage lists the service under Additional Services.

## Verification

```bash
kubectl -n tools get deploy/inbox-walk svc/inbox-walk
kubectl -n tools get pods -l app.kubernetes.io/name=inbox-walk
kubectl -n tools get pvc
kubectl -n tools get infisicalstaticsecret inbox-walk-secret
kubectl -n tools rollout status deploy/inbox-walk
kubectl -n tools port-forward svc/inbox-walk 3000:3000
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
curl -fsS http://127.0.0.1:3000/api/todo \
  | jq '{mode, status, buckets: (.buckets | length), parked: (.parked | length)}'
```

`status` reports the last poll and sort times, the last public error, the
queued and failed counts, and whether sorting waits for a Codex login. Check
`/api/auth/codex/status` for the non-secret configured flag, model, thinking
level, speed, and their sources. Do not inspect or print
`$CODEX_HOME/auth.json` or `/data/pi/auth.json`; run `codex login` or reconnect
from the app when OAuth can no longer refresh. For the database, inspect
schema and aggregate counts only rather than printing message IDs, subjects,
previews, addresses, notes or editor text.

Structured stderr events `triage_poll`, `triage_poll_failed`,
`triage_sort_failed` and `jmap_push_disconnected` carry counts and the raw
error message, never mail content. `status.pushConnected` in `/api/todo`
shows whether the push stream is open; a closed stream only slows pickup to
the poll interval.

Do not print Kubernetes Secret values or application credentials while
troubleshooting. Inspect key names and sync status only.
