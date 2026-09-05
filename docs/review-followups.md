# September 2026 review follow-ups

This change addresses the [5 September project review](https://schaffa.dev/p/4nez8hjbjslpnmf4), including its reliability, verification and optional cleanup tasks.

| Finding | Result |
| --- | --- |
| F1 | Completion waits for the selected original. Pending loads block finalization; a late failure protects its original in the same round even after navigation. |
| F2 | Reply results merge into the current editor. Manual body edits win; newer notes, recipients, subject and correction text survive. Round ownership guards discard stale results. |
| F3 | JMAP reports confirmed progress after each batch and the API saves it immediately. Failed transport responses trigger a bounded read-back reconciliation. Restarted retries omit persisted successes. |
| F4 | All four Pi loaders share explicit isolation options, including an empty append-system-prompt list. |
| F5 | To/Cc retain raw text in server checkpoints. Draft creation parses quoted display names and validates complete addresses. |
| F6 | Any truncated thread body rejects the reply before attachment work or inference. |
| F7 | An outgoing latest message selects its matching From identity and signature. Incoming replies retain addressed-identity selection. |
| F8 | Partition tool and validation bounds follow the frozen snapshot size, including persisted partitions. |
| F9 | Browser tests never reuse a server and check demo mode before mutations. A harmless occupied-port probe verifies zero POST requests. |
| F10 | Cache pruning retains snapshots with reply, draft, request-body or finalization ownership. |
| F11 | Bundle materialization indexes messages by ID and preserves source and chronological ordering. |
| F12 | HTTP operations share a five-minute I/O budget. JMAP calls have 30-second deadlines, blob transfers 120 seconds, and remote images 10 seconds across DNS, redirects and body transfer. Attachment and extraction streams enforce byte/text limits before buffering. |

Remote-success/local-crash ambiguity remains possible. A successful reconciliation can confirm the current remote state, but an unreachable read-back leaves that batch pending. Error responses distinguish confirmed, unknown and unattempted IDs. Persisted confirmed batches are never retried. For unresolved outcomes, inspect Fastmail before retrying if intervening changes matter; this is not an exactly-once protocol.

Blob downloads have a 100 MiB size limit and a 120-second total transfer limit, including the transfer to the browser. Slow client connections can therefore time out after response headers have been sent, and the browser will report an incomplete download. This limit deliberately bounds the entire streaming operation. Background snapshot and analysis jobs do not inherit the spawning HTTP request's five-minute budget; they keep their own cancellation and per-call limits.

Named recipients are displayed as `"Name" <email>`, including restored drafts that predate raw recipient fields. Partially quoted display names retain their full text.

## Dependencies and delivery checks

DOMPurify, Vite, tsx and their compatible transitive dependencies were updated with pnpm. Pi releases after the installed adapter version remove its authentication API, so Pi stays at 0.80.7 with pnpm-generated patched Undici and esbuild overrides. The overrides can be removed when a compatible dependency update incorporates the fixes. No authentication migration or live inference was needed.

CI checks the advisory inventory through `scripts/check-advisories.ts`. New matches fail for review. A reviewed exception must name the advisory, package, exact version, applicability reason and expiry in `docs/advisory-exceptions.json`; publisher severity alone does not establish application exposure. There are no exceptions at present.

The browser suite and verification scripts now have TypeScript checks. Tag builds must match `package.json`. The container job boots the final pruned Node 24 image as its non-root user in demo mode and verifies probes, the UI, writable storage and round analysis before publication.

## Large-round profile

Run `MAIL_REVIEW_DEMO=1 node --expose-gc --import tsx scripts/profile-rounds.ts`. It uses synthetic summaries, standalone groups and 25,010-character received bodies. Timings below are one local Node 26 run, not production guarantees.

| Messages | Restore before | Restore after | Build after | State serialization p50 / p95 | State payload | Retained bodies |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 90.5 ms | 27.9 ms | 43.5 ms | 0.1 / 0.2 ms | 15.7 KiB | 23.9 MiB |
| 5,000 | 1,269.3 ms | 12.7 ms | 60.3 ms | 0.3 / 3.5 ms | 82.1 KiB | 119.4 MiB |
| 10,000 | 6,583.6 ms | 28.4 ms | 119.2 ms | 0.4 / 0.9 ms | 165.1 KiB | 238.8 MiB |

The restore profile justified replacing repeated bundle scans with ID indexes. State serialization does not justify an incremental protocol in this fixture. Received bodies can dominate memory if many large originals are opened; this profile measures retention, not actual usage frequency or browser layout cost. Keep lazy loading and round-scoped caches. Virtualization or eviction needs a measured user workload before changing navigation or reply context behavior.

Small editor, restore and provider-option helpers make the corrected boundaries explicit. The old contextual grouping proposal now says it is superseded, and test names distinguish sandbox configuration from successful image loading.

Validation uses demo data or injected local transports only. Fastmail, Codex inference and production infrastructure are outside automated verification.
