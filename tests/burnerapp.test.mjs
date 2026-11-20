import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import handler from "../api/index.mjs";
import { BurnerRegistry, createBurnerPlugin } from "../index.mjs";
import { executeLocalTool, resetSandbox } from "../src/tools/local-tools.mjs";
import {
  DEFAULT_CEREBRAS_MODEL,
  HACKATHON_TPM_LIMIT,
  TpmTracker,
  compileBurnerApp,
  computeTpsTelemetry
} from "../src/compiler/kimi-cerebras.mjs";
import { createAppServer } from "../src/server.mjs";

beforeEach(() => {
  resetSandbox();
});

after(() => {
  resetSandbox();
});

test("1. Seeded demo-repo starts with 1/3 passing and 2/3 failing tests", async () => {
  const result = await executeLocalTool("repo_test_runner");
  assert.equal(result.exitCode, 1);
  assert.equal(result.total, 3);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 2);
});

test("2. Bundle inspector detects unused dependencies and exact off-by-one suspect line", async () => {
  const inspection = await executeLocalTool("fs_bundle_inspect");
  assert.equal(inspection.repo, "demo-auth-service");
  assert.deepEqual(inspection.unusedDependencies, ["left-pad", "moment-timezone-legacy"]);
  assert.equal(inspection.hasSeededBug, true);
  assert.match(inspection.suspectCode, /payload\.exp - 3600/);
});

test("3. Surgical patch fixes auth-token.mjs on disk and flips tests to 3/3 PASS (exit 0)", async () => {
  const patch = await executeLocalTool("repo_patch_apply");
  assert.equal(patch.patched, true);
  assert.equal(patch.testResult.exitCode, 0);
  assert.equal(patch.testResult.passed, 3);
  assert.equal(patch.testResult.failed, 0);
});

test("4. resetSandbox deterministically restores seeded bug after patching", async () => {
  await executeLocalTool("repo_patch_apply");
  resetSandbox();
  const afterReset = await executeLocalTool("repo_test_runner");
  assert.equal(afterReset.exitCode, 1);
  assert.equal(afterReset.failed, 2);
});

test("5. Receipt parser detects duplicate RCP-104-DUP and calculates exact integer-cent split", async () => {
  const report = await executeLocalTool("receipt_parse", { includeDuplicates: false });
  assert.equal(report.totalReceiptsScanned, 6);
  assert.equal(report.activeReceiptsCount, 5);
  assert.equal(report.duplicatesRemoved.length, 1);
  assert.equal(report.duplicatesRemoved[0].id, "RCP-104-DUP");
  assert.equal(report.totalCents, 26400);
  assert.equal(report.totalUsd, "$264.00");
  const netSum = report.balances.reduce((acc, b) => acc + b.netCents, 0);
  assert.equal(netSum, 0);
});

test("6. Contrast without deduplication proves $26.40 overcharge caught by deduplicator", async () => {
  const deduped = await executeLocalTool("receipt_parse", { includeDuplicates: false });
  const raw = await executeLocalTool("receipt_parse", { includeDuplicates: true });
  assert.equal(raw.totalCents - deduped.totalCents, 2640);
});

test("7. CSV export writes settlement-export.csv with SHA-256 verification", async () => {
  const exported = await executeLocalTool("csv_export");
  assert.equal(exported.exported, true);
  assert.equal(exported.rowCount, 3);
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.resolve(process.cwd(), exported.path)), true);
});

test("8. Governor allows listed tool inside allowedPaths and records SHA-256 receipt", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    prompt: "triage",
    scenarioId: "repo-triage",
    allowedTools: ["repo_test_runner"],
    allowedPaths: ["fixtures/sandbox/demo-repo"]
  });

  const evalRes = registry.evaluateBeforeToolCall(
    { toolName: "repo_test_runner", params: { path: "fixtures/sandbox/demo-repo/auth-token.test.mjs" } },
    { burnerId: session.burnerId }
  );
  assert.equal(evalRes.allowed, true);
  assert.equal(evalRes.rule, "MANIFEST_CAPABILITY_GRANTED");
  assert.match(evalRes.receipt.sha256, /^[a-f0-9]{64}$/);
});

test("9. Governor blocks unlisted tool outside capability manifest", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["fs_bundle_inspect"],
    allowedPaths: ["fixtures/sandbox/demo-repo"]
  });
  const res = registry.evaluateBeforeToolCall(
    { toolName: "csv_export", params: {} },
    { burnerId: session.burnerId }
  );
  assert.equal(res.allowed, false);
  assert.equal(res.rule, "TOOL_OUTSIDE_MANIFEST");
});

test("10. Governor blocks sensitive .env read even on an allowed tool", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["fs_bundle_inspect"],
    allowedPaths: ["fixtures/sandbox/demo-repo"]
  });
  const res = registry.evaluateBeforeToolCall(
    { toolName: "fs_bundle_inspect", params: { path: ".env" } },
    { burnerId: session.burnerId }
  );
  assert.equal(res.allowed, false);
  assert.equal(res.rule, "SECURITY_INVARIANT_VIOLATION");
});

test("11. Governor blocks ../ path traversal and SSH keys", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["receipt_parse"],
    allowedPaths: ["fixtures/sandbox/receipts"]
  });
  const res = registry.evaluateBeforeToolCall(
    { toolName: "receipt_parse", params: { path: "../../.ssh/id_rsa" } },
    { burnerId: session.burnerId }
  );
  assert.equal(res.allowed, false);
  assert.equal(res.rule, "SECURITY_INVARIANT_VIOLATION");
});

test("12. Governor blocks destructive rm -rf shell command", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["repo_test_runner"],
    allowedPaths: ["fixtures/sandbox/demo-repo"]
  });
  const res = registry.evaluateBeforeToolCall(
    { toolName: "exec", params: { command: "rm -rf /" } },
    { burnerId: session.burnerId }
  );
  assert.equal(res.allowed, false);
  assert.equal(res.rule, "SECURITY_INVARIANT_VIOLATION");
});

test("13. Governor blocks access to allowed tool if path escapes allowedPaths", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["fs_bundle_inspect"],
    allowedPaths: ["fixtures/sandbox/demo-repo"]
  });
  const res = registry.evaluateBeforeToolCall(
    { toolName: "fs_bundle_inspect", params: { path: "fixtures/sandbox/receipts/dinner-receipts.json" } },
    { burnerId: session.burnerId }
  );
  assert.equal(res.allowed, false);
  assert.equal(res.rule, "PATH_OUTSIDE_MANIFEST");
});

test("14. Governor blocks expired BurnerApp manifest deterministically", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["repo_test_runner"],
    ttlMs: 1_000
  });
  const res = registry.evaluateBeforeToolCall(
    { toolName: "repo_test_runner", params: {} },
    { burnerId: session.burnerId, nowMs: session.issuedAt + 5_000 }
  );
  assert.equal(res.allowed, false);
  assert.equal(res.rule, "MANIFEST_EXPIRED");
});

test("15. Burning an app revokes token and blocks all subsequent tool calls", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["repo_test_runner"]
  });
  const burn = registry.burnApp(session.burnerId);
  assert.equal(burn.burned, true);
  assert.equal(burn.session.status, "BURNED");
  assert.equal(burn.session.hasActiveToken, false);

  const postBurn = registry.evaluateBeforeToolCall(
    { toolName: "repo_test_runner", params: {} },
    { burnerId: session.burnerId }
  );
  assert.equal(postBurn.allowed, false);
  assert.equal(postBurn.rule, "BURNER_REVOKED");
});

test("16. OpenClaw plugin registers typed before_tool_call hook with priority 100", async () => {
  const registry = new BurnerRegistry();
  const plugin = createBurnerPlugin({ registry });
  let captured = null;
  plugin.register({
    on(hookName, handler, opts) {
      captured = { hookName, handler, opts };
    }
  });

  assert.equal(captured.hookName, "before_tool_call");
  assert.equal(captured.opts.priority, 100);

  const session = registry.spawnBurner({ allowedTools: ["fs_bundle_inspect"] });
  const allowedResult = await captured.handler(
    { toolName: "fs_bundle_inspect", params: {} },
    { burnerId: session.burnerId }
  );
  assert.deepEqual(allowedResult, {});

  const blockedResult = await captured.handler(
    { toolName: "fs_bundle_inspect", params: { path: ".env" } },
    { burnerId: session.burnerId }
  );
  assert.equal(blockedResult.block, true);
  assert.match(blockedResult.blockReason, /SECURITY_INVARIANT_VIOLATION/);
});

test("17. computeTpsTelemetry and TpmTracker measure wafer speed vs GPU baseline and 100K TPM budget", () => {
  const tel = computeTpsTelemetry({
    usage: { prompt_tokens: 340, completion_tokens: 1620, total_tokens: 1960 },
    timeInfo: { queue_time: 0.001, prompt_time: 0.012, completion_time: 0.9, total_time: 0.913 }
  });
  assert.equal(tel.tps, 1800);
  assert.equal(tel.gpuEstimatedSeconds, 36);
  assert.ok(tel.speedupFactor > 35);

  const tracker = new TpmTracker(HACKATHON_TPM_LIMIT);
  const snap = tracker.record(1960, 1_000_000);
  assert.equal(snap.usedTokens, 1960);
  assert.equal(snap.tpmRemaining, 98_040);
  assert.equal(tracker.getSnapshot(1_061_000).usedTokens, 0);
});

test("18. Live Cerebras compiler parses Kimi K3.1 Pro JSON and time_info via injected fetchImpl", async () => {
  const mockApiResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: "Instant Auth Patcher",
            subtitle: "Runs real tests and patches expiration bug",
            summary: "Scoped to demo-repo.",
            actions: [
              {
                id: "run",
                label: "Run Tests",
                toolName: "repo_test_runner",
                params: {},
                style: "primary",
                description: "Executes node test runner"
              }
            ]
          })
        }
      }
    ],
    usage: { prompt_tokens: 310, completion_tokens: 1450, total_tokens: 1760 },
    time_info: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.85, total_time: 0.861 }
  };

  const compiled = await compileBurnerApp({
    prompt: "fix auth tests",
    apiKey: "test-key",
    model: DEFAULT_CEREBRAS_MODEL,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => mockApiResponse
    })
  });

  assert.equal(compiled.sourceMode, "LIVE_CEREBRAS_API");
  assert.equal(compiled.modelUsed, "moonshotai-kimi-k3.1-pro-trial");
  assert.equal(compiled.spec.title, "Instant Auth Patcher");
  assert.equal(compiled.telemetry.tps, 1705.88);
});

test("19. End-to-end HTTP cockpit supports /judge, /api/spawn, green /api/tool-call, /rob 403, and /api/burn", async () => {
  const { server } = createAppServer({ apiKey: "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const judge = await fetch(`${base}/judge`);
    assert.equal(judge.status, 200);
    const html = await judge.text();
    assert.match(html, /BurnerApp/);

    const spawn = await fetch(`${base}/api/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "repo-triage" })
    }).then((r) => r.json());
    assert.equal(spawn.ok, true);

    const patchCall = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: spawn.session.burnerId,
        toolName: "repo_patch_apply",
        params: {}
      })
    }).then((r) => r.json());
    assert.equal(patchCall.ok, true);
    assert.equal(patchCall.toolResult.testResult.passed, 3);

    const robCall = await fetch(`${base}/api/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        burnerId: spawn.session.burnerId,
        toolName: "exec",
        params: { command: "rm -rf /" }
      })
    });
    assert.equal(robCall.status, 403);

    const burnCall = await fetch(`${base}/api/burn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ burnerId: spawn.session.burnerId })
    }).then((r) => r.json());
    assert.equal(burnCall.burned, true);
  } finally {
    server.close();
  }
});

test("20. Compiler prevents LLM JSON output from escalating allowedTools beyond preset ceiling", async () => {
  const escalatedResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: "Injected Receipt App",
            subtitle: "Attempts to smuggle repo_patch_apply into bill-splitter",
            summary: "Should strip repo_patch_apply.",
            actions: [
              {
                id: "inject-patch",
                label: "Smuggled Patch",
                toolName: "repo_patch_apply",
                params: {},
                style: "primary"
              },
              {
                id: "legit-receipt",
                label: "Parse Receipts",
                toolName: "receipt_parse",
                params: {},
                style: "secondary"
              }
            ]
          })
        }
      }
    ],
    usage: { prompt_tokens: 200, completion_tokens: 600, total_tokens: 800 },
    time_info: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.35, total_time: 0.361 }
  };

  const compiled = await compileBurnerApp({
    scenarioId: "bill-splitter",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => escalatedResponse
    })
  });

  assert.deepEqual(compiled.spec.allowedTools, ["receipt_parse"]);
  assert.equal(compiled.spec.actions.length, 1);
  assert.equal(compiled.spec.actions[0].toolName, "receipt_parse");
});

test("21. Canonical path containment blocks %2e%2e and params.target escapes while allowing safe filenames with two dots", () => {
  const registry = new BurnerRegistry();
  const session = registry.spawnBurner({
    allowedTools: ["receipt_parse"],
    allowedPaths: ["fixtures/sandbox/receipts"]
  });

  const encodedTraversal = registry.evaluateBeforeToolCall(
    { toolName: "receipt_parse", params: { path: "fixtures/sandbox/receipts/%2e%2e/demo-repo/auth-token.mjs" } },
    { burnerId: session.burnerId }
  );
  assert.equal(encodedTraversal.allowed, false);

  const targetEscape = registry.evaluateBeforeToolCall(
    { toolName: "receipt_parse", params: { target: "fixtures/sandbox/demo-repo/auth-token.mjs" } },
    { burnerId: session.burnerId }
  );
  assert.equal(targetEscape.allowed, false);
  assert.equal(targetEscape.rule, "PATH_OUTSIDE_MANIFEST");

  const safeDoubleDotFile = registry.evaluateBeforeToolCall(
    { toolName: "receipt_parse", params: { path: "fixtures/sandbox/receipts/dinner..v2.json" } },
    { burnerId: session.burnerId }
  );
  assert.equal(safeDoubleDotFile.allowed, true);
});

test("22. Server rejects cross-origin POST requests from external Origin headers with HTTP 403", async () => {
  const { server } = createAppServer({ apiKey: "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/api/spawn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://malicious.example.com"
      },
      body: JSON.stringify({ scenarioId: "repo-triage" })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "CROSS_ORIGIN_FORBIDDEN");
  } finally {
    server.close();
  }
});

test("23. Compiler falls back to secondary Cerebras model when primary trial model returns 404", async () => {
  const attemptedModels = [];
  const compiled = await compileBurnerApp({
    scenarioId: "repo-triage",
    apiKey: "test-key",
    model: "moonshotai-kimi-k3.1-pro-trial",
    fetchImpl: async (_url, init) => {
      const reqBody = JSON.parse(init.body);
      attemptedModels.push(reqBody.model);
      if (reqBody.model === "moonshotai-kimi-k3.1-pro-trial") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { message: "Model not yet unlocked on organization" } })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 200, completion_tokens: 500, total_tokens: 700 },
          time_info: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.3, total_time: 0.311 }
        })
      };
    }
  });

  assert.equal(compiled.sourceMode, "LIVE_CEREBRAS_API");
  assert.equal(compiled.modelUsed, "zai-glm-4.7");
  assert.deepEqual(attemptedModels, ["moonshotai-kimi-k3.1-pro-trial", "zai-glm-4.7"]);
});

async function invokeVercelHandler({ method = "GET", url, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, headers, body };
    let statusCode = 200;
    let responseHeaders = {};
    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        responseHeaders = hdrs;
      },
      end(chunk = "") {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ statusCode, headers: responseHeaders, text, json });
      }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("24. Vercel serverless handler serves /api/* via __path rewrite, pre-parsed req.body, same-origin host, and /tmp sandbox", async () => {
  const prevVercel = process.env.VERCEL;
  const tmpSandbox = path.join(os.tmpdir(), "burnerapp-sandbox");
  fs.rmSync(tmpSandbox, { recursive: true, force: true });
  process.env.VERCEL = "1";

  try {
    const statusRes = await invokeVercelHandler({
      method: "GET",
      url: "/api/index.mjs?__path=status"
    });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json?.ok, true);

    const previewHeaders = {
      origin: "https://burnerapp-preview.vercel.app",
      "x-forwarded-host": "burnerapp-preview.vercel.app"
    };

    const spawnRes = await invokeVercelHandler({
      method: "POST",
      url: "/api/index.mjs?__path=spawn",
      headers: previewHeaders,
      body: { scenarioId: "repo-triage" }
    });
    assert.equal(spawnRes.statusCode, 200);
    assert.equal(spawnRes.json?.ok, true);
    const burnerId = spawnRes.json.session.burnerId;

    const patchRes = await invokeVercelHandler({
      method: "POST",
      url: "/api/index.mjs?__path=tool-call",
      headers: previewHeaders,
      body: { burnerId, toolName: "repo_patch_apply", params: {} }
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json?.ok, true);
    assert.equal(patchRes.json.toolResult.testResult.passed, 3);
    assert.equal(patchRes.json.toolResult.testResult.exitCode, 0);
    assert.equal(fs.existsSync(path.join(tmpSandbox, "demo-repo", "auth-token.mjs")), true);

    const robRes = await invokeVercelHandler({
      method: "POST",
      url: "/api/index.mjs?__path=tool-call",
      headers: previewHeaders,
      body: { burnerId, toolName: "exec", params: { command: "rm -rf /" } }
    });
    assert.equal(robRes.statusCode, 403);
    assert.equal(robRes.json?.blocked, true);

    const burnRes = await invokeVercelHandler({
      method: "POST",
      url: "/api/index.mjs?__path=burn",
      headers: previewHeaders,
      body: { burnerId }
    });
    assert.equal(burnRes.statusCode, 200);
    assert.equal(burnRes.json?.burned, true);
  } finally {
    if (prevVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = prevVercel;
    }
    fs.rmSync(tmpSandbox, { recursive: true, force: true });
  }
});

test("25. Vercel serverless handler still blocks mismatched external Origin with HTTP 403 CROSS_ORIGIN_FORBIDDEN", async () => {
  const res = await invokeVercelHandler({
    method: "POST",
    url: "/api/index.mjs?__path=spawn",
    headers: {
      origin: "https://evil.example.com",
      "x-forwarded-host": "burnerapp-preview.vercel.app"
    },
    body: { scenarioId: "repo-triage" }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json?.error, "CROSS_ORIGIN_FORBIDDEN");
});
