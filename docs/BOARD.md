# Delivery board

Last updated: 2026-08-02

## In progress

- [ ] Replace the expired Fastmail token, deploy the ChatGPT-subscription provider, and repeat live verification.

## Done

- [x] Stable bounded JMAP unread snapshot and exact checkpoint resume.
- [x] Lazy detail loading, safe email rendering, and streamed allowlisted blobs.
- [x] Mailbox, newsletter, and time filters plus a message overview.
- [x] Keyboard navigation, accessible announcements, and responsive layouts.
- [x] Partial-safe finalization with exact success tracking and retries.
- [x] Full-thread assisted replies with automatic all-attachment handling.
- [x] Editable and revisable reply text with selectable identity and recipients.
- [x] Verified Fastmail draft construction with no send-mail path.
- [x] Unit, API, security-contract, desktop, and mobile browser tests.
- [x] Production Node build and health/readiness endpoints.
- [x] Public Forgejo repository, container workflow, Lefthook, Biome, and Gitleaks.
- [x] Dedicated Infisical project with viewer-only Kubernetes workload identity.
- [x] Independent implementation/security review and release-blocker remediation.
- [x] Approved live acceptance attempts (Fastmail rejected the stored token; OpenAI reported no credits).
- [x] Public `v0.1.0` Forgejo release and immutable container image.
- [x] Healthy kub-homelab rollout with Infisical sync, Pangolin `BeastyOnly` SSO, and Homepage.

## After first release

- [ ] Observe real-mail rendering edge cases and tune body-size bounds if needed.
- [ ] Add operational metrics only if live troubleshooting shows a concrete need.
- [ ] Reassess the broad personal-runner trust boundary if repository collaboration expands.
