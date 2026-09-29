import { describe, expect, test } from "bun:test";
import { MagicContextConfigSchema } from "../../../config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "./task-config";
import { DREAM_TOOL_LOOP_TOKEN_BUDGETS } from "./task-registry";
import { createDreamTokenBudget, TOKEN_BUDGET_FINALIZE_MESSAGE } from "./token-budget";

describe("dreamer prompt-token budget", () => {
    test("uses per-task defaults and validates explicit overrides", () => {
        const config = MagicContextConfigSchema.parse({
            dreamer: { tasks: { verify: { token_budget: 750_000 } } },
        });
        const tasks = buildDreamTaskRuntimeConfigs(config.dreamer, "opencode");
        expect(tasks.find((task) => task.task === "verify")?.tokenBudget).toBe(750_000);
        expect(tasks.find((task) => task.task === "map-memories")?.tokenBudget).toBe(
            DREAM_TOOL_LOOP_TOKEN_BUDGETS["map-memories"],
        );
        expect(
            tasks.find((task) => task.task === "classify-memories")?.tokenBudget,
        ).toBeUndefined();
        expect(() =>
            MagicContextConfigSchema.parse({ dreamer: { tasks: { verify: { token_budget: 0 } } } }),
        ).toThrow();
    });
    test("does not finalize work under the soft limit", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(30, 40, 9)).toBe("continue");
        expect(guard.snapshot()).toMatchObject({ spent: 79, finalizeFired: false });
        expect(guard.refuseTool()).toBeNull();
    });

    test("fires once at the soft limit", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(10, 70, 0)).toBe("finalize");
        expect(TOKEN_BUDGET_FINALIZE_MESSAGE).toContain("no more tool calls");
        expect(guard.charge(1, 0, 0)).toBe("continue");
        expect(guard.snapshot().finalizeFired).toBe(true);
    });

    test("refuses tools after finalize and stops after the second refusal", () => {
        const guard = createDreamTokenBudget(100);
        guard.charge(80, 0, 0);
        expect(guard.refuseTool()).toMatchObject({ hardStopped: false });
        expect(guard.refuseTool()).toMatchObject({ hardStopped: true });
    });

    test("hard-stops at soft threshold without claiming a finalize when tools cannot be intercepted", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(81, 0, 0, false, false)).toBe("stop");
        expect(guard.snapshot()).toMatchObject({
            spent: 81,
            finalizeFired: false,
            hardStopped: true,
        });
    });

    test("stops at 100 percent even without two refusals", () => {
        const guard = createDreamTokenBudget(100);
        expect(guard.charge(90, 0, 0)).toBe("finalize");
        expect(guard.charge(0, 5, 5)).toBe("stop");
        expect(guard.snapshot()).toMatchObject({ spent: 100, hardStopped: true });
    });
});
