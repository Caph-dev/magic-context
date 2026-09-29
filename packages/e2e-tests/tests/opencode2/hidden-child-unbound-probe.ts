import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { activeHostLimitationCodes } from "../../../plugin/src/shared/host-limitations";
import {
    createV2HiddenCompletionExecutor,
    hiddenChildrenMetaKey,
} from "../../../plugin/src/v2/hidden-completion";
import {
    HiddenChildHook,
    registerHiddenChildAgents,
} from "../../../plugin/src/v2/hooks/hidden-child";
import {
    type HostServiceOwner,
    hostServiceOwner,
    removeHostSession,
} from "../../../plugin/src/v2/host-service";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";

/**
 * Retires a hidden child on a host that registered no background service, and reports what the
 * cleanup left behind. Everything here is the shipped code path: the executor resolves its own
 * owner binding and deletes through `removeHostSession`, exactly as `v2/hooks/context.ts` wires it.
 *
 * Retirement is driven by the host-generation change rather than by a failed prompt, so the case
 * under test needs no provider behaviour at all: a child created under one generation is retired
 * the moment an executor of a newer generation opens.
 */
export default {
    id: "mc-hidden-child-unbound-proof",
    async setup(context: any) {
        const directory = context.location.directory;
        const db = openDatabase();
        if (!db) throw new Error("Hidden-child unbound proof database did not open");
        const hook = new HiddenChildHook();
        await registerHiddenChildAgents(context.agent);
        await context.session.hook("context", async (draft: any) => {
            hook.apply(draft);
        });
        let agentsReady: Promise<void> | undefined;
        const executorFor = (generation: string) =>
            createV2HiddenCompletionExecutor(
                {
                    ...context.session,
                    remove: (input: { sessionID: string; owner?: HostServiceOwner }) =>
                        removeHostSession(input.sessionID, input.owner),
                },
                {
                    db,
                    projectIdentity: directory,
                    directory,
                    hook,
                    ensureAgent: () => (agentsReady ??= context.agent.reload()),
                    openReader: () =>
                        new V2StoreReader(
                            gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
                        ),
                    generation,
                    removalSpacingMs: 50,
                },
            );

        const identity = {
            agent: "historian",
            kind: "historian",
            system: "UNBOUND_HISTORIAN_SYSTEM",
            model: "openai/mock-model",
            configuredModels: ["openai/mock-model"],
            timeoutMs: 10_000,
            title: "ignored shared title",
            directory,
        };

        const readRetired = () => {
            const row = db
                .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                .get(hiddenChildrenMetaKey(directory)) as { value: string } | undefined;
            const meta = JSON.parse(row?.value ?? '{"retired_children":[]}') as {
                retired_children: Array<{ id: string; owner?: HostServiceOwner }>;
            };
            return meta.retired_children;
        };

        writeFileSync(join(directory, "hidden-child-unbound-ready"), "ready\n");

        void (async () => {
            const commandPath = join(directory, "hidden-child-unbound-command");
            for (;;) {
                if (!existsSync(commandPath)) {
                    await Bun.sleep(20);
                    continue;
                }
                unlinkSync(commandPath);
                const first = await executorFor("unbound-generation-1");
                const created = await first.open(identity as any);
                await first.close(created, {
                    promptSettled: true,
                    privacySensitive: false,
                    context: "unbound-proof",
                    log() {},
                } as any);

                // A newer host generation retires the child created above and queues its deletion.
                const second = await executorFor("unbound-generation-2");
                const replacement = await second.open(identity as any);
                await second.close(replacement, {
                    promptSettled: true,
                    privacySensitive: false,
                    context: "unbound-proof",
                    log() {},
                } as any);

                // Let the queued removal attempt run before reporting what it left behind.
                await Bun.sleep(1000);
                writeFileSync(
                    join(directory, "hidden-child-unbound-result.json"),
                    JSON.stringify({
                        retiredChildID: created.id,
                        replacementChildID: replacement.id,
                        owner: hostServiceOwner() ?? null,
                        retired: readRetired().map((child) => ({
                            id: child.id,
                            owner: child.owner ?? null,
                        })),
                        limitations: activeHostLimitationCodes(),
                    }),
                );
            }
        })();
    },
};
