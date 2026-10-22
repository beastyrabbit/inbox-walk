# Operations

## Production contract

- Release described by this source tree: `v0.12.2`
- URL: <https://inbox-walk.heerlab.com>
- Access: Pangolin `BeastyOnly`
- Public application: no. Analytics runs without a consent banner inside SSO.
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

## Legal pages

`GET` and `HEAD` on `/impressum`, `/datenschutz`, `/legal-notice` and `/privacy`
serve standalone legal HTML before API/session and application telemetry handling.
Pangolin needs an exact-path authentication bypass for those four paths only;
no asset bypass is needed. These pages use system fonts, hash-approved inline CSS,
no scripts or cookies, and a separate CSP that blocks resource and network requests.
Requests with encoded percent signs, slashes or backslashes, literal backslashes,
dot segments, repeated slashes or malformed percent-encoding are rejected before
routing. The guard also models Badger/Pangolin's double decoding and path
normalisation: any path that resolves to a legal path must match it byte-for-byte.
They send both a robots `noindex` meta tag and `X-Robots-Tag: noindex`.
The rest of the app keeps its existing CSP. Legal copy lives in
`server/legal/content.ts`; privacy sections are numbered by their array order.
The shared `LEGAL_DATE` contains both language versions of the publication date.
The publication test rejects unresolved placeholders on all four rendered pages.

## Telemetry

All configuration is read from the server environment at startup. No per-environment
values or secrets are compiled into JavaScript. `GET /api/client-config` exposes
only public telemetry configuration and `release`, with `Cache-Control: no-store`.
It needs no app session, and remains behind the deployment's Pangolin boundary.

- `UMAMI_URL`: HTTPS origin of the self-hosted Umami installation. Requires `UMAMI_WEBSITE_ID`, a website UUID. Missing or invalid configuration disables Umami.
- `UMAMI_REPLAY`: `off`, `false`, or `0` disables the recorder and heatmaps. Defaults to on when Umami is configured. Replay is also disabled when Umami shares the app's origin; analytics remain enabled.
- `GLITCHTIP_DSN`: public project DSN, with HTTPS origin, public key and numeric project path. Missing or invalid configuration disables both browser and Node error tracking.
- `GLITCHTIP_ENVIRONMENT`: short environment label, default `production`.
- `GLITCHTIP_TRACES_SAMPLE_RATE`: number from 0 to 1, default `0.1`. Set to `0` for errors only.

URLs with passwords, searches or fragments are rejected. Plain HTTP is accepted
only for `localhost` or `127.0.0.1` with `NODE_ENV=test`. Unset configuration is
the local/demo/preview default; demo tests explicitly inject fake targets. Never
put the CI upload token in runtime configuration or client config.

The CSP adds the validated Umami origin to `script-src` and `connect-src`, and
the DSN origin to `connect-src` only. No extra origins appear when unset. The
recorder uses no worker, so `worker-src 'none'` stays in force. Scripts are
external and use `referrerPolicy=no-referrer`; no inline-script exemption is
needed. Same-origin API tracing headers are limited to `/api`.

Browser SDK code loads lazily after config. The Node SDK is preloaded before
application imports using `node --import ./dist-server/instrument.js`; Vite
development does not preload it. Both use `inbox-walk@<package version>`,
`sendDefaultPii:false`, the same scrubber, and no Sentry Replay. Node captures
process exceptions/rejections and explicit API, frontend, poll and sort errors.
HTTP/body/header/cookie, provider, console and local-variable integrations are
disabled on Node. Browser console errors and unhandled failures are captured;
the React boundary provides a German reload fallback. Unknown error messages,
console arguments, breadcrumbs, tags, contexts and metadata are discarded,
including subjects that cannot be recognized by a token-redaction expression.
Build-owned filenames, line numbers and debug IDs survive for symbolication.
Transactions keep a route template and timings; child spans are dropped.

### Replay masking and heatmaps

The deployed scripts inspected for this release are Umami 3.4.0. The recorder
accepts `data-website-id` and `data-host-url`; it fetches
`/api/websites/<website UUID>/recorder` with `credentials:"omit"`. Its website
configuration should enable replay and heatmaps, sample both at 1, use
`maskLevel:"strict"`, `maxDuration:300000`, and
`blockSelector:"[data-telemetry-block]"`.

The recorder maps strict mode to rrweb `maskAllInputs:true` and
`maskTextSelector:"*"`. In all modes it sets `maskAllInputs:true`, with
`recordCanvas:false` and `recordCrossOriginIframes:false`. Its rrweb defaults
remain `blockClass:"rr-block"` and `maskTextClass:"rr-mask"` when a custom
block selector is passed. The root's `rr-mask` is inherited through `closest`
for initial snapshots and text mutations, protecting text even if the remote
mask level changes to moderate. Mail list rows, the whole reader card, each
mail iframe, notes/proposals, settings and reply panel are blocked with
`rr-block` and `data-telemetry-block`. Do not remove either marker.

Masking alone leaves URL and attribute leaks. A recorder-only fetch guard
reconstructs outgoing replay/heatmap data, templates metadata and heatmap URLs,
masks any remaining text, strips arbitrary attributes and unknown payloads,
and drops custom events, plugins, CSS mutations and oversized fragmented
snapshots. Captured CSS becomes a reference to the build's static stylesheet.
The guard retains a fixed set of layout classes and numeric rrweb mirror IDs,
which are unrelated to Fastmail IDs. Replay therefore shows masked chrome and
blocked placeholders, with reduced styling where attributes were removed.
Heatmaps retain click/scroll coordinates and fixed paths. Mail iframe links
never reach the top-document click listener or heatmap listener.

The public host currently returns 401 for the recorder-config path. The script
loads but records nothing until Pangolin exposes that public GET path alongside
`script.js`, `recorder.js`, `api/send` and `api/record`. No proxy is added here.
Provisioning and that allowlist are managed separately. Verify this GET returns
200 without a cookie before expecting sessions. Future recorder upgrades must
be re-inspected and the fixture privacy tests updated before enabling them.

Telemetry writes no cookies, localStorage or sessionStorage. The inspected
tracker reads `localStorage["umami.disabled"]` if present but never writes it;
its anonymous session cache remains in memory and is returned in
`x-umami-cache`. BrowserSession and client reports are disabled in the SDK.
The existing `inbox-walk.mail-colors` key is an app preference, not telemetry.
No identify call or user identity is sent.

### Event catalogue

Every event has a fixed name and an allowlist of properties. `interaction` is
`keyboard`, `click` or `automatic`. Counts are bounded integers. `duration` is
`under_1s`, `under_10s`, `under_60s` or `over_60s`. Failure `category` is
`network`, `authentication`, `attachment`, `timeout`, `server` or `unknown`.

- `app_loaded` → `mode` (`demo` or `live`).
- `bucket_opened`, `reply_panel_opened`, `keyboard_help_opened` → `interaction`.
- `bucket_done`, `message_parked`, `message_unparked`, `newsletter_tagged`, `sort_retry_requested` → `message_count`, `interaction`.
- `reply_draft_created` → `duration`, `attachment_count`.
- `reply_draft_failed` → `category`, `duration`, `attachment_count`.
- `fastmail_draft_saved` → no properties. `fastmail_draft_failed` → `category`.
- `memory_proposal_accepted`, `memory_proposal_rejected`, `memory_note_saved` → no properties or note lengths/text.
- `codex_connect_started`, `codex_connect_succeeded`, `codex_connect_failed` → no properties.
- `original_colours_toggled` → `enabled`, `interaction`.
- `outbound_link` → allowlisted chrome destination `hostname` only, currently `auth.openai.com`. Mail links and attachment links are excluded.
- `api_failure` → `route` template, `status_class` (`network`, `4xx`, `5xx`, `other`).

Pageviews use `/`, `/bucket`, `/settings`, `/reply`, `/help` and `/parked`.
The title is always `Inbox Walk`, searches/hashes and referrers are stripped,
and the tracker is restricted to the current hostname. Built-in performance
collection emits at most one sanitized payload per load with rounded
TTFB/FCP/LCP/INP/duration milliseconds and CLS to three decimal places. The
release is the tracker tag. Unknown events and property values are dropped.

### Source maps and CI

Vite emits hidden client maps; tsup emits server maps for both entrypoints and
shared chunks. Inside Docker's build stage, `sentry-cli sourcemaps inject dist
dist-server` adds debug IDs. The `sourcemaps` target exports those exact files
and maps. The runtime target shares the cached build stage, removes every
client `.map` before copying `dist`, and keeps server maps outside `dist`.
The HTTP server also rejects `.map` paths for local production builds.

The `sourcemaps` job exports and uploads artifacts on every `v*` tag-ref run,
including manual runs, after `quality` succeeds. Only this job has
`id-token:write`. The `container` job builds for
PRs and main when `sourcemaps` is skipped; tag publication requires a successful
upload. Both jobs use the same remote BuildKit endpoint and cached build stage.
The source-map job uses the pinned Infisical secrets action
with OIDC, repository variable `INFISICAL_GITHUB_ACTIONS_IDENTITY_ID`, LAN
domain `http://192.168.60.11:8080`, project `kub-homelab`, environment `prod`,
path `/projects/inbox-walk/ci`. It injects `GLITCHTIP_AUTH_TOKEN`, passed only
through the uploader's `SENTRY_AUTH_TOKEN` environment variable.

`sentry-cli --url http://192.168.60.68:8000 sourcemaps upload` targets org
`beasty-rabbit`, project `inbox-walk`, release `inbox-walk@<version>` with
`--strict`. The upload does not wait for processing: GlitchTip 6.2.6 stores the
bundle on assembly but never reports a final processing state to `--wait`
polling. GlitchTip 6.2.6 supports debug-ID artifact bundles. No legacy
URL-prefix upload or release new/finalize commands are needed; the token needs
only `project:releases`. Upload, authentication and assemble-request failures,
plus anything `--strict` rejects, fail the job and block image publication.
Processing after a successful upload is not awaited, so a later GlitchTip-side
assembly failure does not block publication. After each release, check
`http://192.168.60.68:8000/api/0/organizations/beasty-rabbit/releases/inbox-walk@<version>/files/`
and verify that every JS file has a `debug-id`. The token never enters Docker
build arguments, image layers or browser configuration.
The uploader remains on CLI 2.x and SDKs on 10.x for the documented
`sendDefaultPii` API and compatibility with this GlitchTip deployment.

### Verification

Run `pnpm check`, `pnpm build` and `pnpm test:e2e`. The browser harness starts
two built demo servers with isolated SQLite and Codex homes. The unconfigured
server has no telemetry variables; the configured one uses fake Umami hosts
and a local GlitchTip collector. Playwright routes every browser telemetry
request to stubs and serves the inspected public scripts from fixtures. Both
strict and moderate recorder settings must pass the outgoing mail-leak scan,
workflow/error/release/environment checks, masking-marker checks, replay and
heatmap checks, and browser-storage checks. No live provider is contacted.

Build `docker build --target runtime -t inbox-walk:telemetry-check .`, run
`bash scripts/smoke-container.sh inbox-walk:telemetry-check`, and export
`docker build --target sourcemaps --output type=local,dest=/tmp/inbox-walk-maps .`.
Compare runtime JS bytes/debug IDs with the export, and confirm no runtime
`dist/**/*.map` files remain. In production, use the browser Network panel to
check fixed paths and masked recordings, then inspect a scrubbed error's
symbolicated stack after the tagged release's upload succeeds. Do not paste
real mail into diagnostics or print tokens. App telemetry integrations for
PostHog, Sentry SaaS and Google Analytics were absent before this change.

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

Release 0.10 replaced the review-round storage with the continuous todo; see
the migration notes above. The image hand-off is now owned by Flux image
automation in `beastyrabbit/kub-homelab`, so Inbox Walk's GitHub workflow only
builds and publishes the tagged image. Releases 0.9.x kept review rounds in
the same database; none of them require action before upgrading to 0.10.

## Deployment path

1. PRs, main pushes and manual branch runs validate the project and boot the production Dockerfile's non-root demo container on `arc-inbox-walk`. They do not publish images. Fork PRs remain excluded.
2. A `v*` tag, including a manual run targeting a tag, must match the package version. It skips the quality job and waits up to 35 minutes for the newest `ci.yaml` push-to-main run on the exact peeled tag commit to finish successfully. Missing or pending runs are polled; a failed run, API error or timeout blocks publication. PR runs, manual runs and ancestor commits cannot satisfy the gate.
3. After the gate passes, Actions exports and uploads source maps, scans for secrets, builds the production runtime and boots the non-root demo container. Only then does it publish `ghcr.io/beastyrabbit/inbox-walk` with the release's semver tags. No `main` or `latest` images are published.
4. Flux image automation in `beastyrabbit/kub-homelab` observes the published tags and updates the workload's immutable image reference. Do not add a deploy hand-off job to this repository; the current workflow has no `notify-homelab` job.
5. The Infisical Operator syncs the Fastmail token to namespace `tools`; Flux applies the workload, Longhorn PVC, Tika Service, and Infisical resources from kub-homelab. Roll back with the corresponding GitOps change there.
6. The tag run's `post-deploy` job checks internal Service reachability for up to a minute, then polls `http://inbox-walk.tools.svc.cluster.local:3000/api/client-config` until `release` exactly matches `inbox-walk@<package version>`. It then GETs `/` and `/healthz`, requiring application HTML and JSON health status `ok`. Redirects and malformed responses fail. The overall 25-minute deadline covers Flux's two 2-minute polling intervals, reconciliation and the HelmRelease's 15-minute timeout. Individual requests have a 10-second deadline. A newer semver release reports `superseded` in the job log and exits successfully without claiming that the older release was smoke-tested. Failure does not undo a published image or roll back Flux.
7. The tools Pangolin blueprint exposes `https://inbox-walk.heerlab.com` to the `BeastyOnly` role. The smoke uses the internal Service because this public URL requires SSO.
8. Homepage lists the service under Additional Services.

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
