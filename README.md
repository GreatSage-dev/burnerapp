# BurnerApp

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Tests: 23/23 passing](https://img.shields.io/badge/Tests-23%2F23%20passing-brightgreen.svg)](tests/burnerapp.test.mjs)
[![Cockpit: /judge](https://img.shields.io/badge/Cockpit-%2Fjudge%20split--screen-f97316.svg)](JUDGES.md)

**Burner phones, for software.** AI agents trap real local work inside endless text chat because generating a live app takes ~40 seconds on GPUs. BurnerApp runs inside OpenClaw Canvas on Kimi K3.1 Pro (`moonshotai-kimi-k3.1-pro-trial`) and Cerebras to spawn a scoped local micro-app in about a second, wire its buttons to real local tools, and burn it when finished. Any unauthorized file, shell, or post-burn call is stopped by an OpenClaw `before_tool_call` capability manifest.

Open the split-screen `/judge` cockpit: click **1. Repo Bug & Test Fixer**, watch the right micro-app appear and flip real `node --test` assertions from `1/3` to `3/3 PASS` while the left GPU clock crawls at `45 tok/s`, then click **Try Read `.env`** or **Burn App -> Try Call After Burn** to watch the OpenClaw hook reject it with a SHA-256 refusal receipt.

## Architecture

```text
+-----------------------------------------------------------------------------+
|  1. PROMPT / TASK  -->  Kimi K3.1 Pro on Cerebras (moonshotai-kimi-k3.1-pro) |
+------------------------------------+----------------------------------------+
                                     | (~3,200 tokens / app; fits 100K TPM)
                                     v
+-----------------------------------------------------------------------------+
|  2. EPHEMERAL MANIFEST  -->  BurnerRegistry (burnerId + HMAC token + TTL)   |
|     Allowed tools & paths scoped per micro-app; wiped on Burn               |
+------------------------------------+----------------------------------------+
                                     |
         +---------------------------+---------------------------+
         | 50% ACCELERATOR (Green Path)                          | 50% GOVERNOR (Red Path)
         v                                                       v
+----------------------------------+             +----------------------------+
| OpenClaw before_tool_call (p=100)|             | OpenClaw before_tool_call  |
| MANIFEST_CAPABILITY_GRANTED      |             | BLOCKED: .env / rm -rf /   |
| Runs real node --test / patch /  |             | ../ / unlisted / burned    |
| integer-cent receipt CSV export  |             | Returns HTTP 403 + SHA-256 |
+----------------------------------+             +----------------------------+
```

## Quickstart (Zero Setup Required)

```bash
git clone https://github.com/GreatSage-dev/burnerapp.git
cd burnerapp
npm start
# Open http://127.0.0.1:3847/judge in your browser
```

To run with a live Cerebras key (`CEREBRAS_API_KEY`):

```bash
cp .env.example .env
# Add CEREBRAS_API_KEY=csk-... inside .env (or paste in the UI "BYOK Key" drawer)
npm start
npm run tps:hunt
```

To install as an OpenClaw Gateway plugin:

```bash
openclaw plugins install .
```

## Evidence Ledger (Machine-Generated)

All numbers below come directly from running `npm run verify` (`evidence/report.json`):

| Check | Measured Output | Source |
| :--- | :--- | :--- |
| Full Deterministic Suite (`npm test`) | **23 / 23 passing** (`exit code 0`) | [tests/burnerapp.test.mjs](tests/burnerapp.test.mjs) |
| End-to-End Cockpit Smoke (`npm run smoke`) | **2 scenarios + `/rob` + burn PASS** | [scripts/smoke.mjs](scripts/smoke.mjs) |
| OpenClaw `before_tool_call` Governor | **6 / 6 hostile vectors blocked** (`< 2ms` eval; see report) | [evidence/report.json](evidence/report.json) |
| Real Local Auth Repo Patch | **`1/3` failing -> `3/3` passing** (`exit code 0`) | [src/tools/local-tools.mjs](src/tools/local-tools.mjs) |
| Real 6-Receipt Integer-Cent Split | **`$264.00` deduplicated**, caught `$26.40` dup, SHA-256 CSV | [fixtures/sandbox/receipts/dinner-receipts.json](fixtures/sandbox/receipts/dinner-receipts.json) |
| Plain-Words Gate (`npm run check:words`) | **0 banned words**, hero `< 300` words | [scripts/plain-words-check.mjs](scripts/plain-words-check.mjs) |

## What Is Real vs. Offline Sandbox Replay

| Component | Live Key Present | Offline / No Key (Default `/judge` Replay) |
| :--- | :--- | :--- |
| **Kimi K3.1 Pro Compilation** | Calls `api.cerebras.ai/v1/chat/completions` (`moonshotai-kimi-k3.1-pro-trial`) with `time_info` TPS & rolling `100K TPM` tracking | Uses pre-verified micro-app specs and explicitly labels `OFFLINE_SANDBOX_REPLAY` (`tps: null`, zero fake speed numbers) |
| **OpenClaw `before_tool_call` Hook** | **100% Real** local capability manifest evaluation & SHA-256 receipts | **100% Real** local capability manifest evaluation & SHA-256 receipts |
| **Local Sandbox Tools** | **100% Real** disk reads, `node --test` subprocesses, patches, and CSV writes | **100% Real** disk reads, `node --test` subprocesses, patches, and CSV writes |
| **Left Pane GPU Clock (`45 tok/s`)** | Mathematical completion-time pacing (`completionTokens / 45`) | Mathematical completion-time pacing (`completionTokens / 45`) |

## Hackathon Details

- **Event:** Cerebras × Kimi K3.1 Pro & OpenClaw 24-Hour Hackathon
- **Model:** `moonshotai-kimi-k3.1-pro-trial`
- **Evaluator Guide:** See [JUDGES.md](JUDGES.md) for the 30-second walkthrough, `curl` checks, and 60-second demo video checklist.
