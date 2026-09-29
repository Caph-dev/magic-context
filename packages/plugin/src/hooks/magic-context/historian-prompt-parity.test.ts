/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";

// The historian system prompt is edited in historian-prompt.source.md, emitted as a TS
// constant, and vendored byte-for-byte into the Rust module. The golden JSON (written by
// crates/mc-module/gen/gen-historian-system-prompt.ts) pins the prompt's size, hash and the
// `<facts>` admission guidance; the Rust suite checks its own constant against the same file.
const root = resolve(import.meta.dir, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

interface SystemPromptGolden {
    bytes: number;
    sha256: string;
    facts_section_start: string;
    facts_section_end: string;
    facts_guidance: string[];
    forbidden_facts_patterns: string[];
}

const golden = JSON.parse(
    read("crates/mc-module/testdata/historian-system-prompt-golden.json"),
) as SystemPromptGolden;

function factsSection(prompt: string): string {
    const start = prompt.indexOf(golden.facts_section_start);
    const end = prompt.indexOf(golden.facts_section_end, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(start, end);
}

describe("historian system prompt parity", () => {
    it("emits the source prompt unchanged", () => {
        const source = read(
            "packages/plugin/src/hooks/magic-context/historian-prompt.source.md",
        ).trimEnd();
        expect(COMPARTMENT_AGENT_SYSTEM_PROMPT).toBe(source);
    });

    it("matches the Rust vendored prompt byte for byte", () => {
        expect(read("crates/mc-module/testdata/historian-system-prompt.txt")).toBe(
            COMPARTMENT_AGENT_SYSTEM_PROMPT,
        );
    });

    it("matches the shared golden's size and hash", () => {
        expect(Buffer.byteLength(COMPARTMENT_AGENT_SYSTEM_PROMPT, "utf8")).toBe(golden.bytes);
        expect(
            createHash("sha256").update(COMPARTMENT_AGENT_SYSTEM_PROMPT, "utf8").digest("hex"),
        ).toBe(golden.sha256);
    });

    it("keeps the fact admission guidance: zero facts is normal, reject classes, category tests", () => {
        const facts = factsSection(COMPARTMENT_AGENT_SYSTEM_PROMPT);
        const outputRules = COMPARTMENT_AGENT_SYSTEM_PROMPT.slice(
            COMPARTMENT_AGENT_SYSTEM_PROMPT.lastIndexOf("\nRules:\n"),
        );
        expect(golden.facts_guidance.length).toBeGreaterThan(0);
        for (const line of golden.facts_guidance) {
            const scope = line.startsWith("Omit `<facts>` entirely") ? outputRules : facts;
            expect(scope).toContain(line);
        }
    });

    it("states no numeric cap on facts", () => {
        const facts = factsSection(COMPARTMENT_AGENT_SYSTEM_PROMPT);
        expect(golden.forbidden_facts_patterns.length).toBeGreaterThan(0);
        for (const pattern of golden.forbidden_facts_patterns) {
            const regex = new RegExp(pattern, "i");
            expect(regex.test("Emit at most 3 facts per compartment.")).toBe(true);
            expect(regex.test(facts)).toBe(false);
        }
    });
});
