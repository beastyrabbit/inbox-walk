#!/usr/bin/env bash
set -euo pipefail
image=${1:?Pass the locally built runtime image}
container=$(docker run --detach --rm -e MAIL_REVIEW_DEMO=1 "$image")
trap 'docker stop "$container" >/dev/null' EXIT
for attempt in $(seq 1 30); do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
docker exec "$container" node --input-type=module -e '
import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
assert.equal(process.versions.node.split(".")[0], "24");
assert.notEqual(process.getuid(), 0);
await access("/data", constants.W_OK);
const base = "http://127.0.0.1:3000";
for (const path of ["/healthz", "/readyz", "/"]) assert.equal((await fetch(base + path)).status, 200);
assert.equal((await (await fetch(base + "/api/review/options")).json()).mode, "demo");
const response = await fetch(base + "/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filters: { mailboxId: null, newsletter: "all", timeRange: "all" } }) });
assert.equal(response.status, 202);
const run = await response.json();
assert.ok(run.id);
for (let attempt = 0; attempt < 50; attempt += 1) {
  const round = await (await fetch(base + "/api/reviews/" + run.id)).json();
  if (round.bundleRun) { assert.ok(round.emails.length); break; }
  assert.ok(attempt < 49, "Demo analysis must finish");
  await new Promise(resolve => setTimeout(resolve, 100));
}
console.log("Node 24 non-root demo runtime, static assets and SQLite round creation passed.");
'
