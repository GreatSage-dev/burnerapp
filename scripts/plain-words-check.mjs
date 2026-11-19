import fs from "node:fs";
import path from "node:path";

const BANNED_WORDS = [
  "seamless",
  "seamlessly",
  "robust",
  "revolutionize",
  "revolutionary",
  "empower",
  "empowering",
  "leverage",
  "leveraging",
  "cutting-edge",
  "trustless",
  "decentralized",
  "orchestrate",
  "orchestration",
  "primitive",
  "paradigm",
  "synergy",
  "autonomous ecosystem",
  "game-changing",
  "next-gen",
  "next-generation",
  "unlock"
];

const HERO_MAX_WORDS = 300;

export function lintTextForSlop(text, maxWords = HERO_MAX_WORDS) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const term of BANNED_WORDS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(lower)) {
      hits.push(term);
    }
  }
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[#>*`|_~-]/g, " ");
  const words = stripped.trim().split(/\s+/).filter(Boolean);

  return {
    passed: hits.length === 0 && words.length <= maxWords,
    wordCount: words.length,
    maxWords,
    bannedHits: hits
  };
}

export function extractHeroSection(readmeText) {
  const marker = readmeText.search(/^##\s+(?:Architecture|Quickstart|How It Works|Evidence)/m);
  return marker > 0 ? readmeText.slice(0, marker) : readmeText;
}

const readmePath = path.resolve(process.cwd(), "README.md");
if (fs.existsSync(readmePath)) {
  const readmeText = fs.readFileSync(readmePath, "utf8");
  const hero = extractHeroSection(readmeText);
  const fullCheck = lintTextForSlop(readmeText, 2500);
  const heroCheck = lintTextForSlop(hero, HERO_MAX_WORDS);

  if (fullCheck.bannedHits.length > 0) {
    console.error(`FAIL check:words -> banned buzzwords in README.md: ${fullCheck.bannedHits.join(", ")}`);
    process.exit(1);
  }
  if (!heroCheck.passed) {
    console.error(
      `FAIL check:words -> hero exceeds ${HERO_MAX_WORDS} words (${heroCheck.wordCount} words)`
    );
    process.exit(1);
  }

  console.log(`PASS check:words -> 0 banned words, hero ${heroCheck.wordCount}/${HERO_MAX_WORDS} words`);
} else {
  console.error("FAIL check:words -> README.md missing");
  process.exit(1);
}
