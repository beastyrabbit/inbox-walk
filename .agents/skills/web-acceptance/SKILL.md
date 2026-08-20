---
name: web-acceptance
description: Use when the user asks to verify a web UI completely, visually, responsively, or end to end in this repository.
---

# Run Web Acceptance

Read project instructions and identify the user-visible behavior changed.

1. Run the repository's focused lint, type, unit, and build checks for the touched UI.
2. Start the documented local development command and use the URL printed by the server.
3. Open the page in the product-native preview browser and inspect semantic state before interacting.
4. Exercise the changed happy path plus the most relevant empty, loading, error, and permission states without calling live paid providers.
5. Check desktop and one representative mobile viewport. Inspect overflow, focus order, keyboard access, labels, contrast, reduced motion, and console/network errors.
6. Compare implementation with the original request and existing design system. Do not redesign unrelated surfaces.
7. Capture screenshots only when they materially prove the result and contain no private data.
8. Stop the server you started without killing unrelated processes.

Return checked routes and viewports, commands and outcomes, screenshots when useful, defects found or fixed, and any untested risk.
