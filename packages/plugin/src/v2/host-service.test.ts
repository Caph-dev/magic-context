import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    discoverOwnHostService,
    type HostServiceOwner,
    HostServiceUnavailable,
    hostServiceOwner,
    readServiceRegistrations,
    removeHostSession,
    resolveOwnerHostService,
    serviceRegistrationFilename,
    serviceRegistrationPath,
} from "./host-service";

interface Registration {
    channel?: string;
    id?: string;
    url: string;
    pid: number;
    password?: string;
}

/**
 * A throwaway `$XDG_STATE_HOME` carrying whichever channel registrations a case needs. `channel`
 * selects the filename the real host would have written for that channel.
 */
function stateHome(registrations: Array<Registration | string> = []): {
    env: NodeJS.ProcessEnv;
    dir: string;
    cleanup: () => void;
} {
    const root = mkdtempSync(join(tmpdir(), "mc-host-service-"));
    const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
    const dir = join(root, "opencode");
    mkdirSync(dir, { recursive: true });
    for (const registration of registrations) {
        if (typeof registration === "string") {
            writeFileSync(join(dir, "service.json"), registration);
            continue;
        }
        const { channel, ...body } = registration;
        writeFileSync(
            join(dir, serviceRegistrationFilename(channel ?? "latest")),
            JSON.stringify(body),
        );
    }
    return { env, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface Seen {
    method: string;
    path: string;
    authorization: string | null;
}

async function withStub(
    status: number,
    body: (url: string, fetchSession: typeof fetch) => Promise<void>,
): Promise<Seen[]> {
    const seen: Seen[] = [];
    const handle = (request: Request) => {
        const url = new URL(request.url);
        seen.push({
            method: request.method,
            path: url.pathname + url.search,
            authorization: request.headers.get("authorization"),
        });
        return new Response(null, { status });
    };
    const server = Bun.serve({ port: 0, fetch: handle });
    try {
        await body(`http://127.0.0.1:${server.port}`, ((input, init) =>
            Promise.resolve(handle(new Request(input, init)))) as typeof fetch);
    } finally {
        server.stop(true);
    }
    return seen;
}

describe("OpenCode 2 service registration naming", () => {
    test("uses the unsuffixed file on the channels the host leaves unsuffixed", () => {
        for (const channel of ["latest", "dev", "beta", "next"]) {
            expect(serviceRegistrationFilename(channel)).toBe("service.json");
        }
    });

    test("uses a channel-scoped file on every other channel, sanitised like the host does", () => {
        expect(serviceRegistrationFilename("local")).toBe("service-local.json");
        expect(serviceRegistrationFilename("pr-42")).toBe("service-pr-42.json");
        expect(serviceRegistrationFilename("feature/x")).toBe("service-feature-x.json");
    });

    test("resolves this environment's channel path under the state directory", () => {
        const { env, dir, cleanup } = stateHome();
        try {
            expect(serviceRegistrationPath({ ...env, OPENCODE_CHANNEL: "local" })).toBe(
                join(dir, "service-local.json"),
            );
            expect(serviceRegistrationPath(env)).toBe(join(dir, "service.json"));
        } finally {
            cleanup();
        }
    });
});

describe("OpenCode 2 host service discovery", () => {
    test("reports nothing when no service registered itself", () => {
        const { env, cleanup } = stateHome();
        try {
            expect(readServiceRegistrations(env)).toEqual([]);
            expect(discoverOwnHostService(env, 4242)).toBeUndefined();
            expect(hostServiceOwner(env, 4242)).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    test("ignores a registration that is unreadable, has no url, or names no process", () => {
        for (const registration of [
            "{ not json",
            JSON.stringify({}),
            JSON.stringify({ url: "", pid: 1 }),
            JSON.stringify({ password: "secret", pid: 1 }),
            JSON.stringify({ url: "http://127.0.0.1:4096" }),
        ]) {
            const { env, cleanup } = stateHome([registration]);
            try {
                expect(readServiceRegistrations(env)).toEqual([]);
            } finally {
                cleanup();
            }
        }
    });

    test("reads every channel's registration, not only the default one", () => {
        const { env, dir, cleanup } = stateHome([
            { channel: "latest", id: "default", url: "http://127.0.0.1:1111", pid: 11 },
            { channel: "local", id: "local", url: "http://127.0.0.1:2222", pid: 22 },
        ]);
        try {
            expect(readServiceRegistrations(env).map((service) => service.path)).toEqual([
                join(dir, "service-local.json"),
                join(dir, "service.json"),
            ]);
        } finally {
            cleanup();
        }
    });

    test("picks the registration written by this very process, not the default one", () => {
        const { env, dir, cleanup } = stateHome([
            { channel: "latest", id: "unrelated-default", url: "http://127.0.0.1:1111", pid: 11 },
            { channel: "local", id: "ours", url: "http://127.0.0.1:2222/", pid: 22 },
        ]);
        try {
            expect(discoverOwnHostService(env, 22)).toEqual({
                path: join(dir, "service-local.json"),
                url: "http://127.0.0.1:2222",
                pid: 22,
                serviceID: "ours",
                headers: {},
            });
            expect(hostServiceOwner(env, 22)).toEqual({
                registration: join(dir, "service-local.json"),
                serviceID: "ours",
                pid: 22,
            });
        } finally {
            cleanup();
        }
    });

    test("turns a registration into a base url and basic auth for the opencode user", () => {
        const { env, cleanup } = stateHome([
            {
                id: "service-1",
                url: "http://127.0.0.1:4096/",
                pid: 42,
                password: "s3cret",
            },
        ]);
        try {
            expect(discoverOwnHostService(env, 42)?.headers).toEqual({
                authorization: `Basic ${Buffer.from("opencode:s3cret", "utf8").toString("base64")}`,
            });
        } finally {
            cleanup();
        }
    });

    test("an unauthenticated service registration sends no authorization header", () => {
        const { env, cleanup } = stateHome([{ url: "http://127.0.0.1:4096", pid: 42 }]);
        try {
            expect(discoverOwnHostService(env, 42)?.headers).toEqual({});
        } finally {
            cleanup();
        }
    });
});

describe("OpenCode 2 owner-bound route resolution", () => {
    test("refuses when the child was created by a host that registered nothing", () => {
        const { env, dir, cleanup } = stateHome([
            { channel: "latest", url: "http://127.0.0.1:1111", pid: 11 },
        ]);
        try {
            expect(() => resolveOwnerHostService(undefined, env, 11)).toThrow(
                HostServiceUnavailable,
            );
            // The default registration is right there and is still not used.
            expect(readServiceRegistrations(env).map((service) => service.path)).toEqual([
                join(dir, "service.json"),
            ]);
        } finally {
            cleanup();
        }
    });

    test("refuses a live default service when the owner is another channel's registration", () => {
        const { env, dir, cleanup } = stateHome([
            { channel: "latest", id: "unrelated-default", url: "http://127.0.0.1:1111", pid: 11 },
            { channel: "local", id: "ours", url: "http://127.0.0.1:2222", pid: 22 },
        ]);
        const owner: HostServiceOwner = {
            registration: join(dir, "service-local.json"),
            serviceID: "ours",
            pid: 22,
        };
        try {
            // This process IS the default service; the child belongs to the local one.
            expect(() => resolveOwnerHostService(owner, env, 11)).toThrow(HostServiceUnavailable);
        } finally {
            cleanup();
        }
    });

    test("accepts the owner's registration after a restart gave the host a new pid", () => {
        const { env, dir, cleanup } = stateHome([
            { channel: "local", id: "restarted", url: "http://127.0.0.1:3333", pid: 99 },
        ]);
        const owner: HostServiceOwner = {
            registration: join(dir, "service-local.json"),
            serviceID: "before-restart",
            pid: 22,
        };
        try {
            expect(resolveOwnerHostService(owner, env, 99).url).toBe("http://127.0.0.1:3333");
        } finally {
            cleanup();
        }
    });
});

describe("OpenCode 2 host session removal", () => {
    test("deletes through the owner's route with that registration's credentials", async () => {
        const seen = await withStub(204, async (url, fetchSession) => {
            const { env, dir, cleanup } = stateHome([
                { channel: "local", id: "ours", url, pid: process.pid, password: "s3cret" },
            ]);
            try {
                await removeHostSession(
                    "ses_abc/1",
                    {
                        registration: join(dir, "service-local.json"),
                        serviceID: "ours",
                        pid: process.pid,
                    },
                    env,
                    fetchSession,
                    "C:\\worktrees\\child project",
                );
            } finally {
                cleanup();
            }
        });
        expect(seen).toEqual([
            {
                method: "DELETE",
                path: "/api/session/ses_abc%2F1?directory=C%3A%5Cworktrees%5Cchild%20project",
                authorization: `Basic ${Buffer.from("opencode:s3cret", "utf8").toString("base64")}`,
            },
        ]);
    });

    test("reports a directory-scoped 404 instead of forgetting a possibly live child", async () => {
        await withStub(404, async (url, fetchSession) => {
            const { env, dir, cleanup } = stateHome([{ channel: "latest", url, pid: process.pid }]);
            try {
                await expect(
                    removeHostSession(
                        "ses_gone",
                        { registration: join(dir, "service.json"), pid: process.pid },
                        env,
                        fetchSession,
                    ),
                ).rejects.toThrow("404");
            } finally {
                cleanup();
            }
        });
    });

    test("reports a refusal so the caller can leave the entry for a later sweep", async () => {
        await withStub(401, async (url, fetchSession) => {
            const { env, dir, cleanup } = stateHome([{ channel: "latest", url, pid: process.pid }]);
            try {
                await expect(
                    removeHostSession(
                        "ses_abc",
                        { registration: join(dir, "service.json"), pid: process.pid },
                        env,
                        fetchSession,
                    ),
                ).rejects.toThrow("401");
            } finally {
                cleanup();
            }
        });
    });

    test("never issues a request when only an unrelated service is registered", async () => {
        const seen = await withStub(404, async (url, fetchSession) => {
            const { env, dir, cleanup } = stateHome([
                // The default channel's service is live and this process owns it...
                { channel: "latest", id: "unrelated-default", url, pid: process.pid },
            ]);
            try {
                // ...but the child was created by the local-channel host, whose store is a
                // different database. A 404 from the default service proves nothing.
                await expect(
                    removeHostSession(
                        "ses_abc",
                        { registration: join(dir, "service-local.json"), pid: 4242 },
                        env,
                        fetchSession,
                    ),
                ).rejects.toThrow(HostServiceUnavailable);
            } finally {
                cleanup();
            }
        });
        expect(seen).toEqual([]);
    });

    test("reports that no service is registered rather than silently doing nothing", async () => {
        const { env, cleanup } = stateHome();
        try {
            await expect(
                removeHostSession(
                    "ses_abc",
                    { registration: join(env.XDG_STATE_HOME!, "opencode", "service.json"), pid: 1 },
                    env,
                ),
            ).rejects.toThrow(HostServiceUnavailable);
        } finally {
            cleanup();
        }
    });
});
