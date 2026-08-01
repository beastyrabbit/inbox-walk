# Operations

## Runtime contract

- Port: `3000`
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Required live variables: `FASTMAIL_JMAP_TOKEN`, `OPENAI_API_KEY`
- Explicit demo override: `MAIL_REVIEW_DEMO=1`

The process refuses to start in live mode unless both credentials are present.
This makes a missing or incomplete Kubernetes Secret fail visibly during
rollout instead of surfacing only when a reply is requested.

## Deployment path

1. Forgejo Actions validates the project and publishes the tagged OCI image.
2. The Infisical Operator syncs the app project’s `prod` secrets to namespace `tools`.
3. Flux applies the kub-homelab workload, Service, and Infisical resources.
4. The tools Pangolin blueprint exposes `https://inbox-walk.heerlab.com` to the `BeastyOnly` role.
5. Homepage lists the service under Additional Services.

## Verification

```bash
kubectl -n tools get deploy,pod,svc inbox-walk
kubectl -n tools get infisicalstaticsecret inbox-walk-secret
kubectl -n tools rollout status deploy/inbox-walk
kubectl -n tools port-forward svc/inbox-walk 3000:3000
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

Do not print Kubernetes Secret values or application credentials while
troubleshooting. Inspect key names and sync status only.
