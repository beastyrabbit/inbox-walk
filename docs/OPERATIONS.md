# Operations

## Current deployment

- Release: `v0.6.0`
- URL: <https://inbox-walk.heerlab.com>
- Access: Pangolin `BeastyOnly`
- Namespace: `tools`
- GitOps source: `beasty/kub-homelab`

## Runtime contract

- Port: `3000`
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Required live secret: `FASTMAIL_JMAP_TOKEN`
- Persistent state: `DATA_DIR=/data` for Pi's rotating Codex OAuth record, `inbox-walk.sqlite`, and `bundle-learning.sqlite`
- Assisted-reply services: `CODEX_MODEL=gpt-5.6-sol`, `TIKA_URL=http://inbox-walk-tika.tools.svc.cluster.local:9998`
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

`inbox-walk.sqlite` records only Fastmail message IDs deliberately kept unread,
first/last-retained timestamps, and a retain count. It is protected by the
existing private `/data` volume and lets the user optionally exclude those
deferred messages from new rounds. IDs successfully marked read are removed,
and the options request reconciles remaining IDs against Fastmail so messages
read or deleted elsewhere do not inflate the count. Deleting only this database
while the app is stopped resets that history; it does not change mail in
Fastmail.

`bundle-learning.sqlite` stores hashed relationship signals from explicit merge,
split, and confirmation actions. It does not store message bodies, previews, or
attachment content. The app retains at most 1,000 relationship labels.

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
no longer refresh. For the review history, inspect schema and aggregate counts
only rather than printing message IDs.

Do not print Kubernetes Secret values or application credentials while
troubleshooting. Inspect key names and sync status only.
