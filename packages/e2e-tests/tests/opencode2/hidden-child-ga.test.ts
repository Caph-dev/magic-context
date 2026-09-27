import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
    serviceRegistrationPath,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(20);
    }
}

function responseInputText(body: Record<string, unknown>): string[] {
    const input = body.input;
    if (!Array.isArray(input)) return [];
    return input.flatMap((message) => {
        if (!message || typeof message !== "object") return [];
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) =>
            part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? [(part as { text: string }).text]
                : [],
        );
    });
}

/** Reads the host's own store, so "gone" means the row is gone rather than merely hidden. */
function storedSession(path: string, sessionID: string): { exists: boolean; messages: number } {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const row = db.prepare("SELECT id FROM session_v2 WHERE id = ?").get(sessionID);
        return {
            exists: row !== null && row !== undefined,
            messages: (
                db
                    .prepare("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?")
                    .get(sessionID) as { count: number }
            ).count,
        };
    } finally {
        db.close();
    }
}

async function eventually(check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for host cleanup");
        await Bun.sleep(50);
    }
}

test("OpenCode 2 hidden historian retires a child after a provider error and deletes it", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "mc-hidden-child-ga-"));
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "hidden-child-ga-probe.ts")],
        outdir: bundleDir,
        naming: "index.js",
        target: "node",
        format: "esm",
        define: { "process.env.NODE_ENV": '"production"' },
        external: ["bun:sqlite", "node:sqlite"],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));

    const host = await spawnOpencode2({
        probePlugin: bundleDir,
        includeMagicContext: false,
        // Boot the way a user's seat boots, so the plugin can find the host the way it does in
        // production: through the service registration file rather than anything handed in here.
        serviceMode: true,
        defaultModelID: "mock-model-user",
        additionalModelIDs: ["mock-model-cheap"],
        modelContextLimit: 200_000,
        mockResponse: {
            text: "hidden completion",
            usage: { input_tokens: 101, output_tokens: 11 },
        },
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        // The discovery contract the plugin depends on: a registration naming this very host.
        const registration = JSON.parse(
            readFileSync(serviceRegistrationPath(host.env), "utf8"),
        ) as { url: string; password: string };
        expect(registration.url).toBe(host.url);
        expect(registration.password).toBe(host.password);
        await waitForPluginActive(client, host.cwd, "mc-hidden-child-ga-proof");
        await waitForFile(join(host.cwd, "hidden-child-ready"));
        const user = await client.session.create({
            title: "user session",
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model-user" },
        });

        const command = async (
            seq: number,
            options: { temperature?: number; maxOutputTokens?: number; generation?: string } = {},
        ) => {
            const resultPath = join(host.cwd, `hidden-child-result-${seq}.json`);
            writeFileSync(
                join(host.cwd, "hidden-child-command.json"),
                JSON.stringify({ seq, parentSessionID: user.id, ...options }),
            );
            await waitForFile(resultPath);
            return JSON.parse(readFileSync(resultPath, "utf8")) as {
                ok: boolean;
                childID: string;
                error?: string;
                completion?: { text: string; usage: Record<string, number> };
                pluginPid: number;
                owner: { registration: string; serviceID?: string; pid: number } | null;
            };
        };

        const first = await command(1, { temperature: 0.25 });
        expect(first.ok).toBe(true);
        // Ownership binding (issue 492 finding 5): the plugin runs inside the serving process, so
        // the registration naming that process id is the one host whose store holds this child.
        const fullRegistration = JSON.parse(
            readFileSync(serviceRegistrationPath(host.env), "utf8"),
        ) as { id?: string; pid: number };
        expect(first.pluginPid).toBe(fullRegistration.pid);
        expect(first.owner).toEqual({
            registration: serviceRegistrationPath(host.env),
            ...(fullRegistration.id === undefined ? {} : { serviceID: fullRegistration.id }),
            pid: fullRegistration.pid,
        });
        expect(first.completion).toMatchObject({
            text: "hidden completion",
            usage: { input: 101, output: 11 },
        });
        const firstWire = host.mock
            .requests()
            .find((request) => responseInputText(request.body).includes("EXACT_HISTORIAN_CHUNK_1"));
        expect(firstWire).toBeDefined();
        expect(firstWire?.body.model).toBe("mock-model-cheap");
        expect(firstWire?.body.instructions).toBe("EXACT_HISTORIAN_SYSTEM_1");
        expect(firstWire?.body.input).toEqual([
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "EXACT_HISTORIAN_CHUNK_1" }],
            },
        ]);
        expect(firstWire?.body.tools).toBeUndefined();
        expect(firstWire?.body.temperature).toBe(0.25);
        // No output cap was configured, so the carrier must leave the parameter
        // off entirely. A subscription-login backend rejects the request outright
        // when it is present ("Unsupported parameter: max_output_tokens").
        expect(firstWire?.body.max_output_tokens).toBeUndefined();
        expect((await client.session.get({ sessionID: first.childID })).title).toBe(
            "Magic Context historian",
        );

        const second = await command(2, { maxOutputTokens: 4096 });
        expect(second.ok).toBe(true);
        expect(second.childID).toBe(first.childID);
        const secondWire = host.mock
            .requests()
            .find((request) => responseInputText(request.body).includes("EXACT_HISTORIAN_CHUNK_2"));
        expect(secondWire).toBeDefined();
        // A configured cap reaches the wire unchanged, and an unconfigured
        // temperature stays off it.
        expect(secondWire?.body.max_output_tokens).toBe(4096);
        expect(secondWire?.body.temperature).toBeUndefined();
        const rootsAfterReuse = await client.session.list({
            directory: host.cwd,
            parentID: null,
        });
        const hiddenAfterReuse = rootsAfterReuse.data.filter(
            (session) => session.metadata?.magic_context === "hidden-run",
        );
        expect(hiddenAfterReuse.map((session) => session.id)).toEqual([first.childID]);
        const reader = new V2StoreReader(
            gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
        );
        try {
            expect(
                reader
                    .history(first.childID)
                    .filter(
                        (row) =>
                            row.type === "assistant" && row.data.error === undefined,
                    ),
            ).toHaveLength(2);
        } finally {
            reader.close();
        }

        host.mock.setDefault({
            error: {
                status: 400,
                type: "invalid_request_error",
                message: "forced hidden failure",
            },
        });
        const failed = await command(3);
        expect(failed.ok).toBe(false);
        expect(failed.childID).toBe(first.childID);
        // GA 2.0.5 persists only the terminal outcome; the provider's reason remains in its host log.
        expect(failed.error).toContain("outcome=failed");
        expect(failed.error).toContain("session_error=unavailable");

        const storePath = gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env);
        await eventually(() => !storedSession(storePath, first.childID).exists);

        host.mock.setDefault({
            text: "fresh child completion",
            usage: { input_tokens: 202, output_tokens: 22 },
        });
        const third = await command(4);
        expect(third.ok).toBe(true);
        // A provider failure quarantines the child before its marker is released. The next run
        // therefore gets a clean hidden session instead of allowing a late drain to touch it.
        expect(third.childID).not.toBe(first.childID);
        expect(third.completion?.usage).toMatchObject({ input: 202, output: 22 });
        const rootsAfterProviderError = await client.session.list({
            directory: host.cwd,
            parentID: null,
        });
        expect(
            rootsAfterProviderError.data
                .filter((session) => session.metadata?.magic_context === "hidden-run")
                .map((session) => session.id),
        ).toEqual([third.childID]);

        // A run arriving as if a newer host build had booted retires the previous generation's
        // child, which must take the child's session with it rather than leaving it behind.
        expect(storedSession(storePath, third.childID).exists).toBe(true);
        expect(storedSession(storePath, third.childID).messages).toBeGreaterThan(0);
        // An unrelated service registered on another channel must never be probed: its store is a
        // different database, so its 404 would mean "never had it" rather than "already gone"
        // (issue 492 finding 5). This decoy records every request it receives.
        const decoyRequests: string[] = [];
        const decoy = Bun.serve({
            port: 0,
            fetch(request) {
                decoyRequests.push(`${request.method} ${new URL(request.url).pathname}`);
                return new Response(null, { status: 404 });
            },
        });
        writeFileSync(
            join(host.env.XDG_STATE_HOME!, "opencode", "service-local.json"),
            JSON.stringify({
                id: "unrelated-local-channel-service",
                version: "2.0.5",
                url: `http://127.0.0.1:${decoy.port}`,
                // Another opencode instance, so another process id: this registration is never
                // the one this plugin's process wrote.
                pid: fullRegistration.pid + 100_000,
                password: "decoy",
            }),
        );

        const regenerated = await command(5, { generation: "ga-proof-generation-2" });
        expect(regenerated.ok).toBe(true);
        expect(regenerated.childID).not.toBe(third.childID);
        await eventually(() => !storedSession(storePath, third.childID).exists);
        decoy.stop(true);
        expect(decoyRequests).toEqual([]);
        // session_message cascades off the session row, so nothing is left orphaned behind it.
        expect(storedSession(storePath, third.childID).messages).toBe(0);
        const rootsAfterRetirement = await client.session.list({
            directory: host.cwd,
            parentID: null,
        });
        expect(
            rootsAfterRetirement.data
                .filter((session) => session.metadata?.magic_context === "hidden-run")
                .map((session) => session.id),
        ).toEqual([regenerated.childID]);

        const storedUser = await client.session.get({ sessionID: user.id });
        expect(storedUser.model).toMatchObject({
            providerID: "openai",
            id: "mock-model-user",
        });
        expect(storedUser.tokens).toMatchObject({ input: 0, output: 0 });
        expect(
            host.mock.requests().filter((request) => request.body.model === "mock-model-user"),
        ).toHaveLength(0);
    } catch (error) {
        console.error(host.stdout(), host.stderr(), JSON.stringify(host.mock.requests()));
        throw error;
    } finally {
        await host.stop();
        rmSync(bundleDir, { recursive: true, force: true });
    }
}, 120_000);
