import crypto from "node:crypto";

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
  return `${body}.${sig}`;
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
