# Operations

## Runtime contract

- Port: `3000`
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Required live secret: `FASTMAIL_JMAP_TOKEN`
- Persistent state: `DATA_DIR=/data` for Pi's rotating Codex OAuth record
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

## Deployment path

1. Forgejo Actions validates the project and publishes the tagged OCI image.
2. The Infisical Operator syncs the Fastmail token to namespace `tools`.
3. Flux applies the workload, Longhorn PVC, Tika Service, and Infisical resources.
4. The tools Pangolin blueprint exposes `https://inbox-walk.heerlab.com` to the `BeastyOnly` role.
5. Homepage lists the service under Additional Services.

## Verification

```bash
kubectl -n tools get deploy,pod,svc inbox-walk
kubectl -n tools get pvc
kubectl -n tools get infisicalstaticsecret inbox-walk-secret
kubectl -n tools rollout status deploy/inbox-walk
kubectl -n tools port-forward svc/inbox-walk 3000:3000
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

Check `/api/auth/codex/status` for the non-secret configured flag and model. Do
not inspect or print `/data/pi/auth.json`; reconnect from the app when OAuth can
no longer refresh.

Do not print Kubernetes Secret values or application credentials while
troubleshooting. Inspect key names and sync status only.
