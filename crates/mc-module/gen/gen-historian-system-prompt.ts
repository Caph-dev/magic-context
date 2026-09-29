/**
 * Vendor the historian SYSTEM prompt from the TS source of truth.
 *
 * The TS side generates historian-prompt.generated.ts from historian-prompt.source.md;
 * this script re-exports that exact string as a committed text asset so the Rust
 * producer sends byte-identical system-prompt bytes. Never edit the .txt by hand.
 *
 * It also writes historian-system-prompt-golden.json: the prompt's byte length and
 * SHA-256, plus the `<facts>` guidance lines that must survive any prompt edit. Both the
 * TypeScript and the Rust test suites check their own prompt constant against that one
 * golden, so the two lanes cannot silently diverge or lose the fact-admission rules.
 *
 * Run:         bun crates/mc-module/gen/gen-historian-system-prompt.ts
 * Drift check: bun crates/mc-module/gen/gen-historian-system-prompt.ts --check
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);
const mod = (await import(
    resolve("./src/hooks/magic-context/historian-prompt.generated")
)) as Record<string, unknown>;

const candidates = Object.entries(mod).filter(
    ([, v]) => typeof v === "string" && (v as string).length > 10_000,
);
if (candidates.length !== 1) {
    throw new Error(
        `expected exactly one large prompt export, found: ${candidates.map(([k]) => k).join(", ") || "none"}`,
    );
}
const prompt = candidates[0][1] as string;

// Lines of the `<facts>` section that must stay in the prompt. They carry the fact
// admission policy: an empty result is normal, the rediscovery and stays-true tests, the
// four observed noise classes to reject, the changed-value update rule, and the per-category
// tests. Every line must sit between the Facts heading and the Events heading.
const FACTS_GUIDANCE = [
    "### Zero facts is normal",
    "**Emitting no facts is valid and often correct.**",
    "These usually pass: a discovered gotcha of an external system, a rule for recurring work, a security or correctness invariant.",
    "There is no quota either way: a rare one-off rule, such as a security constraint, must still be emitted.",
    "**Rediscovery**: a future session in this project would otherwise have to rediscover it",
    "**Stays true**: it remains true after this session without anyone revisiting it.",
    "**A changed or measured number, threshold, timeout, count or status**",
    "**A recap of what a commit or change did**",
    "**A detail of a design still being revised**",
    'revision labels such as "r5", "draft", "proposal"',
    'any fact naming a revision ("r6.4")',
    "**A restatement of a visible memory**",
    "Only emit a fact you've seen before in memory if the underlying value or behavior has actually CHANGED in this chunk's evidence (then emit with the new value",
    '**Test**: "Should a new developer/agent follow this to avoid breaking things during normal recurring work?"',
    "HARD STOP — before extracting any fact into ARCHITECTURE",
    "**The key test**: would fixing this fact require us to change SOMEONE ELSE'S code?",
    "HARD STOP — before extracting any fact into CONFIG_VALUES",
    "**The key test for CONFIG_VALUES**",
    "HARD STOP — before extracting any fact into NAMING",
    "**The key test for NAMING**",
    "### Category-routing test",
    "Omit `<facts>` entirely when there are no facts",
];
const FACTS_SECTION_START = "## Facts — durable world knowledge";
const FACTS_SECTION_END = "## Events — ";
// A numeric fact cap would drop rare one-off constraints, so the Facts section must not
// state one. Matched case-insensitively against the Facts section only.
const FORBIDDEN_FACTS_PATTERNS = [
    "\\b(?:at most|no more than|maximum of|up to|cap(?:ped)? at)\\s+(?:\\d+|one|two|three|four|five)\\s+facts?\\b",
];

const factsStart = prompt.indexOf(FACTS_SECTION_START);
const factsEnd = prompt.indexOf(FACTS_SECTION_END, factsStart);
const outputRules = prompt.slice(prompt.lastIndexOf("\nRules:\n"));
if (factsStart < 0 || factsEnd < 0) {
    throw new Error("historian system prompt lost its Facts or Events heading");
}
const factsSection = prompt.slice(factsStart, factsEnd);
for (const line of FACTS_GUIDANCE) {
    // The empty-facts output rule lives in the final output rules; the rest in Facts.
    const scope = line.startsWith("Omit `<facts>` entirely") ? outputRules : factsSection;
    if (!scope.includes(line)) {
        throw new Error(`historian system prompt lost required facts guidance: ${line}`);
    }
}
for (const pattern of FORBIDDEN_FACTS_PATTERNS) {
    if (new RegExp(pattern, "i").test(factsSection)) {
        throw new Error(`historian Facts section states a numeric fact cap: /${pattern}/`);
    }
}

const golden = {
    bytes: Buffer.byteLength(prompt, "utf8"),
    sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    facts_section_start: FACTS_SECTION_START,
    facts_section_end: FACTS_SECTION_END,
    facts_guidance: FACTS_GUIDANCE,
    forbidden_facts_patterns: FORBIDDEN_FACTS_PATTERNS,
};
const renderedGolden = `${JSON.stringify(golden, null, 2)}\n`;

const path = join(import.meta.dir, "..", "testdata", "historian-system-prompt.txt");
const goldenPath = join(import.meta.dir, "..", "testdata", "historian-system-prompt-golden.json");
if (process.argv.includes("--check")) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== prompt) {
        throw new Error(
            "historian system prompt drift; run bun crates/mc-module/gen/gen-historian-system-prompt.ts",
        );
    }
    if (!existsSync(goldenPath) || readFileSync(goldenPath, "utf8") !== renderedGolden) {
        throw new Error(
            "historian system prompt golden drift; run bun crates/mc-module/gen/gen-historian-system-prompt.ts",
        );
    }
} else {
    writeFileSync(path, prompt);
    writeFileSync(goldenPath, renderedGolden);
}
