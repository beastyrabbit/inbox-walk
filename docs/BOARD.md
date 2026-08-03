# Release status

Last updated: 2026-08-03

## Current release

`v0.5.2` is the current usable release. It is deployed in kub-homelab at
<https://inbox-walk.heerlab.com> behind Pangolin `BeastyOnly` authentication.
Forgejo publishes immutable images and Flux deploys the pinned release tag.

There are no active release blockers.

## Shipped

- [x] Stable bounded JMAP unread snapshot and exact checkpoint resume.
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
