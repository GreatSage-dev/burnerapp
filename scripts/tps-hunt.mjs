import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CEREBRAS_MODEL,
  callCerebrasChat,
  computeTpsTelemetry,
  loadDotEnv
} from "../src/compiler/kimi-cerebras.mjs";

loadDotEnv();

export const TPS_PROMPT_ARCHETYPES = [
  {
    id: "hex-stream-4096",
    hypothesis: "Ultra-compact prefill + deterministic incrementing hex lines minimizes branching",
    system: "Output raw lines only. No commentary.",
    prompt: "Emit 256 sequential hexadecimal checksum lines formatted strictly as 0000:00000000."
  },
  {
    id: "json-matrix-records",
    hypothesis: "Predictable key ordering with monotonic integers stabilizes token stream",
    system: "Return compact NDJSON lines only.",
    prompt: "Generate 180 NDJSON telemetry rows: {\"id\":N,\"status\":\"OK\",\"latency_ms\":1}."
  },
  {
    id: "unrolled-squares-table",
    hypothesis: "Arithmetic sequence requires minimal KV lookups and zero tool branching",
    system: "Output plain tabular numbers only.",
    prompt: "Print the squares and cubes of integers 1 through 300 as comma-separated rows n,n2,n3."
  },
  {
    id: "ascii-grid-tile",
    hypothesis: "Low-entropy repeating characters maximize SRAM decode burst speed",
    system: "Output raw ASCII grid only.",
    prompt: "Output an 80x40 deterministic checkerboard grid using # and . characters."
  },
  {
    id: "ts-dto-scaffold",
    hypothesis: "Dense syntactic TypeScript definitions test real coding token throughput",
    system: "Output valid TypeScript interfaces only.",
    prompt: "Write 80 numbered TypeScript event record interfaces Event001 through Event080."
  }
];

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2))
    : sorted[mid];
}

export async function runTpsHunt({
  apiKey = process.env.CEREBRAS_API_KEY || "",
  model = process.env.CEREBRAS_MODEL || DEFAULT_CEREBRAS_MODEL,
  runsPerPrompt = 2,
  writeOutput = true
} = {}) {
  const results = [];
  const mode = apiKey ? "LIVE_CEREBRAS_API" : "DRY_RUN_OFFLINE_NO_KEY";

  for (const archetype of TPS_PROMPT_ARCHETYPES) {
    if (!apiKey) {
      results.push({
        id: archetype.id,
        hypothesis: archetype.hypothesis,
        promptChars: archetype.prompt.length,
        runsAttempted: 0,
        medianTps: null,
        status: "READY_AWAITING_CEREBRAS_API_KEY"
      });
      continue;
    }

    const tpsSamples = [];
    const errors = [];
    for (let run = 0; run < runsPerPrompt; run += 1) {
      try {
        const payload = await callCerebrasChat({
          apiKey,
          model,
          messages: [
            { role: "system", content: archetype.system },
            { role: "user", content: archetype.prompt }
          ],
          maxTokens: 2048,
          temperature: 0,
          promptCacheKey: `tps-hunt:${archetype.id}`
        });
        const telemetry = computeTpsTelemetry({
          usage: payload.usage,
          timeInfo: payload.time_info
        });
        tpsSamples.push(telemetry.tps);
      } catch (err) {
        errors.push(err.message);
      }
    }

    results.push({
      id: archetype.id,
      hypothesis: archetype.hypothesis,
      promptChars: archetype.prompt.length,
      runsAttempted: runsPerPrompt,
      tpsSamples,
      medianTps: median(tpsSamples),
      errors
    });
  }

  const ranked = [...results].sort((a, b) => (b.medianTps || 0) - (a.medianTps || 0));
  const report = {
    generatedAt: new Date().toISOString(),
    model,
    mode,
    runsPerPrompt: apiKey ? runsPerPrompt : 0,
    winnerPromptId: ranked[0]?.medianTps ? ranked[0].id : null,
    winnerMedianTps: ranked[0]?.medianTps || null,
    results: ranked
  };

  if (writeOutput) {
    const outDir = path.resolve(process.cwd(), "evidence");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "tps-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runTpsHunt()
    .then((report) => {
      console.log(`tps-hunt (${report.mode}): ${report.results.length} prompt archetypes evaluated -> evidence/tps-benchmark.json`);
      if (report.winnerPromptId) {
        console.log(`Winner: ${report.winnerPromptId} @ ${report.winnerMedianTps} tok/s`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
