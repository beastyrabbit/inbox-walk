# Release status

Last updated: 2026-09-19

## Release

`v0.10.0` is the release described by this source tree. GitHub Actions publishes
its immutable image, and Flux deploys the pinned tag through kub-homelab to
<https://inbox-walk.heerlab.com> behind Pangolin `BeastyOnly` authentication.

## Shipped

- [x] Continuous todo: JMAP push plus a fallback poll queue and sort unread mail without a manual run.
- [x] Codex sorting sessions with read-only mailbox tools and app-only bucket tools.
- [x] Bounded automatic retries, manual retry, and a visible pause while Codex is logged out.
- [x] User-written memory note for Codex with accept-or-reject proposals.
- [x] Buckets that close on their own and reopen on new mail.
- [x] Done marks exactly the shown messages read; parking keeps a message unread outside the todo.
- [x] Reconciliation with mail read or deleted in Fastmail.
- [x] Reader that keeps mail designs intact with a dark or original colour switch and one pane per story message.
- [x] Persisted reply editor per message and verified Fastmail draft construction with no send-mail path.
- [x] Deferred newsletter-unsubscribe labeling without automatic link execution.
- [x] Safe remote-image proxying and script-free sandboxed rendering.
- [x] Codex login that follows the Codex CLI configuration for model, reasoning and speed.
- [x] Unit, API, desktop, and mobile browser tests in demo mode.
- [x] Production Node container, health and readiness endpoints, Lefthook, Biome, Gitleaks, SonarQube.

## Deferred until needed

- [ ] Spam triage as a separate queue with a "Not Spam" action.
- [ ] Operational metrics if live troubleshooting shows a concrete need.
- [ ] Per-message done inside a bucket if whole-bucket completion turns out to be too coarse.
