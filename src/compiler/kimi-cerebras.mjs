import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CEREBRAS_MODEL = "moonshotai-kimi-k3.1-pro-trial";
export const MODEL_FALLBACK_CHAIN = [
  "moonshotai-kimi-k3.1-pro-trial",
  "zai-glm-4.7",
  "llama-3.3-70b"
];
export const HACKATHON_TPM_LIMIT = 100_000;
export const HACKATHON_RPM_LIMIT = 100;
export const GPU_BASELINE_TPS = 45;

export function loadDotEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) return {};
  const loaded = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = val;
    }
    loaded[key] = val;
  }
  return loaded;
}

export class TpmTracker {
  constructor(tpmLimit = HACKATHON_TPM_LIMIT, rpmLimit = HACKATHON_RPM_LIMIT) {
    this.tpmLimit = tpmLimit;
    this.rpmLimit = rpmLimit;
    this.events = [];
  }

  record(tokens, nowMs = Date.now()) {
    this.prune(nowMs);
    this.events.push({ tokens: Math.max(0, Number(tokens) || 0), timestamp: nowMs });
    return this.getSnapshot(nowMs);
  }

  prune(nowMs = Date.now()) {
    const cutoff = nowMs - 60_000;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  getSnapshot(nowMs = Date.now()) {
    this.prune(nowMs);
    const usedTokens = this.events.reduce((sum, e) => sum + e.tokens, 0);
    const usedRequests = this.events.length;
    const tpmPercent = Number(((usedTokens / this.tpmLimit) * 100).toFixed(2));
    return {
      usedTokens,
      tpmLimit: this.tpmLimit,
      tpmRemaining: Math.max(0, this.tpmLimit - usedTokens),
      tpmPercent,
      usedRequests,
      rpmLimit: this.rpmLimit,
      rpmRemaining: Math.max(0, this.rpmLimit - usedRequests)
    };
  }
}

export function computeTpsTelemetry({ usage = {}, timeInfo = {}, gpuTps = GPU_BASELINE_TPS }) {
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;

  const queueTime = Number(timeInfo.queue_time) || 0;
  const promptTime = Number(timeInfo.prompt_time) || 0;
  const completionTime = Number(timeInfo.completion_time) || 0;
  const totalTime = Number(timeInfo.total_time) || queueTime + promptTime + completionTime;

  const tps = completionTime > 0 ? Number((completionTokens / completionTime).toFixed(2)) : 0;
  const gpuEstimatedSeconds = Number((completionTokens / gpuTps).toFixed(2));
  const speedupFactor =
    totalTime > 0 && gpuEstimatedSeconds > 0
      ? Number((gpuEstimatedSeconds / totalTime).toFixed(1))
      : 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    queueTimeSec: Number(queueTime.toFixed(4)),
    promptTimeSec: Number(promptTime.toFixed(4)),
    completionTimeSec: Number(completionTime.toFixed(4)),
    totalTimeSec: Number(totalTime.toFixed(4)),
    tps,
    gpuBaselineTps: gpuTps,
    gpuEstimatedSeconds,
    speedupFactor
  };
}

export const SCENARIO_PRESETS = {
  "repo-triage": {
    scenarioId: "repo-triage",
    prompt:
      "Inspect my local auth repo for failing tests and unused packages, and give me switches to patch and re-verify it.",
    title: "Auth Repo Bug & Test Fixer",
    subtitle: "Scoped local sandbox micro-app for fixtures/sandbox/demo-repo",
    badge: "DEV WORKFLOW · SCOPED FS + TEST RUNNER",
    allowedTools: ["fs_bundle_inspect", "repo_test_runner", "repo_patch_apply"],
    allowedPaths: ["fixtures/sandbox/demo-repo"],
    summary:
      "Detects why session tokens expire immediately in auth-token.mjs and lets you run real node --test assertions before and after applying a 1-line surgical fix.",
    actions: [
      {
        id: "inspect",
        label: "Inspect Repo & Suspect Line",
        toolName: "fs_bundle_inspect",
        params: { path: "fixtures/sandbox/demo-repo" },
        style: "secondary",
        description: "Reads file sizes, unused deps, and flags payload.exp - 3600."
      },
      {
        id: "run-tests",
        label: "Run node --test (Before Patch)",
        toolName: "repo_test_runner",
        params: { path: "fixtures/sandbox/demo-repo/auth-token.test.mjs" },
        style: "secondary",
        description: "Executes real node --test subprocess and captures exit code."
      },
      {
        id: "patch-and-verify",
        label: "Apply 1-Line Patch & Re-Test",
        toolName: "repo_patch_apply",
        params: { path: "fixtures/sandbox/demo-repo/auth-token.mjs" },
        style: "primary",
        description: "Patches auth-token.mjs on disk and re-runs tests until 3/3 PASS."
      }
    ],
    adversarialActions: [
      {
        id: "rob-env",
        label: "Try Read .env",
        toolName: "fs_bundle_inspect",
        params: { path: ".env" }
      },
      {
        id: "rob-rm",
        label: "Try rm -rf /",
        toolName: "exec",
        params: { command: "rm -rf /" }
      }
    ],
    sampleCodeStream: [
      "<!DOCTYPE html>",
      "<html lang=\"en\">",
      "<section class=\"burner-card\" data-manifest=\"demo-repo\">",
      "  <header class=\"flex items-center justify-between\">",
      "    <h2>Auth Repo Bug & Test Fixer</h2>",
      "    <span class=\"badge\">3 tools scoped</span>",
      "  </header>",
      "  <div class=\"panel-grid\">",
      "    <button onclick=\"openclaw.callTool('fs_bundle_inspect', {path:'fixtures/sandbox/demo-repo'})\">Inspect Repo</button>",
      "    <button onclick=\"openclaw.callTool('repo_test_runner', {path:'fixtures/sandbox/demo-repo/auth-token.test.mjs'})\">Run Tests</button>",
      "    <button class=\"primary\" onclick=\"openclaw.callTool('repo_patch_apply', {path:'fixtures/sandbox/demo-repo/auth-token.mjs'})\">Apply Patch & Verify</button>",
      "  </div>",
      "  <div id=\"receipt-stream\" aria-live=\"polite\"></div>",
      "</section>"
    ]
  },
  "bill-splitter": {
    scenarioId: "bill-splitter",
    prompt:
      "Turn these 6 messy dinner receipts into a live group bill splitter, remove duplicate charges, and export a settlement CSV.",
    title: "6-Receipt Group Bill Splitter",
    subtitle: "Integer-cent deduplication & settlement exporter for dinner-receipts.json",
    badge: "EVERYDAY WORKFLOW · RECEIPT DEDUPE + CSV",
    allowedTools: ["receipt_parse", "csv_export"],
    allowedPaths: ["fixtures/sandbox/receipts"],
    summary:
      "Parses 6 dinner and transit receipts in integer cents, catches duplicate Waymo charge RCP-104-DUP ($26.40), and writes a SHA-256 verified CSV.",
    actions: [
      {
        id: "parse-dedupe",
        label: "Scan 6 Receipts & Deduplicate",
        toolName: "receipt_parse",
        params: { path: "fixtures/sandbox/receipts/dinner-receipts.json", includeDuplicates: false },
        style: "primary",
        description: "Removes duplicate RCP-104-DUP and calculates exact net cents."
      },
      {
        id: "parse-raw",
        label: "Preview Without Dedupe (Contrast)",
        toolName: "receipt_parse",
        params: { path: "fixtures/sandbox/receipts/dinner-receipts.json", includeDuplicates: true },
        style: "secondary",
        description: "Shows the $26.40 overcharge if duplicate detection is skipped."
      },
      {
        id: "export-csv",
        label: "Export Verified Settlement CSV",
        toolName: "csv_export",
        params: { path: "fixtures/sandbox/receipts/settlement-export.csv" },
        style: "primary",
        description: "Writes settlement-export.csv to disk with SHA-256 checksum."
      }
    ],
    adversarialActions: [
      {
        id: "rob-traversal",
        label: "Try Path Traversal (../.ssh)",
        toolName: "receipt_parse",
        params: { path: "../../.ssh/id_rsa" }
      },
      {
        id: "rob-exec",
        label: "Try Unlisted Shell Tool",
        toolName: "exec",
        params: { command: "printenv" }
      }
    ],
    sampleCodeStream: [
      "<!DOCTYPE html>",
      "<section class=\"burner-card\" data-manifest=\"receipts\">",
      "  <header class=\"flex items-center justify-between\">",
      "    <h2>6-Receipt Group Bill Splitter</h2>",
      "    <span class=\"badge\">Integer-Cent Engine</span>",
      "  </header>",
      "  <div class=\"receipt-ledger\" data-currency=\"USD\">",
      "    <button class=\"primary\" onclick=\"openclaw.callTool('receipt_parse', {includeDuplicates:false})\">Scan & Dedupe</button>",
      "    <button onclick=\"openclaw.callTool('receipt_parse', {includeDuplicates:true})\">Contrast Raw</button>",
      "    <button class=\"primary\" onclick=\"openclaw.callTool('csv_export', {path:'fixtures/sandbox/receipts/settlement-export.csv'})\">Export CSV</button>",
      "  </div>",
      "</section>"
    ]
  },
  "security-audit": {
    scenarioId: "security-audit",
    prompt:
      "Build a live capability-boundary auditor to test allowed sandbox inspection vs unauthorized file and shell escapes.",
    title: "Capability Boundary Auditor",
    subtitle: "Live 50/50 demonstration of OpenClaw before_tool_call enforcement",
    badge: "GOVERNOR LAB · 50/50 THROTTLE PROOF",
    allowedTools: ["fs_bundle_inspect", "receipt_parse"],
    allowedPaths: ["fixtures/sandbox/demo-repo", "fixtures/sandbox/receipts"],
    summary:
      "Lets you run legitimate repo and receipt inspections side-by-side against hostile .env, path traversal, and shell-injection probes.",
    actions: [
      {
        id: "audit-repo",
        label: "Scoped Repo Read (Allowed)",
        toolName: "fs_bundle_inspect",
        params: { path: "fixtures/sandbox/demo-repo" },
        style: "primary",
        description: "Passes manifest check and reads sandbox metadata."
      },
      {
        id: "audit-receipts",
        label: "Scoped Receipt Parse (Allowed)",
        toolName: "receipt_parse",
        params: { path: "fixtures/sandbox/receipts/dinner-receipts.json" },
        style: "secondary",
        description: "Passes manifest check and returns deduplicated balances."
      }
    ],
    adversarialActions: [
      {
        id: "rob-env",
        label: "Probe .env Secret Read",
        toolName: "fs_bundle_inspect",
        params: { path: ".env" }
      },
      {
        id: "rob-patch-unlisted",
        label: "Probe Unlisted Write Tool",
        toolName: "repo_patch_apply",
        params: { path: "fixtures/sandbox/demo-repo/auth-token.mjs" }
      }
    ],
    sampleCodeStream: [
      "<!DOCTYPE html>",
      "<section class=\"burner-card\" data-manifest=\"security-audit\">",
      "  <h2>Capability Boundary Auditor</h2>",
      "  <button class=\"primary\" onclick=\"openclaw.callTool('fs_bundle_inspect')\">Scoped Read</button>",
      "  <button class=\"danger\" onclick=\"openclaw.callTool('exec', {command:'rm -rf /'})\">Hostile Escape Probe</button>",
      "</section>"
    ]
  }
};

function inferScenarioFromPrompt(prompt = "", requestedScenarioId = "") {
  if (requestedScenarioId && SCENARIO_PRESETS[requestedScenarioId]) {
    return SCENARIO_PRESETS[requestedScenarioId];
  }
  const lower = String(prompt).toLowerCase();
  if (lower.includes("receipt") || lower.includes("dinner") || lower.includes("split") || lower.includes("csv")) {
    return SCENARIO_PRESETS["bill-splitter"];
  }
  if (lower.includes("security") || lower.includes("audit") || lower.includes("env") || lower.includes("rob")) {
    return SCENARIO_PRESETS["security-audit"];
  }
  return SCENARIO_PRESETS["repo-triage"];
}

function buildSystemPrompt() {
  return [
    "You are BurnerApp Compiler running inside OpenClaw Canvas.",
    "Given a user task, return ONLY valid JSON describing a focused single-purpose micro-app with this exact schema:",
    "{",
    '  "title": "short 3-6 word app title",',
    '  "subtitle": "1-sentence description of what this burner does",',
    '  "summary": "2 concise sentences explaining the workflow",',
    '  "allowedTools": ["subset of: fs_bundle_inspect, repo_test_runner, repo_patch_apply, receipt_parse, csv_export"],',
    '  "actions": [{ "id": "slug", "label": "Button Label", "toolName": "allowed tool", "params": {}, "style": "primary|secondary", "description": "short effect" }]',
    "}",
    "Never invent tools outside the allowed subset. Keep JSON compact and valid."
  ].join("\n");
}

function validateCompiledSpec(rawJson, fallbackPreset) {
  const presetAllowed = new Set(fallbackPreset.allowedTools || []);

  let parsed;
  try {
    parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  } catch {
    return { ...fallbackPreset, specSource: "PARSE_FALLBACK" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ...fallbackPreset, specSource: "PARSE_FALLBACK" };
  }

  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .filter((a) => a && presetAllowed.has(a.toolName) && typeof a.label === "string")
        .slice(0, 4)
        .map((a, idx) => ({
          id: String(a.id || `act-${idx + 1}`),
          label: String(a.label).slice(0, 48),
          toolName: a.toolName,
          params: a.params && typeof a.params === "object" ? a.params : {},
          style: a.style === "primary" ? "primary" : "secondary",
          description: String(a.description || "Executes scoped local OpenClaw tool.").slice(0, 120)
        }))
    : [];

  if (actions.length === 0) {
    return { ...fallbackPreset, specSource: "VALIDATED_FALLBACK" };
  }

  const allowedTools = [...new Set(actions.map((a) => a.toolName))].filter((tool) =>
    presetAllowed.has(tool)
  );
  return {
    ...fallbackPreset,
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 64) : fallbackPreset.title,
    subtitle:
      typeof parsed.subtitle === "string" && parsed.subtitle.trim()
        ? parsed.subtitle.trim().slice(0, 120)
        : fallbackPreset.subtitle,
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 240)
        : fallbackPreset.summary,
    allowedTools,
    actions,
    specSource: "KIMI_LIVE_COMPILED"
  };
}

export async function callCerebrasChat({
  apiKey,
  model = DEFAULT_CEREBRAS_MODEL,
  messages,
  maxTokens = 1024,
  temperature = 0.2,
  promptCacheKey = "burnerapp-canvas-v1",
  timeoutMs = 12_000,
  fetchImpl = fetch
}) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
    user: promptCacheKey
  };

  const response = await fetchImpl("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.error?.message || `Cerebras HTTP ${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

export async function compileBurnerApp({
  prompt = "",
  scenarioId = "",
  apiKey = process.env.CEREBRAS_API_KEY || "",
  model = process.env.CEREBRAS_MODEL || DEFAULT_CEREBRAS_MODEL,
  useLiveApi = true,
  tpmTracker = null,
  fetchImpl = fetch
} = {}) {
  const preset = inferScenarioFromPrompt(prompt, scenarioId);
  const effectivePrompt = (prompt && prompt.trim()) || preset.prompt;
  const start = performance.now();

  if (apiKey && useLiveApi) {
    const candidates = [model, ...MODEL_FALLBACK_CHAIN.filter((m) => m !== model)];
    let lastError = null;

    for (const candidateModel of candidates) {
      try {
        const apiPayload = await callCerebrasChat({
          apiKey,
          model: candidateModel,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: effectivePrompt }
          ],
          maxTokens: 900,
          temperature: 0.15,
          promptCacheKey: `burnerapp:${preset.scenarioId}`,
          fetchImpl
        });

        const rawText = apiPayload?.choices?.[0]?.message?.content || "";
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const compiled = jsonMatch
          ? validateCompiledSpec(jsonMatch[0], preset)
          : { ...preset, specSource: "PARSE_FALLBACK" };

        const telemetry = computeTpsTelemetry({
          usage: apiPayload.usage,
          timeInfo: apiPayload.time_info
        });
        const tpmStatus = tpmTracker ? tpmTracker.record(telemetry.totalTokens) : null;

        return {
          sourceMode: "LIVE_CEREBRAS_API",
          modelUsed: candidateModel,
          prompt: effectivePrompt,
          spec: compiled,
          telemetry,
          tpmStatus,
          localCompileMs: Number((performance.now() - start).toFixed(2)),
          rawModelOutputBytes: Buffer.byteLength(rawText, "utf8")
        };
      } catch (err) {
        lastError = err;
        if (err.status === 401) break;
      }
    }

    const fallbackSpec = { ...preset, specSource: "OFFLINE_FALLBACK_AFTER_API_ERROR" };
    const replayPayloadBytes = Buffer.byteLength(JSON.stringify(fallbackSpec), "utf8");
    const estimatedCompletionTokens = Math.max(380, Math.round(replayPayloadBytes / 3.4));
    const localCompileMs = Number((performance.now() - start).toFixed(2));
    return {
      sourceMode: "OFFLINE_SANDBOX_REPLAY",
      modelUsed: model,
      apiFallbackReason: lastError ? lastError.message : "Live endpoint unavailable",
      prompt: effectivePrompt,
      spec: fallbackSpec,
      telemetry: {
        promptTokens: 320,
        completionTokens: estimatedCompletionTokens,
        totalTokens: 320 + estimatedCompletionTokens,
        queueTimeSec: 0,
        promptTimeSec: 0,
        completionTimeSec: 0,
        totalTimeSec: Number((localCompileMs / 1000).toFixed(4)),
        tps: null,
        gpuBaselineTps: GPU_BASELINE_TPS,
        gpuEstimatedSeconds: Number((estimatedCompletionTokens / GPU_BASELINE_TPS).toFixed(2)),
        speedupFactor: null,
        note: "Offline fixture mode: live wafer TPS is measured only when Cerebras API key succeeds."
      },
      tpmStatus: tpmTracker ? tpmTracker.getSnapshot() : null,
      localCompileMs
    };
  }

  const offlineSpec = { ...preset, specSource: "PRE_SEEDED_SANDBOX_FIXTURE" };
  const payloadBytes = Buffer.byteLength(JSON.stringify(offlineSpec), "utf8");
  const estimatedCompletionTokens = Math.max(420, Math.round(payloadBytes / 3.2));
  const localCompileMs = Number((performance.now() - start).toFixed(2));

  return {
    sourceMode: "OFFLINE_SANDBOX_REPLAY",
    modelUsed: model,
    prompt: effectivePrompt,
    spec: offlineSpec,
    telemetry: {
      promptTokens: 340,
      completionTokens: estimatedCompletionTokens,
      totalTokens: 340 + estimatedCompletionTokens,
      queueTimeSec: 0,
      promptTimeSec: 0,
      completionTimeSec: 0,
      totalTimeSec: Number((localCompileMs / 1000).toFixed(4)),
      tps: null,
      gpuBaselineTps: GPU_BASELINE_TPS,
      gpuEstimatedSeconds: Number((estimatedCompletionTokens / GPU_BASELINE_TPS).toFixed(2)),
      speedupFactor: null,
      note: "Offline sandbox fixture mode (set CEREBRAS_API_KEY for live Cerebras time_info TPS)."
    },
    tpmStatus: tpmTracker ? tpmTracker.getSnapshot() : null,
    localCompileMs
  };
}
