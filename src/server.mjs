import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BurnerRegistry } from "./governor/capability-gate.mjs";
import { createBurnerPlugin } from "./plugin/openclaw-plugin.mjs";
import {
  DEFAULT_CEREBRAS_MODEL,
  GPU_BASELINE_TPS,
  SCENARIO_PRESETS,
  TpmTracker,
  compileBurnerApp,
  loadDotEnv
} from "./compiler/kimi-cerebras.mjs";
import { executeLocalTool, resetSandbox, resolveSandboxRoot } from "./tools/local-tools.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function readJsonBody(req, maxBytes = 65_536) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createAppServer({
  sandboxRoot,
  apiKey,
  model,
  fetchImpl = fetch
} = {}) {
  loadDotEnv();
  const effectiveSandboxRoot = resolveSandboxRoot(sandboxRoot);
  const registry = new BurnerRegistry();
  const tpmTracker = new TpmTracker();
  const plugin = createBurnerPlugin({ registry });

  let beforeToolCallHook = null;
  plugin.register({
    on(hookName, handler) {
      if (hookName === "before_tool_call") {
        beforeToolCallHook = handler;
      }
    }
  });

  function buildStatusPayload() {
    const activeApiKey = apiKey !== undefined ? apiKey : process.env.CEREBRAS_API_KEY || "";
    const activeModel = model || process.env.CEREBRAS_MODEL || DEFAULT_CEREBRAS_MODEL;
    return {
      ok: true,
      service: "BurnerApp OpenClaw Canvas & Governor",
      model: activeModel,
      hasServerApiKey: Boolean(activeApiKey),
      gpuBaselineTps: GPU_BASELINE_TPS,
      tpmStatus: tpmTracker.getSnapshot(),
      presets: Object.values(SCENARIO_PRESETS).map((p) => ({
        scenarioId: p.scenarioId,
        title: p.title,
        badge: p.badge,
        prompt: p.prompt
      })),
      sessions: registry.listSessions(),
      auditLog: registry.getAuditLog(30)
    };
  }

  function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    try {
      if (req.method === "POST" && !isAllowedOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "CROSS_ORIGIN_FORBIDDEN" });
        return;
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/judge")) {
        const htmlPath = path.join(PUBLIC_DIR, "index.html");
        const html = fs.readFileSync(htmlPath, "utf8");
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, buildStatusPayload());
        return;
      }

      if (req.method === "POST" && pathname === "/api/spawn") {
        const body = await readJsonBody(req);
        const runtimeApiKey =
          (typeof body.apiKey === "string" && body.apiKey.trim()) ||
          (apiKey !== undefined ? apiKey : process.env.CEREBRAS_API_KEY || "");

        const compiled = await compileBurnerApp({
          prompt: body.prompt || "",
          scenarioId: body.scenarioId || "",
          apiKey: runtimeApiKey,
          model: body.model || model || process.env.CEREBRAS_MODEL || DEFAULT_CEREBRAS_MODEL,
          useLiveApi: body.useLiveApi !== false,
          tpmTracker,
          fetchImpl
        });

        const session = registry.spawnBurner({
          prompt: compiled.prompt,
          scenarioId: compiled.spec.scenarioId,
          allowedTools: compiled.spec.allowedTools,
          allowedPaths: compiled.spec.allowedPaths,
          ttlMs: 10 * 60 * 1000
        });

        sendJson(res, 200, {
          ok: true,
          session,
          compiled,
          status: buildStatusPayload()
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/tool-call") {
        const body = await readJsonBody(req);
        const burnerId = String(body.burnerId || "");
        const toolName = String(body.toolName || "");
        const params = body.params && typeof body.params === "object" ? body.params : {};

        if (!beforeToolCallHook) {
          sendJson(res, 500, { ok: false, error: "OPENCLAW_HOOK_NOT_REGISTERED" });
          return;
        }

        const hookResult = await beforeToolCallHook(
          { toolName, params },
          { burnerId }
        );

        const latestReceipt = registry.getAuditLog(1)[0] || null;
        if (hookResult && hookResult.block) {
          sendJson(res, 403, {
            ok: false,
            blocked: true,
            blockReason: hookResult.blockReason,
            receipt: latestReceipt,
            session: registry.getSession(burnerId),
            auditLog: registry.getAuditLog(30)
          });
          return;
        }

        const toolResult = await executeLocalTool(toolName, params, effectiveSandboxRoot);
        sendJson(res, 200, {
          ok: true,
          blocked: false,
          toolName,
          toolResult,
          receipt: latestReceipt,
          session: registry.getSession(burnerId),
          auditLog: registry.getAuditLog(30)
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/burn") {
        const body = await readJsonBody(req);
        const burnerId = String(body.burnerId || "");
        const result = registry.burnApp(burnerId, body.reason || "USER_TRIGGERED_BURN");
        sendJson(res, result.burned ? 200 : 404, {
          ok: result.burned,
          ...result,
          auditLog: registry.getAuditLog(30)
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/reset") {
        const resetResult = resetSandbox(effectiveSandboxRoot);
        sendJson(res, 200, {
          ok: true,
          resetResult,
          status: buildStatusPayload()
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: "NOT_FOUND", pathname });
    } catch (err) {
      const code = err.message === "PAYLOAD_TOO_LARGE" ? 413 : err.message === "INVALID_JSON" ? 400 : 500;
      sendJson(res, code, { ok: false, error: err.message });
    }
  });

  return {
    server,
    registry,
    tpmTracker,
    sandboxRoot: effectiveSandboxRoot
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  loadDotEnv();
  resetSandbox();
  const port = Number.parseInt(process.env.PORT || "3847", 10);
  const { server } = createAppServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`BurnerApp OpenClaw Cockpit live at http://127.0.0.1:${port}/judge`);
  });
}
