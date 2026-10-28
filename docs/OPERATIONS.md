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

## Legal pages

`GET` and `HEAD` on `/impressum`, `/datenschutz`, `/legal-notice` and `/privacy`
serve standalone legal HTML before API/session and application telemetry handling.
The authentication proxy needs an exact-path bypass for those four paths only;
no asset bypass is needed. These pages use system fonts, hash-approved inline CSS,
no scripts or cookies, and a separate CSP that blocks resource and network requests.
Requests with encoded percent signs, slashes or backslashes, literal backslashes,
dot segments, repeated slashes or malformed percent-encoding are rejected before
routing. The guard also models the authentication proxy's double decoding and path
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
It needs no app session, and remains behind the deployment's authentication proxy.

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

If the Umami host sits behind authentication, the script loads but records
nothing until the proxy exposes that public GET path alongside `script.js`,
`recorder.js`, `api/send` and `api/record`. No proxy is added here.
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
including manual runs, after the `main-ci` gate succeeds. Only this job has
`id-token:write`. The `container` job builds for
PRs and main when `sourcemaps` is skipped; tag publication requires a successful
upload. Both jobs use the same remote BuildKit endpoint and cached build stage.
The source-map job fetches `GLITCHTIP_AUTH_TOKEN` from the deployment secret
manager through OIDC and passes it only through the uploader's
`SENTRY_AUTH_TOKEN` environment variable.

`sentry-cli sourcemaps upload` targets the GlitchTip project `inbox-walk`,
release `inbox-walk@<version>`, with `--strict`. The upload does not wait for
processing: GlitchTip 6.2.6 stores the bundle on assembly but never reports a
final processing state to `--wait` polling. GlitchTip 6.2.6 supports debug-ID artifact bundles. No legacy
URL-prefix upload or release new/finalize commands are needed; the token needs
only `project:releases`. Upload, authentication and assemble-request failures,
plus anything `--strict` rejects, fail the job and block image publication.
Processing after a successful upload is not awaited, so a later GlitchTip-side
assembly failure does not block publication. After each release, list the
release files through the GlitchTip API (`releases/inbox-walk@<version>/files/`)
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
