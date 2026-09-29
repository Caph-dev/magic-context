import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pins from "../../src/opencode2-runner/sha256-pins.json";

test("v1_untouched and captured fixture bytes remain sha256 pinned", () => {
	const root = resolve(import.meta.dir, "../../../..");
	for (const [path, expected] of Object.entries(pins)) {
		let bytes = readFileSync(resolve(root, path), "utf8");
		if (path === "packages/plugin/src/index.ts") {
			// The dual-loader composition is additive. Keep the original whole
			// v1 entry golden after removing only those three exact additions.
			// The updated v1 entry records tool parameters when refusing input
			// that was dropped; the v2 loader does not add this behavior.
			// The pin was re-minted again when the v1 `chat.message` hook began
			// measuring tool definitions under the "default" agent key when
			// OpenCode 1 omits the agent (6a7158a407, "preserve LKG after host
			// adds empty summaries"); that is a deliberate v1 change, not v2 leakage.
			// It was re-minted once more when the v1 `config` hook began turning
			// off OpenCode 1's automatic compaction while Magic Context manages
			// compaction (8487f845c5, "keep the final step's usage and stop native
			// auto-compaction under Magic Context"); also a deliberate v1 change.
			// It was re-minted again when the v1 entry began applying the historian
			// and dreamer output caps sampled for each child run (7e00707c55,
			// "reload historian and dreamer output caps per child run"); also v1.
			// It was re-minted again when the v1 entry began telling the user and
			// aborting the turn when busy storage refuses a pass instead of serving
			// it raw (38a6a6cd12, "refuse unmanaged prompts on storage contention
			// and Rust outages"); also a deliberate v1 change.
			// It was re-minted again when the v1 entry's session-project backfill
			// took a lease key and the home-project setting, so sessions whose rows
			// an earlier pass missed are discovered once; also v1.
			// It was re-minted again when the v1 entry began backfilling each
			// session's latest message time so retrospective picks sessions by
			// their own activity (7340ca7d11, "gate retrospective on per-session
			// activity"); also v1.
			// It was re-minted again when the v1 entry began applying the configured
			// `allow_home_project` setting at startup, so every project-identity caller
			// honours it (86a598a3a5, "honor home project permission across identity
			// callers"); also v1.
			bytes = bytes
				.replace('import { setup } from "./v2/server";\n', "")
				.replace("PluginModule & { setup: typeof setup }", "PluginModule")
				.replace("    server,\n    setup,", "    server,");
		}
		expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(
			expected,
		);
	}
});
