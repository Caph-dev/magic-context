import { expect, test } from "bun:test";

import { producerInputTokenLimit } from "../hooks/magic-context/producer-window-guard";
import {
    createDreamerOutputCapSampler,
    rememberHistorianOutputCap,
    withLiveDreamerOutputCap,
} from "./live-child-output-cap";
import { MagicContextConfigSchema } from "./schema/magic-context";

test("OpenCode 1 dreamer keeps its run cap while the next child receives the live cap", () => {
    const boot = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 2048 } });
    let current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 4096 } });
    const sampler = createDreamerOutputCapSampler(boot, () => current);
    const output = { maxOutputTokens: undefined as number | undefined };
    sampler.apply({ sessionID: "child-a", agent: "dreamer-classifier" }, output);
    expect(output.maxOutputTokens).toBe(4096);
    current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 8192 } });
    sampler.apply({ sessionID: "child-a", agent: "dreamer-classifier" }, output);
    expect(output.maxOutputTokens).toBe(4096);
    sampler.apply({ sessionID: "child-b", agent: "dreamer-classifier" }, output);
    expect(output.maxOutputTokens).toBe(8192);
    sampler.apply({ sessionID: "user", agent: "assistant" }, output);
    expect(output.maxOutputTokens).toBe(8192);
});

test("OpenCode 2 dreamer passes a fresh output cap to each hidden child", async () => {
    const boot = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 2048 } });
    let current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 4096 } });
    const received: Array<number | undefined> = [];
    const executor = withLiveDreamerOutputCap(
        {
            capabilities: { tools: true, harness: "opencode" },
            open: async (run: { maxOutputTokens?: number }) => {
                received.push(run.maxOutputTokens);
                return { id: `child-${received.length}` };
            },
        } as never,
        boot,
        () => current,
    );
    const run = {
        agent: "dreamer-classifier",
        kind: "dreamer-task" as const,
        system: "",
        timeoutMs: 10,
        title: "dream",
        directory: "/project",
    };
    await executor.open(run);
    current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 8192 } });
    await executor.open(run);
    expect(received).toEqual([4096, 8192]);
});

test("OpenCode 1 historian keeps the sampled reserve and child output cap", () => {
    const boot = MagicContextConfigSchema.parse({ historian: { maxTokens: 2048 } });
    let current = MagicContextConfigSchema.parse({ historian: { maxTokens: 4096 } });
    const sampler = createDreamerOutputCapSampler(boot, () => current);
    const output = { maxOutputTokens: undefined as number | undefined };
    const firstCap = current.historian?.maxTokens;
    rememberHistorianOutputCap("hist-a", firstCap);
    sampler.apply({ sessionID: "hist-a", agent: "historian" }, output);
    expect(output.maxOutputTokens).toBe(4096);
    current = MagicContextConfigSchema.parse({ historian: { maxTokens: 8192 } });
    sampler.apply({ sessionID: "hist-a", agent: "historian" }, output);
    expect(output.maxOutputTokens).toBe(firstCap);
    const secondCap = current.historian?.maxTokens;
    rememberHistorianOutputCap("hist-b", secondCap);
    sampler.apply({ sessionID: "hist-b", agent: "historian" }, output);
    expect(output.maxOutputTokens).toBe(8192);
    expect(producerInputTokenLimit(32_000, secondCap ?? 0)).toBe(23_093);
    sampler.delete("hist-a");
    sampler.delete("hist-b");
});
