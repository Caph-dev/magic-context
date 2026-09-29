import {
    DREAMER_AGENT,
    DREAMER_DOCS_AGENT,
    DREAMER_MEMORY_MAPPER_AGENT,
    DREAMER_PRIMER_INVESTIGATOR_AGENT,
    DREAMER_RETROSPECTIVE_AGENT,
} from "../../agents/dreamer";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../../hooks/magic-context/compartment-runner-types";
import { stripWellFormedLeadingTagPrefix } from "../../hooks/magic-context/tag-content-primitives";
import type { PromptArgs } from "../../shared/model-suggestion-retry";
import type { SessionContext, V2AgentDomain } from "./types";

export const HIDDEN_HISTORIAN_AGENT = "historian";
export const HIDDEN_DREAMER_AGENT = "dreamer-classifier";
export const HIDDEN_CURATE_AGENT = DREAMER_AGENT;

const READ_TOOLS = ["read", "grep", "glob"] as const;
const AGENT_TOOLS: Record<string, readonly string[]> = {
    [HIDDEN_HISTORIAN_AGENT]: [],
    [HIDDEN_DREAMER_AGENT]: [],
    [HIDDEN_CURATE_AGENT]: ["ctx_memory"],
    [DREAMER_MEMORY_MAPPER_AGENT]: READ_TOOLS,
    [DREAMER_PRIMER_INVESTIGATOR_AGENT]: [...READ_TOOLS, "ctx_search"],
    [DREAMER_RETROSPECTIVE_AGENT]: ["ctx_search"],
};
const AGENT_STEPS: Record<string, number> = {
    [HIDDEN_CURATE_AGENT]: 150,
    [DREAMER_MEMORY_MAPPER_AGENT]: 60,
    [DREAMER_DOCS_AGENT]: 60,
    [DREAMER_PRIMER_INVESTIGATOR_AGENT]: 40,
    [DREAMER_RETROSPECTIVE_AGENT]: 40,
};

export function hiddenAgentFor(identity: HiddenRunIdentity): string {
    if (identity.kind === "dreamer-task" && identity.agent === DREAMER_DOCS_AGENT)
        return DREAMER_MEMORY_MAPPER_AGENT;
    return identity.kind === "dreamer-task" && AGENT_TOOLS[identity.agent]
        ? identity.agent
        : identity.kind === "dreamer-task"
          ? HIDDEN_DREAMER_AGENT
          : HIDDEN_HISTORIAN_AGENT;
}

export function hiddenToolLoop(identity: HiddenRunIdentity): boolean {
    return identity.kind === "dreamer-task" && AGENT_STEPS[identity.agent] !== undefined;
}

export async function registerHiddenChildAgents(
    agent: Pick<V2AgentDomain, "transform">,
): Promise<void> {
    await agent.transform((editor) => {
        for (const id of Object.keys(AGENT_TOOLS)) {
            editor.update(id, (config) => {
                config.system = "Magic Context hidden completion carrier.";
                config.description = "Internal Magic Context hidden completion carrier.";
                config.mode = "primary";
                config.hidden = true;
                config.request.settings = {};
                config.request.headers = {};
                config.request.body = {};
                config.steps = AGENT_STEPS[id];
                // OpenCode 2.0.15's tool permission action is the tool id, not "tool".
                // See @opencode/schema/dist/permission.d.ts (Request.action/resources)
                // and the host's session request tool filtering; resource is "*".
                config.permissions = [
                    { action: "*", resource: "*", effect: "deny" },
                    ...(AGENT_TOOLS[id] ?? []).map((tool) => ({
                        action: tool,
                        resource: "*",
                        effect: "allow" as const,
                    })),
                ];
            });
        }
    });
}

export class HiddenAgentStepLimit extends Error {
    readonly agent: string;
    readonly cap: number;

    constructor(agent: string, cap: number) {
        super(`Hidden agent ${agent} exceeded its ${cap}-step limit`);
        this.name = "HiddenAgentStepLimit";
        this.agent = agent;
        this.cap = cap;
    }
}

export interface HiddenChildAttempt {
    childSessionId: string;
    identity: HiddenRunIdentity;
    request: PromptArgs;
    shaped: boolean;
    steps?: number;
    stepLimit?: HiddenAgentStepLimit;
    budgetExceeded?: Error;
    observedMessages?: SessionContext["messages"];
    marker?: string;
}

/** Last user text on a context draft. 2.0.5 may use a string body, extra parts, or input_text. */
export function newestUserText(draft: SessionContext): string | undefined {
    const message = draft.messages.at(-1);
    if (!message || (message.role !== undefined && message.role !== "user")) return undefined;
    const content: unknown = message.content;
    if (typeof content === "string" && content.length > 0) return content;
    const parts = Array.isArray(content)
        ? content
        : Array.isArray(message.parts)
          ? message.parts
          : [];
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const record = part as { type?: unknown; text?: unknown };
        if (typeof record.text !== "string" || record.text.length === 0) continue;
        if (record.type === undefined || record.type === "text" || record.type === "input_text") {
            return record.text;
        }
    }
    return undefined;
}

/**
 * Generation options for one hidden prompt, carrying only what the user asked
 * for. An output cap is sent under both of OpenCode's names for the same
 * budget: the public option is `maxOutputTokens`, while its GA
 * GenerationOptions carrier serializes the value from `maxTokens`.
 *
 * Nothing is sent by default. A fixed cap used to go out on every hidden
 * prompt, which made every run fail on backends that reject the parameter
 * outright — an OpenAI subscription login answers "Unsupported parameter:
 * max_output_tokens" — and the cap was never load-bearing here. Reserving room
 * for the producer's output is arithmetic done before the run (see
 * `producerInputTokenLimit`), and a producer that runs away is caught
 * afterwards by the length-capped output check.
 *
 * `identity.maxOutputTokens` and `request.body.temperature` are authored
 * values: absent means the user configured nothing, so neither may be filled
 * in with a fallback on the way here.
 */
function authoredOptions(attempt: HiddenChildAttempt): Record<string, number> {
    const cap = attempt.identity.maxOutputTokens;
    const temperature = attempt.request.body.temperature;
    return {
        ...(typeof cap === "number" && Number.isFinite(cap) && cap > 0
            ? { maxOutputTokens: cap, maxTokens: cap }
            : {}),
        ...(typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {}),
    };
}

function calibratedParts(attempt: HiddenChildAttempt): Array<{ type: "text"; text: string }> {
    const parts = attempt.request.body.parts;
    if (
        !Array.isArray(parts) ||
        parts.length === 0 ||
        parts.some(
            (part) =>
                !part ||
                typeof part !== "object" ||
                (part as { type?: unknown }).type !== "text" ||
                typeof (part as { text?: unknown }).text !== "string",
        )
    ) {
        throw new HiddenCompletionRefusal(
            "hidden_prompt_unrecognized",
            "Hidden completion accepts text-only calibrated prompts",
            true,
        );
    }
    return parts.map((part) => ({ type: "text", text: (part as { text: string }).text }));
}

/**
 * Owns the fail-closed bridge between a child prompt marker and the exact
 * calibrated request. Hidden children are visible root sessions in OpenCode 2,
 * so a user-selected or otherwise unregistered prompt must never inherit the
 * child's privileged internal identity.
 */
export class HiddenChildHook {
    private readonly childIDs = new Set<string>();
    private readonly attempts = new Map<string, HiddenChildAttempt>();
    private readonly active = new Map<string, HiddenChildAttempt>();

    registerChild(sessionID: string): void {
        this.childIDs.add(sessionID);
    }

    registerAttempt(marker: string, attempt: HiddenChildAttempt): void {
        this.registerChild(attempt.childSessionId);
        attempt.marker = marker;
        this.attempts.set(marker, attempt);
    }

    releaseAttempt(marker: string): void {
        const attempt = this.attempts.get(marker);
        this.attempts.delete(marker);
        if (attempt && this.active.get(attempt.childSessionId) === attempt) {
            this.active.delete(attempt.childSessionId);
        }
    }

    owns(sessionID: string): boolean {
        return this.childIDs.has(sessionID);
    }

    /** Returns false only for an ordinary user session that this bridge does not own. */
    apply(draft: SessionContext): boolean {
        if (!this.owns(draft.sessionID)) return false;

        const raw = newestUserText(draft);
        const stripped = raw === undefined ? undefined : stripWellFormedLeadingTagPrefix(raw);
        const attempt =
            (raw !== undefined ? this.attempts.get(raw) : undefined) ??
            (stripped && stripped !== raw ? this.attempts.get(stripped) : undefined);
        const current = this.active.get(draft.sessionID);
        const selected = attempt ?? current;
        if (
            !selected ||
            selected.childSessionId !== draft.sessionID ||
            (attempt && current && current !== attempt)
        ) {
            throw new HiddenCompletionRefusal(
                "hidden_prompt_unrecognized",
                "Refusing an unregistered prompt on a Magic Context hidden-run session",
                true,
            );
        }
        if (selected.request.signal?.aborted) {
            throw new Error("Hidden completion prompt aborted");
        }

        if (!selected.shaped) {
            if (!attempt)
                throw new HiddenCompletionRefusal(
                    "hidden_prompt_unrecognized",
                    "Hidden child first step requires a registered marker",
                    true,
                );
            this.active.set(draft.sessionID, selected);
        }
        const steps = (selected.steps ?? 0) + 1;
        const cap = AGENT_STEPS[selected.identity.agent];
        if (cap !== undefined && steps > cap) {
            selected.stepLimit = new HiddenAgentStepLimit(selected.identity.agent, cap);
            throw selected.stepLimit;
        }
        selected.steps = steps;
        const system =
            typeof selected.request.body.system === "string"
                ? selected.request.body.system
                : selected.identity.system;
        draft.system = [{ type: "text", text: system }];
        if (!selected.shaped) {
            draft.messages = [{ role: "user", content: calibratedParts(selected) }];
        } else {
            // A reused historian child still holds the rows of its earlier runs, so on a
            // later step of this run (for example the host retrying a provider error)
            // this run's marker is not the first message. This run starts at its own
            // marker: everything before it belongs to earlier runs and is dropped.
            let start = -1;
            draft.messages.forEach((message, index) => {
                const text = newestUserText({ ...draft, messages: [message] });
                if (text !== undefined && stripWellFormedLeadingTagPrefix(text) === selected.marker)
                    start = index;
            });
            const first = draft.messages[start];
            if (!first) {
                throw new HiddenCompletionRefusal(
                    "hidden_prompt_unrecognized",
                    "Hidden child history does not contain this run's registered marker",
                    true,
                );
            }
            // The host saves the placeholder user prompt rather than the calibrated
            // text sent on step one. Replace only that placeholder, preserving all
            // assistant tool calls and tool results after it.
            draft.messages = [
                { ...first, content: calibratedParts(selected) },
                ...draft.messages.slice(start + 1),
            ];
        }
        // Replaced wholesale, never merged: the carrier sends exactly the
        // authored options and never inherits the host's own generation defaults.
        draft.options = authoredOptions(selected);
        const allowed = AGENT_TOOLS[hiddenAgentFor(selected.identity)] ?? [];
        draft.tools = Object.fromEntries(
            allowed.flatMap((id) => (draft.tools[id] ? [[id, draft.tools[id]]] : [])),
        );
        selected.observedMessages = draft.messages;
        selected.shaped = true;
        return true;
    }
}
