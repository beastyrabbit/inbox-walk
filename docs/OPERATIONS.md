# Operations

## Production contract

- Release described by this source tree: `v0.8.0`
- URL: <https://inbox-walk.heerlab.com>
- Access: Pangolin `BeastyOnly`
- Namespace: `tools`
- GitOps source: `beasty/kub-homelab`

## Runtime contract

- Port: `3000`
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Required live secret: `FASTMAIL_JMAP_TOKEN`
- Persistent state: `DATA_DIR=/data` for Pi's rotating Codex OAuth record, `codex-settings.json`, `inbox-walk.sqlite`, and `bundle-learning.sqlite`
- Assisted-reply services: `CODEX_MODEL=gpt-5.6-sol`, `CODEX_THINKING_LEVEL=high`, `TIKA_URL=http://inbox-walk-tika.tools.svc.cluster.local:9998`
- Inference timeout: `CODEX_INFERENCE_TIMEOUT_MS=300000`
- Explicit demo override: `MAIL_REVIEW_DEMO=1`

The process refuses to start in live mode unless the Fastmail credential is
present. Codex can be connected after startup through the app's device-code
flow; reply generation fails visibly until that subscription login exists.
The pod must mount `/data` writable for UID/GID `1000`; kub-homelab supplies
`fsGroup: 1000`. Document extraction uses the pinned
`apache/tika:3.3.1.0-full` image with PDF OCR enabled and still fails closed when
no complete content can be recovered. Live mode refuses to start without an
explicit HTTP(S) `TIKA_URL`.

`inbox-walk.sqlite` stores durable review rounds: stable IDs and tokens, filters,
mail summaries, bundle-analysis progress and provenance, bundle results, user
decisions, the round's frozen hashed learning examples, reply editor state, and
finalization attempts. It does not store received message bodies or attachment
content. The same database keeps the
separate retained-unread history with Fastmail IDs, first/last-retained
timestamps, and a retain count. The options request reconciles that history
against Fastmail. Deleting this database while the app is stopped removes both
open rounds and retained-unread history; it does not change mail in Fastmail.
Finished rounds are retained for seven days, active rounds for 30 days, with a
hard cap of 200 rounds. Pruning runs at startup, once per minute, and when a new
round is created.

Run one Inbox Walk application replica against this SQLite volume. Process-local
job ownership prevents duplicate Codex work inside that replica; the persisted
decision checkpoints handle restarts. Multiple replicas do not coordinate one
round's provider calls.
Every message in a frozen round is covered by bundle analysis. Completed
decisions are checkpointed for restart recovery; there is no per-round call
cutoff.
The inference timeout applies to one provider request. A timeout marks the
stored run failed; it does not truncate the snapshot or switch to a local
result. The same snapshot remains available for explicit reanalysis.

## Upgrade from v0.7.1

No manual database migration is required. Startup upgrades
`inbox-walk.sqlite` from schema v4 through v7 before accepting requests.
Complete rounds remain available. A legacy round whose frozen snapshot is
missing messages is marked failed, and its stale grouping result and Codex
checkpoints are removed. `CODEX_BUNDLE_MAX_CALLS` is no longer read and can be
removed from local configuration.

`bundle-learning.sqlite` can retain hashed relationship signals created by
older releases. It does not store message bodies, previews, or attachment
content. Current releases do not expose manual relationship-label controls.

## Deployment path

1. Forgejo Actions validates the project and publishes the tagged OCI image.
2. The Infisical Operator syncs the Fastmail token to namespace `tools`.
3. Flux applies the workload, Longhorn PVC, Tika Service, and Infisical resources.
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
curl -fsS http://127.0.0.1:3000/api/review/options \
  | jq '{mode, reviewedCount, mailboxCount: (.mailboxes | length)}'
```

Check `/api/auth/codex/status` for the non-secret configured flag and model. Do
not inspect or print `/data/pi/auth.json`; reconnect from the app when OAuth can
no longer refresh. The settings dialog stores the Codex model and thinking
level in `/data/codex-settings.json`; `CODEX_MODEL` and
`CODEX_THINKING_LEVEL` remain startup defaults. For the
review persistence, inspect schema and aggregate counts only rather than
printing message IDs, subjects, previews, addresses, or editor text.

Do not print Kubernetes Secret values or application credentials while
troubleshooting. Inspect key names and sync status only.
