---
name: homelab-forgejo
description: This skill should be used when the user works with Heerlab Forgejo, git.heerlab.com, Forgejo Actions, Forgejo runners, Forgejo repo variables or secrets, migrating repos from GitHub to Forgejo, Forgejo SSH access, or Forgejo and Infisical CI integration.
---

# Homelab Forgejo

Use this skill as the local system overlay for Heerlab Forgejo. Apply it when operating `git.heerlab.com`, changing Forgejo Actions workflows, adding runner capacity, setting repository variables, wiring Infisical secrets into Actions, or migrating project automation from GitHub to Forgejo.

For secret value operations, also use the `homelab-infisical` skill. Keep this skill focused on Forgejo behavior, Actions wiring, runner operations, and the local conventions that make Forgejo work with Infisical.

## Local Constants

- Public Forgejo URL: `https://git.heerlab.com`
- SSH clone host: `git@git.heerlab.com`
- SSH clone port: external port `22`; do not put `2222` in repository clone URLs.
- Primary owner/user: `beasty`
- Main GitOps repo: `beasty/kub-homelab`
- Resolve the local `kub-homelab` checkout from the current workspace or projects directory; do not assume a machine-specific mount path.
- Forgejo Kubernetes namespace: `git`
- Forgejo runner namespace: `forgejo-runners`
- Forgejo public HTTP domain: `git.heerlab.com`
- Removed/old alias: `forgejo.heerlab.com`; do not re-add unless explicitly requested.
- Admin/email sender address: `forgejo@heerlab.com`
- Mail provider: Resend through `smtp.resend.com:465`, username `resend`
- Forgejo CLI: `fj`

Forgejo runs from kub-homelab GitOps:

- Main chart file: `cluster/homelab/apps/git/helmrelease.yaml`
- Chart source: `cluster/homelab/apps/git/helmrepo.yaml`
- SSH service: `cluster/homelab/apps/git/ssh-service.yaml`
- App secret sync: `cluster/homelab/apps/git/infisical-sync.yaml`
- Runner secret syncs:
  - `cluster/homelab/apps/git/runner-infisical-sync.yaml`
  - `cluster/homelab/apps/git/personal-runner-infisical-sync.yaml`
- Runner deployments:
  - `cluster/homelab/apps/git/runner-deployment.yaml`
  - `cluster/homelab/apps/git/personal-runner-deployment.yaml`
  - `cluster/homelab/apps/git/extra-runner-deployments.yaml`
- Shared Docker build cache:
  - `cluster/homelab/apps/git/buildkitd.yaml`
  - Service endpoint: `tcp://buildkitd.forgejo-runners.svc.cluster.local:1234`

Do not assume the latest Forgejo app or chart version from memory. Inspect the HelmRelease, chart release, running pods, and upstream release notes before changing versions.

## Current Service Policy

Forgejo is configured as a private personal Git service with public repository visibility:

- Self-registration disabled.
- Registration through Forgejo itself only if registration is re-enabled.
- Email confirmation required for registration.
- CAPTCHA enabled.
- Email addresses hidden by default.
- Guest users can view public repositories (`REQUIRE_SIGNIN_VIEW: false`).
- Actions enabled.
- SSH enabled on public port `22`.
- Forgejo listens internally on SSH port `2222`, but the public service maps port `22` to `2222`.

When changing access policy, update `cluster/homelab/apps/git/helmrelease.yaml`, push, reconcile Flux, and verify the live config from the running pod or UI. Keep user-facing intent explicit because registration, guest access, and repository visibility are easy to mix up.

## Git And Repository Operations

Prefer SSH remotes for local development:

```bash
git remote set-url origin git@git.heerlab.com:beasty/<repo>.git
ssh -T git@git.heerlab.com
```

Create a new Forgejo repository from an existing local repo:

```bash
fj repo create beasty/<repo> --private --ssh --remote origin --push
```

Create or migrate from another Git host:

```bash
fj repo migrate --service github --include all https://github.com/<owner>/<repo> beasty/<repo>
```

Check a repo:

```bash
fj repo view beasty/<repo>
fj repo browse -r beasty/<repo>
```

Treat `Permission denied (publickey,password)` on SSH as an authentication problem, not necessarily a Forgejo outage. Check the user SSH key in Forgejo first. Treat connection refused/timeouts as network or service exposure problems.

## Actions Model

Forgejo Actions is close to GitHub Actions syntax but runs under Forgejo. Workflows live in:

```text
.forgejo/workflows/*.yaml
```

Use `runs-on` labels that match the registered runner labels:

- `runs-on: personal` for the five personal Docker runners.
- `runs-on: global` for the global Docker runner.

Current runner container label mappings are:

- `personal:docker://node:24-bookworm`
- `global:docker://node:24-bookworm`

Do not invent labels such as `personal-infisical`, `self-hosted`, or `docker` unless the runner manifests and Forgejo runner registration are changed together. The simple local policy is one label for personal runners and one label for the global runner.

## Personal Runner Contract

Treat the personal runner pool as a generic trusted execution pool, not as a secret-bearing environment. The five personal runners already provide:

- Five always-running Kubernetes Deployments in `forgejo-runners`.
- One concurrent job per runner through `capacity: 1`.
- The workflow label `runs-on: personal`.
- A `node:24-bookworm` job container.
- Node and npm inside the job container, enough to install the Infisical CLI at runtime.
- Docker command access through the runner-managed DinD sidecar.
- `DOCKER_HOST=tcp://dind.docker.internal:2375` inside job containers.
- Forgejo runner cache enabled at `/data/cache`.
- Shared Docker layer cache through `buildkitd` in `forgejo-runners`, backed by a Longhorn PVC.
- Automatic per-run Forgejo tokens exposed by Forgejo Actions as `FORGEJO_TOKEN` and `GITHUB_TOKEN` for each step.
- Forgejo OIDC request environment variables only when the workflow sets `enable-openid-connect: true`.

The personal runners deliberately do not provide:

- No long-lived `INFISICAL_TOKEN`.
- No preinstalled Infisical CLI guarantee.
- No Forgejo personal access token or admin token for jobs; use the automatic per-run token unless a workflow truly needs broader Forgejo API access.
- No GitHub Actions OIDC identity.
- No GitHub Secrets.
- No Kubernetes Secret mounts for application credentials.
- No runner-level Infisical project defaults.
- No special `personal-infisical` label.
- No shared package or registry publish token.

Do not solve Infisical auth or registry publishing by changing the runner Deployment, adding `INFISICAL_TOKEN` or `FORGEJO_PACKAGE_TOKEN` to Forgejo secrets, adding Infisical values to Kubernetes runner secrets, or creating another runner label. The shared setup is already the reusable part: the same Forgejo OIDC machine identity can accept jobs from allowed `beasty/*` repositories. Each workflow still needs to perform the automatic OIDC exchange during the run because no long-lived Infisical token is preloaded into the runner.

Phrase this precisely when helping other agents: "Use the shared Forgejo OIDC identity from repo variables" does not mean "the runner is already logged into Infisical." It means "the workflow can automatically log in to Infisical without a stored secret."

The local policy intentionally uses one broad Infisical machine identity, not one identity per runner or one identity per project. The workflow's login step is the runtime proof that "this job came from Forgejo repo `beasty/*` on `main`." Infisical then issues a short-lived token for the already-configured identity. No user action is needed per run, and no new Infisical identity is needed when adding a normal new project covered by the same trust model.

For this local, single-user Forgejo instance, preloading one long-lived Infisical token into all runner pods would work technically, but it is not the current default because it makes every job inherit a static all-project secret even when the job does not need secrets. Prefer the OIDC exchange because it keeps the same "one identity can read all projects" simplicity while avoiding a permanent token sitting in runner env, Kubernetes Secrets, or Forgejo Secrets.

Every new workflow using `runs-on: personal` and Infisical must do all of the following. These steps are normal boilerplate, not per-project manual setup:

1. Set top-level `enable-openid-connect: true`.
2. Read the four Forgejo repo variables: `INFISICAL_API_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENV`, and `INFISICAL_MACHINE_IDENTITY_ID`.
3. Install the Infisical CLI during the job, unless the workflow uses a maintained local wrapper that does this.
4. Request a Forgejo OIDC JWT from `ACTIONS_ID_TOKEN_REQUEST_URL` with audience `https://git.heerlab.com/beasty`.
5. Login automatically with `infisical login --method oidc-auth` and the shared machine identity ID from Forgejo variables.
6. Mask the returned short-lived Infisical token.
7. Fetch only the required secrets with `infisical secrets get`.
8. Avoid printing secret values, decoded secret files, or tokens.

For in-cluster personal runners, set `INFISICAL_API_URL` to `http://infisical.auth.svc.cluster.local:8080`, not the browser URL and not the LAN IP. The LAN endpoint can work from a workstation, but the in-cluster DNS endpoint avoids unnecessary routing through the LAN.

Reject these common wrong patterns:

- Using `Infisical/secrets-action` copied from GitHub Actions examples without verifying Forgejo OIDC support.
- Adding `permissions: id-token: write` and omitting `enable-openid-connect: true`.
- Expecting `secrets.PANGOLIN_API_KEY` or `secrets.INFISICAL_TOKEN` to exist in Forgejo.
- Running `infisical login` without `--method oidc-auth`.
- Requesting the OIDC token with GitHub's `https://token.actions.githubusercontent.com` issuer.
- Setting Infisical OIDC discovery to the full `/.well-known/openid-configuration` URL.

Manual dispatch examples:

```bash
fj actions dispatch -R origin smoke-forgejo-actions.yaml main
fj actions dispatch -R origin verify-buildkit.yaml main
fj actions dispatch -R origin verify-personal-runners.yaml main
fj actions dispatch -R origin -I apply_all=true apply-blueprints.yaml main
```

List tasks:

```bash
fj actions tasks -R origin
```

## Renovate Runner Model

Self-hosted Renovate for Forgejo lives in `beasty/forgejo-ci`, not in
`kub-homelab` and not in Mend Cloud. Mend Cloud does not operate on
Forgejo-hosted repositories; Renovate CLI/image does support `platform=forgejo`.

Use a dedicated Forgejo user:

- username: `renovate-bot`
- full name: `Renovate Bot`
- email: `renovate-bot@heerlab.com`
- account policy: non-admin, restricted, no repository creation
- token name: `renovate-forgejo-ci`

The bot token is stored only in Infisical project `Forgejo CI`, environment
`prod`, path `/renovate`, secret `RENOVATE_TOKEN`. Do not store it in Forgejo
secrets, runner env, Kubernetes Secrets, `kub-homelab`, or Git.

If Renovate logs GitHub.com API rate-limit or changelog lookup warnings, store a
GitHub.com token in the same path as `RENOVATE_GITHUB_COM_TOKEN` and inject it
as `GITHUB_COM_TOKEN` for Renovate. Do not store it in Forgejo secrets or runner
environment variables.

Grant `renovate-bot` write collaborator access only to repositories Renovate
should manage. This collaborator list is the practical security boundary. The
initial allowlist is:

- `beasty/kub-homelab`
- `beasty/paperless-llm`
- `beasty/beastypage`
- `beasty/beasty_printer_hub`
- `beasty/infinitune`
- `beasty/moddrop`
- `beasty/tussel`

Do not grant `renovate-bot` collaborator access to `beasty/forgejo-ci`.
Renovate must not modify its own runner/config repository.

The `beasty/forgejo-ci` Renovate config should use `platform: "forgejo"`,
endpoint `https://git.heerlab.com/api/v1/`, `autodiscover: true`, an explicit
`autodiscoverFilter`, `onboarding: true`, `requireConfig: "required"`, and
`gitAuthor: "Renovate Bot <renovate-bot@heerlab.com>"`.

For the local personal runner, disable Renovate's hourly/concurrent rate
limits (`commitHourlyLimit: 0`, `prHourlyLimit: 0`, `prConcurrentLimit: 0`) so
the Forgejo runner can open the backlog immediately like the previous GitHub
setup. Keep the repository allowlist narrow before doing this.

Start with manual dry-runs using `RENOVATE_DRY_RUN=full`. After dry-run output
is clean, add a real scheduled run at a Berlin-local time outside DST transition
hours, for example `05:30 Europe/Berlin`. Keep manual dispatch available and
default it to dry-run mode; require an explicit input such as `dry_run=false`
for manual real runs.

Use API checks when the CLI output is not enough. Never print API tokens:

```bash
TOKEN="$(jq -r '.hosts["git.heerlab.com"].token' ~/.local/share/forgejo-cli/keys.json)"
curl -fsS -H "Authorization: token $TOKEN" \
  "https://git.heerlab.com/api/v1/repos/beasty/<repo>/actions/runs" |
  jq -r '.workflow_runs[] | "run=\(.index_in_repo) workflow=\(.workflow_id) status=\(.status) html=\(.html_url)"'
```

## Runner Operations

The five personal runners are always-running Kubernetes Deployments with `capacity: 1` each. That gives five concurrent `personal` jobs. They are not currently autoscaled to zero per job.

Check the runners:

```bash
kubectl -n forgejo-runners get deploy,pods
kubectl -n forgejo-runners logs deploy/forgejo-personal-runner -c runner --tail=100
```

Restart one runner only after checking active tasks:

```bash
fj actions tasks -R origin
kubectl -n forgejo-runners rollout restart deploy/forgejo-personal-runner-2
```

Avoid restarting runner pods while tasks are active. Forgejo can leave old tasks stuck in `running` if a runner disappears mid-job.

Runner registration credentials are secrets and live in Infisical, not in Git. For runner tokens/UUIDs, use:

- Global runner path: `/kubernetes/forgejo-runners/forgejo-runner`
- Personal runner path: `/kubernetes/forgejo-runners/forgejo-personal-runner`

Do not print runner tokens, registration tokens, personal access tokens, or decoded Kubernetes Secret values.

## Docker Build Cache

Forgejo runner cache and Docker build cache are separate:

- Forgejo runner cache at `/data/cache` is for Actions cache/dependency cache behavior.
- DinD `/var/lib/docker` is per runner pod and uses `emptyDir`; it can help while a pod stays alive, but it is not shared and disappears when the pod is replaced.
- Docker build-and-push workflows should use the shared BuildKit service for persistent layer cache across the personal runner pool.
- Forgejo registry publishing workflows should fetch `FORGEJO_PACKAGE_TOKEN` from Infisical project `Forgejo CI` (`d6d9daf6-28ad-436b-8db5-ccf02ab7c4cc`), environment `prod`, path `/registry`.

Use the current local Docker workflow pattern for Forgejo builds. For publishing workflows, use the shared `beasty/forgejo-ci` registry-login action so app repos do not repeat Forgejo CI platform constants.

```yaml
- name: Checkout repository
  uses: actions/checkout@v6

- name: Install Docker CLI
  run: |
    set -euo pipefail
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates docker.io
    docker --version

- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v4
  with:
    driver: remote
    endpoint: tcp://buildkitd.forgejo-runners.svc.cluster.local:1234

- name: Log in to Forgejo Container Registry
  if: github.event_name != 'pull_request'
  uses: https://git.heerlab.com/beasty/forgejo-ci/actions/registry-login@main

- name: Extract metadata
  id: meta
  uses: docker/metadata-action@v6
  with:
    images: git.heerlab.com/${{ github.repository }}

- name: Build and push
  uses: docker/build-push-action@v7
  with:
    context: .
    push: ${{ github.event_name != 'pull_request' }}
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
```

Do not add `cache-from: type=gha` or `cache-to: type=gha` to Forgejo Docker workflows. The local BuildKit service keeps cache on a Longhorn PVC and avoids network cache upload/download overhead.

Only use the local DinD builder instead of shared BuildKit when a job must `docker run` the just-built image inside the same job. Normal build-and-push workflows should use remote BuildKit.

## Forgejo Variables And Secrets

Use Forgejo Actions variables for non-secret workflow configuration:

```bash
fj actions variables create -R origin INFISICAL_API_URL "http://infisical.auth.svc.cluster.local:8080" --force
fj actions variables create -R origin INFISICAL_PROJECT_ID "71562e7f-98e6-45f1-a031-ca8713b3f0dd" --force
fj actions variables create -R origin INFISICAL_ENV "prod" --force
fj actions variables create -R origin INFISICAL_MACHINE_IDENTITY_ID "3391cc7a-1d47-45b1-914f-027e98c8b3fb" --force
fj actions variables list -R origin
```

Only add these to repos whose workflows directly fetch app-specific Infisical secrets. They are not needed just to use the shared Forgejo registry-login action.

For workflows that publish packages or container images to Forgejo, call the shared `beasty/forgejo-ci` action instead of adding repo-local `FJ_CI_*` variables. The action owns the non-secret Forgejo CI selectors and fetches the real token from Infisical at runtime.

Use Forgejo Actions secrets only for values that must be consumed natively by Forgejo and cannot reasonably be fetched from Infisical. Prefer Infisical for real credentials:

```bash
fj actions secrets create -R origin SOME_NATIVE_FORGEJO_SECRET "$VALUE"
fj actions secrets list -R origin
```

Do not add long-lived Infisical tokens or `FORGEJO_PACKAGE_TOKEN` as Forgejo secrets, runner environment variables, Kubernetes runner secrets, or app-local duplicate secrets. Current policy is OIDC-based login from the workflow to Infisical.

## Forgejo CI Platform Secrets

Use the dedicated Infisical `Forgejo CI` project for shared Forgejo Actions platform credentials that are not kub-homelab runtime secrets and not app-specific secrets:

- Project: `Forgejo CI`
- Project ID: `d6d9daf6-28ad-436b-8db5-ccf02ab7c4cc`
- Environment: `prod`
- Registry path: `/registry`
- Registry secret: `FORGEJO_PACKAGE_TOKEN`
- Access identity: `forgejo-actions-runners` (`3391cc7a-1d47-45b1-914f-027e98c8b3fb`)

Use this project for shared CI/platform credentials such as Forgejo package or container registry publishing. Keep kub-homelab secrets in `Kub-Homelab`, and keep app-specific deployment/runtime secrets in each app's project. A Forgejo Git repo may hold docs or workflow snippets, but do not put secret values in Git.

`INFISICAL_TOKEN` is runtime-only. It is minted by each workflow run after Forgejo OIDC login and must never be stored in Infisical, Forgejo variables, a Git repo, a runner env var, or Kubernetes.

`beasty/forgejo-ci` is the central Git repo for reusable Forgejo CI actions/workflows and non-secret platform selectors such as the in-cluster Infisical URL, environment slug, Forgejo OIDC identity ID, `Forgejo CI` project ID, and registry path. Keep the actual `FORGEJO_PACKAGE_TOKEN` value in the `Forgejo CI` Infisical project only.

When migrating an app workflow to central registry publishing:

1. Keep `enable-openid-connect: true` in the calling workflow.
2. Install Docker CLI before the login action.
3. Call `uses: https://git.heerlab.com/beasty/forgejo-ci/actions/registry-login@main`.
4. Verify a successful publish run.
5. Delete app-local `FJ_CI_*`/Infisical selector variables if they are no longer used.
6. Delete any old app-local duplicate `FORGEJO_PACKAGE_TOKEN`.

## Infisical For Actions

Preferred model:

1. Store real secret values in Infisical.
2. Store only non-secret selectors in Forgejo variables.
3. Enable Forgejo OIDC in the workflow.
4. Exchange the short-lived Forgejo OIDC JWT for a short-lived Infisical token.
5. Fetch only the needed secret values at runtime.
6. Mask and avoid printing secret values.

Shared Infisical machine identity:

- Name: `forgejo-actions-runners`
- ID: `3391cc7a-1d47-45b1-914f-027e98c8b3fb`
- Intended scope: broad local runner identity for the user's Forgejo projects.
- OIDC discovery URL in Infisical: `https://git.heerlab.com/api/actions`
- Bound issuer: `https://git.heerlab.com/api/actions`
- Audience: `https://git.heerlab.com/beasty`
- Subject pattern: `repo:beasty/*:ref:refs/heads/main`
- Repository owner claim: `repository_owner=beasty`

Important Infisical OIDC gotcha: configure the discovery URL as the issuer base `https://git.heerlab.com/api/actions`. Do not set `https://git.heerlab.com/api/actions/.well-known/openid-configuration`; Infisical appends `/.well-known/openid-configuration` itself.

Minimal workflow pattern:

```yaml
name: Example Forgejo Infisical Job

on:
  workflow_dispatch:

enable-openid-connect: true

permissions:
  contents: read

env:
  INFISICAL_API_URL: ${{ vars.INFISICAL_API_URL }}
  INFISICAL_PROJECT_ID: ${{ vars.INFISICAL_PROJECT_ID }}
  INFISICAL_ENV: ${{ vars.INFISICAL_ENV }}
  INFISICAL_MACHINE_IDENTITY_ID: ${{ vars.INFISICAL_MACHINE_IDENTITY_ID }}

jobs:
  example:
    runs-on: personal
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v6

      - name: Install Infisical CLI
        run: |
          set -euo pipefail
          export npm_config_prefix="$RUNNER_TEMP/npm-global"
          mkdir -p "$npm_config_prefix"
          npm install --global @infisical/cli@0.43.91
          echo "$npm_config_prefix/bin" >> "$GITHUB_PATH"

      - name: Login to Infisical with Forgejo OIDC
        run: |
          set -euo pipefail
          : "${INFISICAL_API_URL:?Missing INFISICAL_API_URL Forgejo variable}"
          : "${INFISICAL_MACHINE_IDENTITY_ID:?Missing INFISICAL_MACHINE_IDENTITY_ID Forgejo variable}"
          : "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?Missing Forgejo OIDC request token}"
          : "${ACTIONS_ID_TOKEN_REQUEST_URL:?Missing Forgejo OIDC request URL}"

          oidc_response="$(curl -fsS \
            -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https://git.heerlab.com/beasty")"
          forgejo_jwt="$(node -e 'const fs = require("fs"); const body = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(body.value || "");' <<< "$oidc_response")"
          : "${forgejo_jwt:?Forgejo OIDC response did not include a token}"

          infisical_token="$(infisical login \
            --method oidc-auth \
            --machine-identity-id "$INFISICAL_MACHINE_IDENTITY_ID" \
            --jwt "$forgejo_jwt" \
            --domain "$INFISICAL_API_URL" \
            --plain \
            --silent)"
          : "${infisical_token:?Infisical OIDC login returned an empty token}"
          echo "::add-mask::$infisical_token"
          {
            echo "INFISICAL_TOKEN<<EOF"
            printf '%s\n' "$infisical_token"
            echo "EOF"
          } >> "$GITHUB_ENV"

      - name: Fetch one secret
        run: |
          set -euo pipefail
          SECRET_VALUE="$(infisical secrets get SECRET_NAME \
            --domain "$INFISICAL_API_URL" \
            --token "$INFISICAL_TOKEN" \
            --projectId "$INFISICAL_PROJECT_ID" \
            --env "$INFISICAL_ENV" \
            --path /projects/example/ci \
            --plain \
            --silent)"
          : "${SECRET_VALUE:?Missing SECRET_NAME}"
          echo "::add-mask::$SECRET_VALUE"
          echo "Secret was fetched from Infisical"
```

For kub-homelab CI, known paths include:

- `/kubernetes/ci/pangolin-blueprints`
- `/kubernetes/ci/company-blueprints`

For external project CI, prefer the app's Infisical project for app-specific values. Use `Forgejo CI` for shared Forgejo platform values such as registry publishing. Use the kub-homelab convention `/kubernetes/<namespace>/<secret-name>` only when the value is a Kubernetes runtime secret.

## Adding A New Project

When adding a new Forgejo project that needs Actions and secrets:

1. Create or migrate the repository in Forgejo.
2. Add `.forgejo/workflows/*.yaml`.
3. Use `runs-on: personal` unless there is a concrete reason to use the global runner.
4. Add the OIDC Infisical variables to the Forgejo repo.
5. Store app-specific CI secrets in that app's Infisical project.
6. For package/container publishing, call `https://git.heerlab.com/beasty/forgejo-ci/actions/registry-login@main`.
7. Grant `forgejo-actions-runners` access to any Infisical project it must read if it does not already have it.
8. Use the OIDC login pattern above in workflows.
9. Dispatch a manual smoke or verify workflow.

Current local preference is broad trust for the five personal runners because only the user can commit to the relevant repos. If repository collaboration expands, tighten Infisical identity membership, claims, and secret paths before accepting untrusted workflow changes.

## Verification And Troubleshooting

Check Forgejo app:

```bash
kubectl -n git get pods,svc,hr
kubectl -n git logs deploy/forgejo -c forgejo --tail=100
```

Check SSH:

```bash
ssh -T git@git.heerlab.com
kubectl -n git get svc forgejo-ssh-public
```

Check Actions:

```bash
fj actions tasks -R origin
kubectl -n forgejo-runners get pods
```

Check shared BuildKit:

```bash
fj actions dispatch -R origin verify-buildkit.yaml main
kubectl -n forgejo-runners get pod buildkitd-0
kubectl -n forgejo-runners exec buildkitd-0 -- buildctl --addr tcp://127.0.0.1:1234 debug workers
kubectl -n forgejo-runners exec buildkitd-0 -- du -sh /var/lib/buildkit
```

Check Infisical OIDC failures:

- Missing `ACTIONS_ID_TOKEN_REQUEST_TOKEN` or `ACTIONS_ID_TOKEN_REQUEST_URL`: workflow probably lacks `enable-openid-connect: true`.
- Infisical discovery 404: OIDC discovery URL is probably the full well-known URL instead of the issuer base.
- Infisical 403: machine identity lacks project membership or bound claims do not match the repo/ref.
- Secret missing: check project ID, environment slug, path, and secret name without printing values.

Run checks before pushing kub-homelab Forgejo changes:

```bash
kustomize build cluster/homelab
git diff --check
gitleaks git --staged --no-banner --redact
lefthook run pre-commit
```

After pushing GitOps changes:

```bash
flux reconcile source git flux-system -n flux-system
flux reconcile kustomization git -n flux-system --with-source
```

## Learn More

- Local kub-homelab Forgejo Actions doc: `<kub-homelab>/docs/forgejo-actions.md`
- Local Pangolin blueprint workflow doc: `<kub-homelab>/docs/pangolin-blueprints.md`
- Local backup coverage doc: `<kub-homelab>/docs/backup-coverage.md`
- Forgejo site: `https://forgejo.org/`
- Forgejo docs: `https://forgejo.org/docs/latest/`
- Forgejo Actions admin docs: `https://forgejo.org/docs/latest/admin/actions/`
- Forgejo Runner docs: `https://forgejo.org/docs/latest/admin/runner-installation/`
- Forgejo CLI project: `https://codeberg.org/Cyborus/forgejo-cli`
