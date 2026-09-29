import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "../shared/data-path";
import { Database } from "../shared/sqlite";
import { gaDatabasePath } from "./store-reader";

/**
 * Reaching the OpenCode 2 host's own HTTP API from inside a plugin.
 *
 * The plugin surface a v2 host hands us carries no client and no address, but a host running in
 * service mode registers itself in a file that is the whole discovery contract: a base URL, the
 * password for basic auth, and the process id of the host that wrote it. Everything here is plain
 * `fetch` and `node:fs` on purpose — the OpenCode client package stays a development dependency and
 * must not be imported at runtime.
 *
 * Registrations are channel-scoped, and a channel is also what picks the host's session database,
 * so two registrations on one machine can belong to two completely separate stores. Discovery
 * therefore never picks "whichever registration exists": it picks the registration written by THIS
 * process, matched on process id, which is the one host whose store contains the sessions this
 * plugin instance created. A plain `opencode serve` and a `--standalone` host write no registration
 * at all, so discovery legitimately comes up empty; every caller treats that as "not now" rather
 * than an error.
 *
 * Bytes this follows, identical in `@opencode/cli` 2.0.5 and 2.0.11:
 *   - filename: `service.json` on the `latest`/`dev`/`beta`/`next` channels, otherwise
 *     `service-<channel>.json` with everything outside `[A-Za-z0-9._-]` replaced by `-`;
 *   - directory: `$XDG_STATE_HOME/opencode` (`~/.local/state/opencode` with no XDG override);
 *   - contents: `{ id, version, url, pid, password }`, where `pid` is the serving process's own
 *     `process.pid` and `id` is that service's identifier. The host re-reads this file and shuts
 *     itself down when the id/pid/url/password it observes are no longer its own, so a live
 *     registration always describes the process that currently owns the endpoint.
 */

/** Channels whose registration keeps the unsuffixed default filename. */
const DEFAULT_CHANNELS = ["latest", "dev", "beta", "next"];

/** The channel this plugin's host is running on; matches the host's own default. */
export function serviceChannel(env: NodeJS.ProcessEnv = process.env): string {
    return env.OPENCODE_CHANNEL && env.OPENCODE_CHANNEL.length > 0
        ? env.OPENCODE_CHANNEL
        : "latest";
}

/** Registration filename for one channel, following OpenCode 2's own naming rule. */
export function serviceRegistrationFilename(channel: string): string {
    if (DEFAULT_CHANNELS.includes(channel)) return "service.json";
    return `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
}

/** Directory the host writes every channel's registration into. */
export function serviceRegistrationDirectory(env: NodeJS.ProcessEnv = process.env): string {
    const state = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(state, "opencode");
}

/** Registration path for this environment's channel. */
export function serviceRegistrationPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(
        serviceRegistrationDirectory(env),
        serviceRegistrationFilename(serviceChannel(env)),
    );
}

export interface HostService {
    /** Absolute path of the registration file this was read from. */
    readonly path: string;
    /** Base URL with no trailing slash. */
    readonly url: string;
    readonly headers: Record<string, string>;
    /** Process id of the host that wrote the registration. */
    readonly pid: number;
    /** Service identifier from the registration, when it carries one. */
    readonly serviceID?: string;
}

/**
 * The binding persisted alongside a hidden child so its cleanup can find the same host again after
 * a restart. The registration path is the durable part: it names the channel, and the channel names
 * the store the child's session lives in. The service id and pid describe the process that created
 * the child and are kept for diagnosis, not as a gate — a restarted host on the same channel is
 * still the owner of the same sessions.
 */
export interface HostServiceOwner {
    readonly registration: string;
    readonly serviceID?: string;
    readonly pid: number;
}

/** A cleanup that cannot be attempted right now and must be retried later. */
export class HostServiceUnavailable extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostServiceUnavailable";
    }
}

function parseRegistration(path: string): HostService | undefined {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    let info: { url?: unknown; password?: unknown; pid?: unknown; id?: unknown };
    try {
        info = JSON.parse(text) as typeof info;
    } catch {
        return undefined;
    }
    if (typeof info.url !== "string" || info.url.length === 0) return undefined;
    // The host always writes its own pid. A registration without one is not a
    // shape this adapter knows how to bind ownership to.
    if (typeof info.pid !== "number" || !Number.isFinite(info.pid)) return undefined;
    return {
        path,
        url: info.url.replace(/\/+$/, ""),
        pid: info.pid,
        ...(typeof info.id === "string" && info.id.length > 0 ? { serviceID: info.id } : {}),
        headers:
            typeof info.password === "string" && info.password.length > 0
                ? {
                      authorization: `Basic ${Buffer.from(`opencode:${info.password}`, "utf8").toString("base64")}`,
                  }
                : {},
    };
}

/** Every readable registration in the state directory, whichever channel wrote it. */
export function readServiceRegistrations(env: NodeJS.ProcessEnv = process.env): HostService[] {
    const directory = serviceRegistrationDirectory(env);
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch {
        return [];
    }
    return names
        .filter((name) => name === "service.json" || /^service-.+\.json$/.test(name))
        .sort()
        .flatMap((name) => parseRegistration(join(directory, name)) ?? []);
}

/**
 * The registration written by the process this plugin is loaded in, or undefined when the host
 * registered nothing (a plain `opencode serve`, or a `--standalone` host).
 *
 * Matching on process id rather than on the channel's expected filename means a host whose channel
 * we guessed wrong, or one running on a channel we have never heard of, is still recognised — and,
 * more importantly, an unrelated service belonging to a different store never is.
 */
export function discoverOwnHostService(
    env: NodeJS.ProcessEnv = process.env,
    pid: number = process.pid,
): HostService | undefined {
    return readServiceRegistrations(env).find((service) => service.pid === pid);
}

/** The owner binding to persist with a hidden child created by this process. */
export function hostServiceOwner(
    env: NodeJS.ProcessEnv = process.env,
    pid: number = process.pid,
): HostServiceOwner | undefined {
    const service = discoverOwnHostService(env, pid);
    if (!service) return undefined;
    return {
        registration: service.path,
        ...(service.serviceID === undefined ? {} : { serviceID: service.serviceID }),
        pid: service.pid,
    };
}

/**
 * Resolve the host to delete an owned session through, or explain why there is none.
 *
 * The only acceptable route is the registration this process itself wrote AND that the child
 * recorded when it was created. Any other live service is a different endpoint — very possibly a
 * different channel's store — where the session was never created, so its 404 would mean "I never
 * had it", not "it is gone".
 */
export function resolveOwnerHostService(
    owner: HostServiceOwner | undefined,
    env: NodeJS.ProcessEnv = process.env,
    pid: number = process.pid,
): HostService {
    if (!owner) {
        throw new HostServiceUnavailable(
            "This session was created by an OpenCode host that registered no service, so there is no owner-bound route to delete it through",
        );
    }
    const own = discoverOwnHostService(env, pid);
    if (!own) {
        throw new HostServiceUnavailable(
            "This OpenCode host registered no service, so the owning host cannot be reached to delete the session",
        );
    }
    if (own.path !== owner.registration) {
        throw new HostServiceUnavailable(
            `This OpenCode host is registered at ${own.path}, not at the session's owner ${owner.registration}; refusing to delete through a service that never created it`,
        );
    }
    return own;
}

/**
 * Deletes a session through the host that created it, which interrupts whatever it is doing, waits
 * for it to go idle, removes its children, and publishes the deletion so the rest of the host keeps
 * up. This is the same route the OpenCode client's session removal calls, so it inherits all of
 * that.
 */
export function lookupHiddenChildDirectory(
    sessionID: string,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const path = gaDatabasePath(getDataDirFromEnv(env), serviceChannel(env), env);
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const row = db
            .prepare("SELECT directory, metadata FROM session_v2 WHERE id = ?")
            .get(sessionID) as { directory: string; metadata: string | null } | undefined;
        if (!row) return null;
        let metadata: unknown;
        try {
            metadata = row.metadata ? JSON.parse(row.metadata) : null;
        } catch {
            throw new Error(`OpenCode hidden child ${sessionID} has invalid session metadata`);
        }
        if ((metadata as { magic_context?: unknown } | null)?.magic_context !== "hidden-run") {
            throw new Error(`OpenCode session ${sessionID} is not marked as a hidden child`);
        }
        if (typeof row.directory !== "string" || !row.directory) {
            throw new Error(`OpenCode hidden child ${sessionID} has no session directory`);
        }
        return row.directory;
    } finally {
        db.close();
    }
}

function getDataDirFromEnv(env: NodeJS.ProcessEnv): string {
    return env.XDG_DATA_HOME ?? getDataDir();
}

export async function removeHostSession(
    sessionID: string,
    owner: HostServiceOwner | undefined,
    env: NodeJS.ProcessEnv = process.env,
    fetchSession: typeof fetch = fetch,
    directory?: string,
    lookupDirectory: (
        sessionID: string,
        env: NodeJS.ProcessEnv,
    ) => string | null = lookupHiddenChildDirectory,
): Promise<void> {
    const service = resolveOwnerHostService(owner, env);
    if (directory === undefined) {
        if (service.path !== serviceRegistrationPath(env)) {
            throw new Error(
                `Cannot resolve legacy hidden child ${sessionID} in an unverified host channel`,
            );
        }
        directory = lookupDirectory(sessionID, env) ?? undefined;
        if (directory === undefined) return;
    }
    const query = `?directory=${encodeURIComponent(directory)}`;
    const response = await fetchSession(
        `${service.url}/api/session/${encodeURIComponent(sessionID)}${query}`,
        {
            method: "DELETE",
            headers: service.headers,
            signal: AbortSignal.timeout(60_000),
        },
    );
    // The directory was recorded at creation or verified against the host's session row.
    // A 404 from that scope means another process already removed the child.
    if (!response.ok && response.status !== 404) {
        throw new Error(`OpenCode session delete answered ${response.status}`);
    }
}
