import {
	detectOverflow,
	detectThinkingBindingMismatch,
	isPrefixBoundThinkingModel,
} from "@magic-context/core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	armThinkingBindingRecovery,
	getMergedReasoningStrippedIds,
	getThinkingBindingRecoveryTarget,
	recordOverflowDetected,
	THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
	THINKING_BINDING_STRIP_ORDER_END_MARKER,
	thinkingBindingRecoveryFrozenId,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { dropSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	commitServedPass,
	digestPiServedMessages,
	firstChangedServedIndex,
	getTrustedServedDigests,
	stageProactiveFreeze,
	stageServedArray,
	unpersistedFrozenEntries,
} from "@magic-context/core/hooks/magic-context/prefix-bound-thinking";
import { log } from "@magic-context/core/shared/logger";

import { clearPiLkgSessionState } from "./pi-lkg";

function reportBindingRecovery(
	sessionId: string,
	report: ((message: string) => void) | undefined,
	message: string,
): void {
	if (report) report(message);
	else log(`[magic-context][${sessionId}] ${message}`);
}

export type PiProviderFailureResult =
	| { kind: "none" }
	| { kind: "thinking_binding"; armed: boolean }
	| {
			kind: "overflow";
			reportedLimit?: number;
			reportedLimitProvenance?: string;
			matchedPattern?: string;
	  };

/** Persist recovery state from Pi's assistant `message_end` error payload. */
export function handlePiProviderFailure(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	compactionOff?: boolean;
	thinkingBindingRecoveryEnabled?: boolean;
	report?: (message: string) => void;
}): PiProviderFailureResult {
	if (!args.message || typeof args.message !== "object")
		return { kind: "none" };
	const message = args.message as {
		role?: unknown;
		errorMessage?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (
		message.role !== "assistant" ||
		typeof message.errorMessage !== "string" ||
		message.errorMessage.length === 0
	) {
		return { kind: "none" };
	}

	const provider =
		typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	const binding = detectThinkingBindingMismatch(message.errorMessage);
	if (binding.isBindingMismatch) {
		const enabled =
			args.thinkingBindingRecoveryEnabled !== false &&
			!args.compactionOff &&
			isPrefixBoundThinkingModel(provider, model);
		if (enabled) {
			// The 400 names only provider request-array paths. The next context
			// pass maps the flag onto stable branch entry ids and strips thinking
			// from every assistant that still carries it.
			armThinkingBindingRecovery(args.db, args.sessionId);
			clearPiLkgSessionState(args.sessionId);
			dropSlot(args.sessionId, "thinking-binding-recovery-arm");
			reportBindingRecovery(
				args.sessionId,
				args.report,
				`thinking-binding recovery armed from message_end (provider paths: failing=${binding.failingBlockPath ?? "?"} firstChanged=${binding.firstChangedPath ?? "?"})`,
			);
		}
		return { kind: "thinking_binding", armed: enabled };
	}

	if (args.compactionOff) return { kind: "none" };
	const overflow = detectOverflow(message.errorMessage);
	if (!overflow.isOverflow) return { kind: "none" };
	const modelKey = provider && model ? `${provider}/${model}` : undefined;
	recordOverflowDetected(
		args.db,
		args.sessionId,
		overflow.reportedLimit,
		modelKey,
		"provider_overflow",
		overflow.reportedLimitProvenance,
		overflow.reportedInputTokens,
	);
	return {
		kind: "overflow",
		...(overflow.reportedLimit !== undefined
			? { reportedLimit: overflow.reportedLimit }
			: {}),
		...(overflow.reportedLimitProvenance !== undefined
			? { reportedLimitProvenance: overflow.reportedLimitProvenance }
			: {}),
		...(overflow.matchedPattern !== undefined
			? { matchedPattern: overflow.matchedPattern }
			: {}),
	};
}

interface PiThinkingPart {
	type?: unknown;
}

interface PiAssistantMessage {
	role?: unknown;
	content?: unknown;
}

function hasThinkingPart(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const assistant = message as PiAssistantMessage;
	return (
		assistant.role === "assistant" &&
		Array.isArray(assistant.content) &&
		assistant.content.some((part) => {
			if (!part || typeof part !== "object") return false;
			const type = (part as PiThinkingPart).type;
			return (
				type === "thinking" ||
				type === "redactedThinking" ||
				type === "redacted_thinking"
			);
		})
	);
}

function stripThinkingParts(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const assistant = message as PiAssistantMessage;
	const content = assistant.content;
	if (assistant.role !== "assistant" || !Array.isArray(content)) return 0;
	const before = content.length;
	const strippedContent = content.filter((part) => {
		if (!part || typeof part !== "object") return true;
		const type = (part as PiThinkingPart).type;
		return (
			type !== "thinking" &&
			type !== "redactedThinking" &&
			type !== "redacted_thinking"
		);
	});
	assistant.content = strippedContent;
	return before - strippedContent.length;
}

export interface PiThinkingBindingApplication {
	/** The flag value read, so the caller clears only that value. */
	flagTarget: string;
	/** Every branch entry whose thinking this pass removes. */
	entryIds: string[];
}

/**
 * Apply an armed thinking-binding recovery and replay earlier ones.
 *
 * An armed flag freezes every assistant entry that still carries thinking,
 * the newest one included even when its tool call waits on a pending tool
 * result: after a prefix edit all of those blocks are invalid, and removing
 * all of them is always valid, so one failed request is enough. The frozen
 * set is persisted before bytes change and replays on every later pass, so a
 * removed block never comes back; blocks produced afterwards are kept.
 */
export function applyPiThinkingBindingRecovery(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	report?: (message: string) => void;
	/**
	 * The session strips thinking after the pipeline stages ran (see
	 * resolvePiBindingStripOrder). New entries are then written together with
	 * THINKING_BINDING_STRIP_ORDER_END_MARKER, so later passes keep stripping
	 * after the stages instead of reverting to stripping before them.
	 */
	endOfPassOrder?: boolean;
}): PiThinkingBindingApplication | null {
	if (args.provider?.toLowerCase() !== "anthropic") return null;
	const frozenEntryIds = frozenBindingEntryIds(args.db, args.sessionId);

	const flagTarget = isPrefixBoundThinkingModel(args.provider, args.model)
		? getThinkingBindingRecoveryTarget(args.db, args.sessionId)
		: null;
	let applied: PiThinkingBindingApplication | null = null;
	if (flagTarget) {
		const entryIds = new Set<string>();
		for (let index = 0; index < args.messages.length; index += 1) {
			const entryId = args.entryIds[index];
			if (entryId && hasThinkingPart(args.messages[index]))
				entryIds.add(entryId);
		}
		const newEntryIds = [...entryIds].filter((id) => !frozenEntryIds.has(id));
		if (
			newEntryIds.length === 0 ||
			addMergedReasoningStrippedIds(args.db, args.sessionId, [
				...newEntryIds.map(thinkingBindingRecoveryFrozenId),
				...(args.endOfPassOrder
					? [THINKING_BINDING_STRIP_ORDER_END_MARKER]
					: []),
			])
		) {
			for (const id of newEntryIds) frozenEntryIds.add(id);
			applied = { flagTarget, entryIds: [...entryIds] };
			reportBindingRecovery(
				args.sessionId,
				args.report,
				`thinking-binding recovery consumed on context pass target=${flagTarget} entries=${applied.entryIds.length} [${applied.entryIds.join(",")}]`,
			);
		}
	}

	for (let index = 0; index < args.messages.length; index += 1) {
		const entryId = args.entryIds[index];
		if (entryId && frozenEntryIds.has(entryId))
			stripThinkingParts(args.messages[index]);
	}
	return applied;
}

/** Thinking removed by a busting pass because the same pass changed bytes before it. */
export interface PiProactiveThinkingStrip {
	/** Index in the served array of the first message that differs from the previous serve. */
	firstChangedIndex: number;
	/** Branch entries whose thinking this pass freezes into the binding-mismatch set. */
	entryIds: string[];
}

/**
 * Remove thinking that this busting pass invalidated on a prefix-bound model
 * (Fable 5.1, Opus 5.5).
 *
 * `messages` is the final array this pass serves, after binding-mismatch strips
 * were replayed on it at the end of the pass. It is compared, message by
 * message, with the digests of the previous serve; nothing is stripped when
 * that serve is unknown or untrusted (another process or an unrecorded
 * fallback served since). Every assistant entry at or after the first
 * differing message that still carries thinking is stripped: after that change
 * the provider would drop or reject those blocks anyway. That includes the
 * newest assistant of an open tool round, whose tool call stays; a live probe
 * on Fable 5.1 and Opus 5.5 accepted that turn with its thinking removed
 * (docs/reports/anthropic-open-tool-round-thinking.md).
 *
 * The entries are staged and join the binding-mismatch set the reactive
 * recovery uses only when the pass commits its serve
 * (recordPiServedArrayForThinkingBinding), so a pass that fails after deciding
 * leaves the set unchanged. Later passes replay the set through
 * applyPiThinkingBindingRecovery at the same point of the pass, so they serve
 * identical bytes, and a removed block never comes back. Thinking produced
 * after this pass is kept until a later busting pass changes bytes before it.
 *
 * `cacheBustingPass` must be true only on a pass that already busts the cache;
 * a defer pass never originates a strip.
 */
export function applyPiProactiveThinkingStrip(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	cacheBustingPass: boolean;
	report?: (message: string) => void;
}): PiProactiveThinkingStrip | null {
	if (!args.cacheBustingPass) return null;
	if (!isPrefixBoundThinkingModel(args.provider, args.model)) return null;
	const previous = getTrustedServedDigests(args.db, args.sessionId);
	if (!previous) {
		reportBindingRecovery(
			args.sessionId,
			args.report,
			"proactive thinking strip: previous serve unknown to this process; binding recovery remains the fallback",
		);
		return null;
	}
	const firstChangedIndex = firstChangedServedIndex(
		previous,
		digestPiServedMessages(args.messages),
		args.messages.length,
	);
	if (firstChangedIndex < 0) return null;
	const entryIds: string[] = [];
	const indices: number[] = [];
	for (
		let index = firstChangedIndex;
		index < args.messages.length;
		index += 1
	) {
		const entryId = args.entryIds[index];
		// Without a stable entry id the strip could not be replayed on later
		// passes, so it is not started; binding recovery covers that block.
		if (!entryId || !hasThinkingPart(args.messages[index])) continue;
		entryIds.push(entryId);
		indices.push(index);
	}
	if (entryIds.length === 0) return null;
	// These entries are stripped only after the pipeline stages ran, so the
	// end-order marker is persisted with them; otherwise later passes could
	// revert to stripping before the stages and render differently.
	stageProactiveFreeze(args.db, args.sessionId, [
		...entryIds.map(thinkingBindingRecoveryFrozenId),
		THINKING_BINDING_STRIP_ORDER_END_MARKER,
	]);
	for (const index of indices) stripThinkingParts(args.messages[index]);
	reportBindingRecovery(
		args.sessionId,
		args.report,
		`proactive thinking strip: first changed served message ${firstChangedIndex}; stripping thinking of ${entryIds.length} entr${entryIds.length === 1 ? "y" : "ies"} [${entryIds.join(",")}]`,
	);
	return { firstChangedIndex, entryIds };
}

/**
 * Commit a served pass for prefix-bound models: record the served array the
 * next busting pass compares against, and persist the thinking this pass
 * stripped. Call only once the array is handed to Pi.
 */
export function recordPiServedArrayForThinkingBinding(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: readonly unknown[];
	provider?: string;
	model?: string;
}): void {
	if (!isPrefixBoundThinkingModel(args.provider, args.model)) {
		commitServedPass(args.sessionId);
		return;
	}
	stageServedArray(
		args.db,
		args.sessionId,
		digestPiServedMessages(args.messages),
	);
	commitServedPass(args.sessionId);
}

function frozenBindingEntryIds(
	db: ContextDatabase,
	sessionId: string,
): Set<string> {
	const ids = new Set<string>();
	const entries = [
		...getMergedReasoningStrippedIds(db, sessionId),
		// Served strips whose persistence failed replay exactly as persisted ones.
		...unpersistedFrozenEntries(sessionId),
	];
	for (const entry of entries) {
		if (!entry.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
		const entryId = entry.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
		if (entryId.length > 0) ids.add(entryId);
	}
	return ids;
}

/**
 * Where this pass replays the binding-mismatch strips.
 *
 * Builds before this one stripped at the start of the context pass, before any
 * stage ran, and a stage's output can depend on whether an assistant carries
 * thinking (a dropped tool arc beside native reasoning renders as a skeleton,
 * without it as a removal). A session that already carries strips therefore
 * keeps the start-of-pass order ("start") until a pass may change served bytes:
 * a pass with a queued explicit flush, which always holds the shared bust
 * permission, writes the end-order marker and switches. It also switches on any
 * pass where the order cannot matter (none of its stripped entries is on the
 * branch). A session without strips uses the end order from the start.
 *
 * The proactive strip runs only in the end order, because it is decided on the
 * array the pass serves and must replay at that same point.
 */
export function resolvePiBindingStripOrder(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: readonly unknown[];
	entryIds: readonly (string | undefined)[];
	/** Known before any stage runs: this pass is allowed to change served bytes. */
	bustPermittedAtStart: boolean;
}): "start" | "end" {
	const ledger = getMergedReasoningStrippedIds(args.db, args.sessionId);
	if (ledger.has(THINKING_BINDING_STRIP_ORDER_END_MARKER)) return "end";
	const frozen = frozenBindingEntryIds(args.db, args.sessionId);
	if (frozen.size === 0) return "end";
	let onBranch = false;
	let carriesThinking = false;
	for (let index = 0; index < args.messages.length; index += 1) {
		const entryId = args.entryIds[index];
		if (!entryId || !frozen.has(entryId)) continue;
		onBranch = true;
		if (hasThinkingPart(args.messages[index])) carriesThinking = true;
	}
	// With the stripped entries present but their thinking already gone, both
	// orders render alike this pass, and switching would only move the change
	// to a later pass; wait for a pass that renders the difference itself.
	const mayChangeOrder =
		!onBranch || (carriesThinking && args.bustPermittedAtStart);
	if (
		mayChangeOrder &&
		addMergedReasoningStrippedIds(args.db, args.sessionId, [
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		])
	) {
		return "end";
	}
	return "start";
}
