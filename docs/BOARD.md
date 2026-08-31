# Release status

Last updated: 2026-08-31

## Release

`v0.9.1` is the release described by this source tree. Forgejo publishes its
immutable image, and Flux deploys the pinned tag through kub-homelab to
<https://inbox-walk.heerlab.com> behind Pangolin `BeastyOnly` authentication.

## Shipped

- [x] Complete paginated JMAP unread snapshot without a fixed message limit.
- [x] Contextual review bundles for related repository, deployment, order, and carrier mail.
- [x] Per-original keep-unread controls while Codex owns automatic story grouping.
- [x] Durable review rounds with immediate IDs, stable URLs, visible backend progress, and ready-to-open gating.
- [x] Round deletion that cancels active backend work, plus reanalysis of the same frozen snapshot.
- [x] Safe reanalysis of completed rounds with a fresh review state and preserved reply drafts.
- [x] Persisted bundle analysis, review decisions, drafts, and finalization across reloads and restarts.
- [x] Null-safe Fastmail address normalization and resilient gateway error handling.
- [x] Lazy detail loading, safe email rendering, and streamed allowlisted blobs.
- [x] Safe remote-image proxying with authenticated same-origin iframe resources.
- [x] Dedicated pre-review selection for normal mail or Spam with direct controls.
- [x] Mailbox, newsletter, and time selection plus a message overview.
- [x] Optional deferred-message exclusion backed by a minimal SQLite history.
- [x] History reconciliation that retains only deliberately kept-unread mail.
- [x] Keyboard navigation, accessible announcements, and responsive layouts.
- [x] Partial-safe finalization with exact success tracking and retries.
- [x] Separate Spam review with an explicit deferred “Not Spam” action.
- [x] Deferred newsletter-unsubscribe labeling without automatic link execution.
- [x] Full-thread assisted replies with automatic all-attachment handling.
- [x] Codex connection, Sol/Terra/Luna model selection, and thinking level in Settings.
- [x] Complete snapshot analysis without a per-round provider-call cutoff.
- [x] One global Codex partition with deterministic duplicate resolution and standalone completion.
- [x] Visible application release version.
- [x] Editable and revisable reply text with selectable identity and recipients.
- [x] Verified Fastmail draft construction with no send-mail path.
- [x] Unit, API, security-contract, desktop, and mobile browser tests.
- [x] Real-mail rendering validation across transactional and newsletter layouts.
- [x] Production Node container and health/readiness endpoints.
- [x] Forgejo repository, container workflow, Lefthook, Biome, and Gitleaks.
- [x] Dedicated Infisical project with viewer-only Kubernetes workload identity.
- [x] Healthy kub-homelab rollout with Infisical sync, Pangolin, and Homepage.

## Deferred until needed

- [ ] Add operational metrics only if live troubleshooting shows a concrete need.
- [ ] Reassess the broad personal-runner trust boundary if repository collaboration expands.
