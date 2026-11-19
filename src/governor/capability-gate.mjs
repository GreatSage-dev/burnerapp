import crypto from "node:crypto";
import path from "node:path";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const SENSITIVE_PATH_PATTERNS = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /id_rsa|id_ed25519|\.pem$/i,
  /(^|[\\/])credentials(\.json)?$/i,
  /(^|[\\/])etc[\\/]passwd$/i,
  /\.\.[/\\]/,
  /^[/\\]\.\./
];

const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/[sqf]/i,
  /\bmkfs\b/i,
  /\bformat\s+[a-z]:/i,
  /\bcurl\s+.*\|\s*(sh|bash)/i,
  /\bwget\s+.*\|\s*(sh|bash)/i,
  /cat\s+.*\.env/i,
  /type\s+.*\.env/i,
  /printenv/i
];

function extractStringValues(value, collected = []) {
  if (typeof value === "string") {
    collected.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) extractStringValues(item, collected);
  } else if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      if (key === "_burnerId") continue;
      extractStringValues(val, collected);
    }
  }
  return collected;
}

function normalizeRelPath(inputPath) {
  return String(inputPath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPathWithinAllowedRoots(candidatePath, allowedPaths) {
  if (!allowedPaths || allowedPaths.length === 0) return true;
  const normalized = normalizeRelPath(candidatePath);
  if (normalized.includes("..") || path.isAbsolute(candidatePath)) {
    return false;
  }
  return allowedPaths.some((root) => {
    const cleanRoot = normalizeRelPath(root).replace(/\/$/, "");
    return normalized === cleanRoot || normalized.startsWith(`${cleanRoot}/`);
  });
}

export class BurnerRegistry {
  constructor(options = {}) {
    this.secret = options.secret || crypto.randomBytes(32).toString("hex");
    this.sessions = new Map();
    this.sessionKeyBindings = new Map();
    this.auditLog = [];
    this.maxAuditEntries = options.maxAuditEntries || 250;
  }

  spawnBurner({
    prompt = "",
    scenarioId = "custom",
    allowedTools = [],
    allowedPaths = [],
    ttlMs = DEFAULT_TTL_MS,
    sessionKey = null
  }) {
    const burnerId = `brn_${crypto.randomBytes(6).toString("hex")}`;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + ttlMs;
    const manifestPayload = {
      burnerId,
      scenarioId,
      allowedTools: [...new Set(allowedTools)],
      allowedPaths: [...new Set(allowedPaths)],
      issuedAt,
      expiresAt
    };

    const tokenSig = crypto
      .createHmac("sha256", this.secret)
      .update(JSON.stringify(manifestPayload))
      .digest("hex");

    const session = {
      ...manifestPayload,
      prompt,
      status: "ACTIVE",
      burnedAt: null,
      capabilityToken: `${burnerId}.${tokenSig.slice(0, 24)}`,
      callCount: 0,
      blockedCount: 0
    };

    this.sessions.set(burnerId, session);
    if (sessionKey) {
      this.sessionKeyBindings.set(sessionKey, burnerId);
    }

    return this.#sanitizeSession(session);
  }

  bindSessionKey(sessionKey, burnerId) {
    if (!this.sessions.has(burnerId)) {
      throw new Error(`UNKNOWN_BURNER_ID: ${burnerId}`);
    }
    this.sessionKeyBindings.set(sessionKey, burnerId);
  }

  resolveBurnerId(event = {}, ctx = {}) {
    return (
      event.burnerId ||
      ctx.burnerId ||
      event.params?._burnerId ||
      (ctx.sessionKey ? this.sessionKeyBindings.get(ctx.sessionKey) : null) ||
      null
    );
  }

  burnApp(burnerId, reason = "USER_TRIGGERED_BURN") {
    const session = this.sessions.get(burnerId);
    if (!session) {
      return { burned: false, reason: "UNKNOWN_BURNER_ID", burnerId };
    }
    session.status = "BURNED";
    session.burnedAt = Date.now();
    session.capabilityToken = null;

    const receipt = this.#recordReceipt({
      burnerId,
      toolName: "burner_lifecycle_burn",
      decision: "ALLOWED",
      rule: "MANIFEST_REVOKED",
      reason: `Capability token destroyed (${reason})`,
      evalTimeMs: 0.05,
      params: { reason }
    });

    return {
      burned: true,
      session: this.#sanitizeSession(session),
      receipt
    };
  }

  getSession(burnerId) {
    const session = this.sessions.get(burnerId);
    return session ? this.#sanitizeSession(session) : null;
  }

  listSessions() {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map((s) => this.#sanitizeSession(s));
  }

  getAuditLog(limit = 50) {
    return this.auditLog.slice(0, limit);
  }

  evaluateBeforeToolCall(event = {}, ctx = {}) {
    const start = performance.now();
    const burnerId = this.resolveBurnerId(event, ctx);
    const toolName = String(event.toolName || "");
    const params = event.params && typeof event.params === "object" ? event.params : {};
    const now = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();

    const finish = (decision, rule, reason) => {
      const evalTimeMs = Number(Math.max(0.01, performance.now() - start).toFixed(3));
      const receipt = this.#recordReceipt({
        burnerId: burnerId || "unscoped",
        toolName: toolName || "unknown",
        decision,
        rule,
        reason,
        evalTimeMs,
        params
      });
      return {
        allowed: decision === "ALLOWED",
        decision,
        rule,
        reason,
        evalTimeMs,
        receipt
      };
    };

    if (!burnerId || !this.sessions.has(burnerId)) {
      return finish(
        "BLOCKED",
        "UNKNOWN_BURNER_ID",
        `Tool call "${toolName}" rejected: no active BurnerApp capability manifest.`
      );
    }

    const session = this.sessions.get(burnerId);

    if (session.status === "BURNED") {
      session.blockedCount += 1;
      return finish(
        "BLOCKED",
        "BURNER_REVOKED",
        `BurnerApp ${burnerId} was burned at ${new Date(session.burnedAt).toISOString()}; capability token wiped.`
      );
    }

    if (now > session.expiresAt) {
      session.status = "EXPIRED";
      session.capabilityToken = null;
      session.blockedCount += 1;
      return finish(
        "BLOCKED",
        "MANIFEST_EXPIRED",
        `BurnerApp ${burnerId} TTL expired; spawn a fresh burner to continue.`
      );
    }

    const stringValues = extractStringValues(params);
    if (Array.isArray(event.derivedPaths)) {
      stringValues.push(...event.derivedPaths.map(String));
    }

    for (const rawVal of stringValues) {
      if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(rawVal))) {
        session.blockedCount += 1;
        return finish(
          "BLOCKED",
          "SECURITY_INVARIANT_VIOLATION",
          `Sensitive path or traversal blocked in parameter: "${rawVal}"`
        );
      }
      if (DANGEROUS_SHELL_PATTERNS.some((re) => re.test(rawVal))) {
        session.blockedCount += 1;
        return finish(
          "BLOCKED",
          "SECURITY_INVARIANT_VIOLATION",
          `Destructive or exfiltration shell command blocked: "${rawVal}"`
        );
      }
    }

    if (!session.allowedTools.includes(toolName)) {
      session.blockedCount += 1;
      return finish(
        "BLOCKED",
        "TOOL_OUTSIDE_MANIFEST",
        `Tool "${toolName}" is not in manifest [${session.allowedTools.join(", ")}].`
      );
    }

    const candidatePaths = [
      ...(params.path ? [params.path] : []),
      ...(params.file ? [params.file] : []),
      ...(Array.isArray(event.derivedPaths) ? event.derivedPaths : [])
    ];

    for (const candidatePath of candidatePaths) {
      if (!isPathWithinAllowedRoots(candidatePath, session.allowedPaths)) {
        session.blockedCount += 1;
        return finish(
          "BLOCKED",
          "PATH_OUTSIDE_MANIFEST",
          `Path "${candidatePath}" falls outside allowed roots [${session.allowedPaths.join(", ")}].`
        );
      }
    }

    session.callCount += 1;
    return finish(
      "ALLOWED",
      "MANIFEST_CAPABILITY_GRANTED",
      `Verified tool "${toolName}" inside scoped manifest for ${burnerId}.`
    );
  }

  #recordReceipt({ burnerId, toolName, decision, rule, reason, evalTimeMs, params }) {
    const timestamp = new Date().toISOString();
    const receiptId = `rcpt_${crypto.randomBytes(5).toString("hex")}`;
    const digestInput = JSON.stringify({
      receiptId,
      burnerId,
      toolName,
      decision,
      rule,
      reason,
      params,
      timestamp
    });
    const sha256 = crypto.createHash("sha256").update(digestInput).digest("hex");

    const receipt = {
      receiptId,
      burnerId,
      toolName,
      decision,
      rule,
      reason,
      evalTimeMs,
      sha256,
      timestamp
    };

    this.auditLog.unshift(receipt);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.length = this.maxAuditEntries;
    }
    return receipt;
  }

  #sanitizeSession(session) {
    return {
      burnerId: session.burnerId,
      scenarioId: session.scenarioId,
      prompt: session.prompt,
      status: session.status,
      allowedTools: [...session.allowedTools],
      allowedPaths: [...session.allowedPaths],
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      burnedAt: session.burnedAt,
      hasActiveToken: Boolean(session.capabilityToken),
      tokenPreview: session.capabilityToken
        ? `${session.capabilityToken.slice(0, 18)}...`
        : "REVOKED",
      callCount: session.callCount,
      blockedCount: session.blockedCount
    };
  }
}
