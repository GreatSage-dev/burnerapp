import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_SANDBOX_ROOT = path.resolve(__dirname, "../../fixtures/sandbox");

const SEEDED_AUTH_TOKEN_SOURCE = `import crypto from "node:crypto";

const SECRET = "burner-sandbox-signing-key";

export function issueSessionToken(userId, nowMs = Date.now(), ttlSeconds = 3600) {
  const iat = Math.floor(nowMs / 1000);
  const payload = {
    sub: userId,
    iat,
    exp: iat + ttlSeconds
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return \`\${body}.\${sig}\`;
}

export function verifySessionToken(token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { valid: false, reason: "MALFORMED_TOKEN" };
  }
  const [body, sig] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig !== expectedSig) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  const nowSec = Math.floor(nowMs / 1000);

  // Seeded bug: subtracts 3600s grace offset from expiration, expiring 1h tokens immediately
  if (nowSec >= payload.exp - 3600) {
    return { valid: false, reason: "TOKEN_EXPIRED", sub: payload.sub };
  }

  return { valid: true, sub: payload.sub, exp: payload.exp };
}

export function legacyDecodeHeader(token) {
  const [body] = String(token || "").split(".");
  return body || "";
}
`;

export function resolveSandboxRoot(customRoot) {
  if (customRoot) return path.resolve(customRoot);
  if (process.env.VERCEL) return path.join(os.tmpdir(), "burnerapp-sandbox");
  return SOURCE_SANDBOX_ROOT;
}

function ensureSandboxInitialized(sandboxRoot) {
  fs.mkdirSync(path.join(sandboxRoot, "demo-repo"), { recursive: true });
  fs.mkdirSync(path.join(sandboxRoot, "receipts"), { recursive: true });

  if (sandboxRoot !== SOURCE_SANDBOX_ROOT) {
    const copyPairs = [
      ["demo-repo", "auth-token.test.mjs"],
      ["demo-repo", "package.json"],
      ["receipts", "dinner-receipts.json"]
    ];
    for (const [dir, file] of copyPairs) {
      const dst = path.join(sandboxRoot, dir, file);
      const src = path.join(SOURCE_SANDBOX_ROOT, dir, file);
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }
    const authPath = path.join(sandboxRoot, "demo-repo", "auth-token.mjs");
    if (!fs.existsSync(authPath)) {
      fs.writeFileSync(authPath, SEEDED_AUTH_TOKEN_SOURCE, "utf8");
    }
  }
}

export function resetSandbox(customRoot) {
  const sandboxRoot = resolveSandboxRoot(customRoot);
  ensureSandboxInitialized(sandboxRoot);
  const authPath = path.join(sandboxRoot, "demo-repo", "auth-token.mjs");
  const csvPath = path.join(sandboxRoot, "receipts", "settlement-export.csv");

  fs.writeFileSync(authPath, SEEDED_AUTH_TOKEN_SOURCE, "utf8");
  if (fs.existsSync(csvPath)) {
    fs.unlinkSync(csvPath);
  }

  return {
    reset: true,
    sandboxRoot,
    restoredFiles: ["demo-repo/auth-token.mjs"],
    removedFiles: ["receipts/settlement-export.csv"]
  };
}

function parseNodeTestSummary(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const passMatch = clean.match(/(?:ℹ|#)\s*pass\s+(\d+)/i);
  const failMatch = clean.match(/(?:ℹ|#)\s*fail\s+(\d+)/i);
  const testsMatch = clean.match(/(?:ℹ|#)\s*tests\s+(\d+)/i);
  return {
    total: testsMatch ? Number.parseInt(testsMatch[1], 10) : 0,
    passed: passMatch ? Number.parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? Number.parseInt(failMatch[1], 10) : 0
  };
}

function runDemoRepoTests(sandboxRoot) {
  const repoDir = path.join(sandboxRoot, "demo-repo");
  const start = performance.now();
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const proc = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "auth-token.test.mjs"], {
    cwd: repoDir,
    env: childEnv,
    encoding: "utf8",
    timeout: 15_000
  });
  const durationMs = Number((performance.now() - start).toFixed(2));
  const combinedOutput = `${proc.stdout || ""}\n${proc.stderr || ""}`.trim();
  const summary = parseNodeTestSummary(combinedOutput);

  return {
    exitCode: proc.status ?? 1,
    durationMs,
    ...summary,
    output: combinedOutput
  };
}

function inspectDemoRepo(sandboxRoot) {
  const repoDir = path.join(sandboxRoot, "demo-repo");
  const entries = fs.readdirSync(repoDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(repoDir, entry.name);
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, "utf8");
      const lineCount = content.split(/\r?\n/).length;
      return { name: entry.name, bytes: stat.size, lines: lineCount };
    });

  const authSource = fs.readFileSync(path.join(repoDir, "auth-token.mjs"), "utf8");
  const lines = authSource.split(/\r?\n/);
  const suspectIndex = lines.findIndex((line) => line.includes("payload.exp - 3600"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));

  return {
    repo: pkg.name,
    version: pkg.version,
    files,
    totalBytes: files.reduce((acc, f) => acc + f.bytes, 0),
    unusedDependencies: pkg.unusedDependencies || [],
    hasSeededBug: suspectIndex >= 0,
    suspectLine: suspectIndex >= 0 ? suspectIndex + 1 : null,
    suspectCode: suspectIndex >= 0 ? lines[suspectIndex].trim() : null
  };
}

function applyRepoPatch(sandboxRoot) {
  const authPath = path.join(sandboxRoot, "demo-repo", "auth-token.mjs");
  const current = fs.readFileSync(authPath, "utf8");
  const targetLine = "  if (nowSec >= payload.exp - 3600) {";
  const fixedLine = "  if (nowSec >= payload.exp) {";

  if (!current.includes(targetLine)) {
    const testResult = runDemoRepoTests(sandboxRoot);
    return {
      patched: false,
      alreadyFixed: true,
      diff: "No changes required; auth-token.mjs already uses exact payload.exp boundary.",
      testResult
    };
  }

  const updated = current
    .replace(
      "  // Seeded bug: subtracts 3600s grace offset from expiration, expiring 1h tokens immediately\n",
      "  // Patched by BurnerApp: enforce exact payload.exp expiration boundary\n"
    )
    .replace(
      "  // Seeded bug: subtracts 3600s grace offset from expiration, expiring 1h tokens immediately\r\n",
      "  // Patched by BurnerApp: enforce exact payload.exp expiration boundary\r\n"
    )
    .replace(targetLine, fixedLine);

  fs.writeFileSync(authPath, updated, "utf8");
  const testResult = runDemoRepoTests(sandboxRoot);

  return {
    patched: true,
    file: "demo-repo/auth-token.mjs",
    diff: `- ${targetLine.trim()}\n+ ${fixedLine.trim()}`,
    testResult
  };
}

function parseReceipts(sandboxRoot, params = {}) {
  const receiptsPath = path.join(sandboxRoot, "receipts", "dinner-receipts.json");
  const raw = JSON.parse(fs.readFileSync(receiptsPath, "utf8"));
  const includeDuplicates = Boolean(params.includeDuplicates);
  const seen = new Map();
  const duplicates = [];
  const activeReceipts = [];

  for (const receipt of raw.receipts) {
    const dedupeKey = `${receipt.merchant}|${receipt.paidBy}|${receipt.amountCents}`;
    const prev = seen.get(dedupeKey);
    const isDuplicate = Boolean(
      receipt.duplicateOf ||
        (prev &&
          Math.abs(Date.parse(receipt.timestamp) - Date.parse(prev.timestamp)) <= 120_000)
    );

    if (isDuplicate) {
      duplicates.push({
        id: receipt.id,
        duplicateOf: receipt.duplicateOf || prev?.id || null,
        merchant: receipt.merchant,
        amountCents: receipt.amountCents
      });
      if (!includeDuplicates) {
        continue;
      }
    } else {
      seen.set(dedupeKey, receipt);
    }
    activeReceipts.push(receipt);
  }

  const paidByPerson = new Map(raw.participants.map((p) => [p, 0]));
  const shareByPerson = new Map(raw.participants.map((p) => [p, 0]));

  for (const receipt of activeReceipts) {
    paidByPerson.set(receipt.paidBy, (paidByPerson.get(receipt.paidBy) || 0) + receipt.amountCents);
    const group = receipt.splitAmong && receipt.splitAmong.length > 0 ? receipt.splitAmong : raw.participants;
    const baseShare = Math.floor(receipt.amountCents / group.length);
    let remainder = receipt.amountCents % group.length;
    for (const member of group) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder -= 1;
      shareByPerson.set(member, (shareByPerson.get(member) || 0) + baseShare + extra);
    }
  }

  const totalCents = activeReceipts.reduce((sum, r) => sum + r.amountCents, 0);
  const balances = raw.participants.map((person) => {
    const paidCents = paidByPerson.get(person) || 0;
    const fairShareCents = shareByPerson.get(person) || 0;
    return {
      person,
      paidCents,
      fairShareCents,
      netCents: paidCents - fairShareCents
    };
  });

  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ person: b.person, oweCents: Math.abs(b.netCents) }))
    .sort((a, b) => b.oweCents - a.oweCents);

  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ person: b.person, owedCents: b.netCents }))
    .sort((a, b) => b.owedCents - a.owedCents);

  const settlements = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const amountCents = Math.min(debtors[di].oweCents, creditors[ci].owedCents);
    if (amountCents > 0) {
      settlements.push({
        from: debtors[di].person,
        to: creditors[ci].person,
        amountCents,
        amountUsd: `$${(amountCents / 100).toFixed(2)}`
      });
    }
    debtors[di].oweCents -= amountCents;
    creditors[ci].owedCents -= amountCents;
    if (debtors[di].oweCents === 0) di += 1;
    if (creditors[ci].owedCents === 0) ci += 1;
  }

  return {
    event: raw.event,
    currency: raw.currency,
    totalReceiptsScanned: raw.receipts.length,
    activeReceiptsCount: activeReceipts.length,
    duplicatesRemoved: duplicates,
    totalCents,
    totalUsd: `$${(totalCents / 100).toFixed(2)}`,
    balances,
    settlements
  };
}

function exportSettlementCsv(sandboxRoot, params = {}) {
  const report = parseReceipts(sandboxRoot, params);
  const rows = ["from,to,amount_cents,amount_usd,status"];
  for (const s of report.settlements) {
    rows.push(`${s.from},${s.to},${s.amountCents},${s.amountUsd},VERIFIED`);
  }
  const csvContent = `${rows.join("\n")}\n`;
  const csvPath = path.join(sandboxRoot, "receipts", "settlement-export.csv");
  fs.writeFileSync(csvPath, csvContent, "utf8");
  const sha256 = crypto.createHash("sha256").update(csvContent).digest("hex");

  return {
    exported: true,
    path: "fixtures/sandbox/receipts/settlement-export.csv",
    bytes: Buffer.byteLength(csvContent, "utf8"),
    rowCount: report.settlements.length,
    sha256,
    preview: csvContent.trim()
  };
}

export async function executeLocalTool(toolName, params = {}, customRoot) {
  const sandboxRoot = resolveSandboxRoot(customRoot);
  ensureSandboxInitialized(sandboxRoot);

  switch (toolName) {
    case "fs_bundle_inspect":
      return inspectDemoRepo(sandboxRoot);
    case "repo_test_runner":
      return runDemoRepoTests(sandboxRoot);
    case "repo_patch_apply":
      return applyRepoPatch(sandboxRoot);
    case "receipt_parse":
      return parseReceipts(sandboxRoot, params);
    case "csv_export":
      return exportSettlementCsv(sandboxRoot, params);
    default:
      throw new Error(`TOOL_NOT_IMPLEMENTED: ${toolName} cannot run directly in sandbox`);
  }
}
