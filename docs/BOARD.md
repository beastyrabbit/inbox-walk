# Release status

Last updated: 2026-10-10

## Release

`v0.10.0` is the release described by this source tree.

## Shipped

- [x] Continuous unread-mail todo with JMAP push and poll fallback.
- [x] Codex sorting sessions with read-only mailbox tools and app-only bucket tools.
- [x] Bounded automatic retries, manual retry, and visible login pause.
- [x] User-written memory notes with accept-or-reject proposals.
- [x] Buckets that close when their messages are done and reopen with new mail.
- [x] Exact read-state changes and parking that keeps mail unread.
- [x] Reader with safe HTML isolation, remote-image proxying, and responsive layouts.
- [x] Editable reply state and verified Fastmail draft construction with no send path.
- [x] Deferred newsletter labeling without automatic unsubscribe requests.
- [x] Codex configuration for model, reasoning, and speed.
- [x] Health/readiness endpoints, container builds, unit/API tests, and desktop/mobile browser tests.

## Deferred until needed

- [ ] Add operational metrics if live troubleshooting shows a concrete need.
- [ ] Add per-message completion if whole-bucket completion becomes too coarse.
- [ ] Add a separate Spam queue with a “Not Spam” action.
