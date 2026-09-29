export const TOKEN_BUDGET_FINALIZE_MESSAGE =
    "You're out of token budget. Stop investigating: make no more tool calls and output your result now, covering only what you've already checked; leave the rest out.";
export const TOKEN_BUDGET_TOOL_REFUSAL =
    "Out of token budget: no more tool calls. Output your result now.";

/** Count only provider-reported prompt tokens. Output and reasoning do not replay
 * the accumulated context and must not be added to this cost guard. */
export interface DreamTokenBudgetState {
    readonly budget: number;
    readonly spent: number;
    readonly finalizeFired: boolean;
    readonly refusedCalls: number;
    readonly hardStopped: boolean;
}

export function createDreamTokenBudget(budget: number) {
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid token budget");
    let spent = 0;
    let finalizeFired = false;
    let refusedCalls = 0;
    const snapshot = (): DreamTokenBudgetState => ({
        budget,
        spent,
        finalizeFired,
        refusedCalls,
        hardStopped: spent >= budget || refusedCalls >= 2,
    });
    return {
        snapshot,
        /** Call once per provider usage report; a host must deduplicate message IDs. */
        charge(
            input: number,
            cacheRead: number,
            cacheWrite: number,
        ): "continue" | "finalize" | "stop" {
            for (const value of [input, cacheRead, cacheWrite]) {
                if (!Number.isSafeInteger(value) || value < 0)
                    throw new Error("Invalid prompt usage");
            }
            spent += input + cacheRead + cacheWrite;
            if (spent >= budget) return "stop";
            if (!finalizeFired && spent >= budget * 0.8) {
                finalizeFired = true;
                return "finalize";
            }
            return "continue";
        },
        refuseTool(): { message: string; hardStopped: boolean } | null {
            if (!finalizeFired) return null;
            refusedCalls += 1;
            return { message: TOKEN_BUDGET_TOOL_REFUSAL, hardStopped: snapshot().hardStopped };
        },
    };
}
