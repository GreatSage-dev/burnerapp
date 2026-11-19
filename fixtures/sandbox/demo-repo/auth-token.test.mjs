import test from "node:test";
import assert from "node:assert/strict";
import { issueSessionToken, verifySessionToken } from "./auth-token.mjs";

const BASE_TIME = 1_795_000_000_000;

test("accepts fresh session token 60 seconds after issue", () => {
  const token = issueSessionToken("usr_maya", BASE_TIME, 3600);
  const result = verifySessionToken(token, BASE_TIME + 60_000);
  assert.equal(result.valid, true);
  assert.equal(result.sub, "usr_maya");
});

test("accepts session token halfway through 1-hour lifetime", () => {
  const token = issueSessionToken("usr_alex", BASE_TIME, 3600);
  const result = verifySessionToken(token, BASE_TIME + 1_800_000);
  assert.equal(result.valid, true);
  assert.equal(result.sub, "usr_alex");
});

test("rejects session token after full 3600-second expiry", () => {
  const token = issueSessionToken("usr_sam", BASE_TIME, 3600);
  const result = verifySessionToken(token, BASE_TIME + 3_601_000);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "TOKEN_EXPIRED");
});
