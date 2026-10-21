# Public Umami 3.4.0 test fixtures

Fetched read-only on 2026-10-21 from https://umami.heerlab.com/script.js and
https://umami.heerlab.com/recorder.js. No collection endpoints were called.
These files run only against Playwright route stubs. Production loads the
configured runtime host directly.

SHA-256 of the checked-in fixtures:

- script: `654f12c7548be726eba5b71d5ef8bffc2a41a39a0053e2a49a847869ccd7ac3f`
- recorder: `21e6312866db01a71841b772c9882333231be1bc3fdbeeac1ed5193794ad80c6`

The recorder defaults to `blockClass="rr-block"` and
`maskTextClass="rr-mask"`. A custom `blockSelector` is passed as a separate
option and preserves both defaults. `maskTextClass` uses `closest` on parent
elements, so the root mask covers text descendants and text mutations.
Strict mode adds `maskTextSelector="*"`; all modes set `maskAllInputs=true`.
Canvas and cross-origin iframe recording are disabled. The app blocks mail
iframes, mail summaries, the reader, settings and reply editor and filters
recorder requests because these options alone do not mask DOM attributes,
CSS, custom events or URLs.

When updating these fixtures, inspect the deployed scripts again and update
the assertions in `server/recorder-contract.test.ts`. Never enable replay merely
because the script name or major version matches.
