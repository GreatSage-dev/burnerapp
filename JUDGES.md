# Judge & Evaluator Guide (30-Second Verification)

Zero accounts, zero external databases, and zero capital required. Everything runs locally out of the box, with optional live Cerebras API inference via `.env` or the UI `BYOK Key` button.

## 1. Interactive Cockpit (`/judge`)

```bash
npm start
# Visit http://127.0.0.1:3847/judge
```

1. Click **1. Repo Bug & Test Fixer (Dev)** — notice the right pane spawns instantly while the left GPU pane (`45 tok/s`) crawls line by line.
2. Click **Run `node --test` (Before Patch)** — observe real `1/3` passing, `2/3` failing (`exitCode: 1`).
3. Click **Apply 1-Line Patch & Re-Test** — observe real patch written to `fixtures/sandbox/demo-repo/auth-token.mjs` and tests flip to `3/3 PASS (exitCode: 0)`.
4. Click **Try Read `.env`** or **Try `rm -rf /`** in the `/rob` red-team bar — observe HTTP `403` and an immediate `SECURITY_INVARIANT_VIOLATION` SHA-256 receipt in the bottom ledger.
5. Click **Burn App (Revoke Token)**, then **Try Call After Burn** — observe `BURNER_REVOKED`.
6. Click **2. 6-Receipt Bill Splitter (Everyday)** — scan 6 dinner receipts, verify duplicate `RCP-104-DUP` (`$26.40`) is removed, and export a SHA-256 settlement CSV.
7. Click **Reset Sandbox** to restore the initial seeded bug state anytime.

## 2. 30-Second CLI / `curl` Verification

Verify everything deterministically in one command:

```bash
npm run verify
```

Or test the HTTP API directly while `npm start` is running:

```bash
# 1. Spawn a scoped BurnerApp
curl -s -X POST http://127.0.0.1:3847/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"scenarioId":"repo-triage"}'

# 2. Pass the returned burnerId to execute a real test run (200 OK)
curl -s -X POST http://127.0.0.1:3847/api/tool-call \
  -H "Content-Type: application/json" \
  -d '{"burnerId":"<BURNER_ID>","toolName":"repo_test_runner","params":{}}'

# 3. Attempt an unauthorized .env read (403 BLOCKED by before_tool_call)
curl -i -s -X POST http://127.0.0.1:3847/api/tool-call \
  -H "Content-Type: application/json" \
  -d '{"burnerId":"<BURNER_ID>","toolName":"fs_bundle_inspect","params":{"path":".env"}}'
```

## 3. 60-Second Split-Screen Recording Script (X + `r/cerebras`)

Once Saturday preview access activates (`CEREBRAS_API_KEY` set):
- **0:00–0:03**: Show `/judge` empty split screen (no slides).
- **0:03–0:18**: Trigger Scenario 1 -> right app appears in ~1s -> click **Run Tests** -> **Apply Patch & Verify** (`3/3 PASS`) while left GPU clock is still streaming.
- **0:18–0:30**: Click **Try Read `.env`** -> show red `before_tool_call` receipt -> click **Burn App** -> **Try Call After Burn** (`BURNER_REVOKED`).
- **0:30–0:48**: Trigger Scenario 2 (**6-Receipt Bill Splitter**) -> scan & dedupe -> export CSV — while left GPU pane is only finishing Scenario 1.
- **0:48–0:58**: Run `npm run tps:hunt` terminal pane showing live `moonshotai-kimi-k3.1-pro-trial` TPS numbers.
