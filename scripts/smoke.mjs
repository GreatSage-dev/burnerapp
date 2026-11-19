import assert from "node:assert/strict";
import { createAppServer } from "../src/server.mjs";
import { resetSandbox } from "../src/tools/local-tools.mjs";

async function runSmoke() {
  const start = performance.now();
  const { server, sandboxRoot } = createAppServer({ apiKey: "" });
  resetSandbox(sandboxRoot);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const judgeRes = await fetch(`${base}/judge`);
    assert.equal(judgeRes.status, 200);

    // Scenario 1: Repo Triage (Green Path + Adversarial /rob Probe + Burn)
    const repoSpawn = await fetch(`${base}/api/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "repo-triage" })
    }).then((r) => r.json());
    assert.equal(repoSpawn.ok, true);

    const beforePatch = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: repoSpawn.session.burnerId,
        toolName: "repo_test_runner",
        params: {}
      })
    }).then((r) => r.json());
    assert.equal(beforePatch.toolResult.failed, 2);

    const afterPatch = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: repoSpawn.session.burnerId,
        toolName: "repo_patch_apply",
        params: {}
      })
    }).then((r) => r.json());
    assert.equal(afterPatch.toolResult.testResult.passed, 3);
    assert.equal(afterPatch.toolResult.testResult.exitCode, 0);

    const rogueEnv = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: repoSpawn.session.burnerId,
        toolName: "fs_bundle_inspect",
        params: { path: ".env" }
      })
    });
    assert.equal(rogueEnv.status, 403);

    const burnRes = await fetch(`${base}/api/burn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ burnerId: repoSpawn.session.burnerId })
    }).then((r) => r.json());
    assert.equal(burnRes.burned, true);

    // Scenario 2: Bill Splitter
    const billSpawn = await fetch(`${base}/api/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "bill-splitter" })
    }).then((r) => r.json());
    const receipts = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: billSpawn.session.burnerId,
        toolName: "receipt_parse",
        params: {}
      })
    }).then((r) => r.json());
    assert.equal(receipts.toolResult.totalCents, 26400);
    assert.equal(receipts.toolResult.duplicatesRemoved.length, 1);

    const csvRes = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: billSpawn.session.burnerId,
        toolName: "csv_export",
        params: {}
      })
    }).then((r) => r.json());
    assert.equal(csvRes.toolResult.exported, true);
    assert.equal(csvRes.toolResult.rowCount, 3);

    resetSandbox(sandboxRoot);
    const ms = Number((performance.now() - start).toFixed(2));
    console.log(`PASS smoke -> 2 scenarios + /rob + burn verified cleanly in ${ms}ms`);
  } finally {
    server.close();
  }
}

runSmoke().catch((err) => {
  console.error("FAIL smoke ->", err);
  process.exit(1);
});
