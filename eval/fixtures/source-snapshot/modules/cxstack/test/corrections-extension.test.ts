import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CorrectionReviewTheme } from "../components/corrections-review.ts";
import registerCorrections, { selectFableModel } from "../extensions/corrections.ts";
import {
	correctionState,
	correctionsFile,
	readCorrectionEvents,
	type CorrectionCandidate,
	type CorrectionGroupingContext,
	type CorrectionPattern,
} from "../lib/corrections.ts";
import { CX_STATE_ENTRY } from "../lib/cx.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const readyPatterns = (candidates: CorrectionCandidate[]): CorrectionPattern[] => [{
	id: "pattern-test",
	title: "Unnecessary machinery",
	summary: "The agent proposed tooling without a current failure.",
	candidateIds: candidates.map(({ id }) => id),
	disposition: "ready",
	proof: {
		kind: "new_mechanical_eval",
		reason: "No existing routing case covers this behavior.",
	},
	eval: {
		input: "What should we improve next?",
		expectedBehavior: "Compare against doing nothing.",
		forbiddenBehavior: ["Propose machinery without a current failure"],
		rubric: [],
		models: ["openai", "fable"],
	},
	reason: "Strong durable correction.",
}];

function harness(
	group: (candidates: CorrectionCandidate[], ctx: ExtensionContext, signal: AbortSignal, context: CorrectionGroupingContext) => Promise<CorrectionPattern[]> = async (candidates) => readyPatterns(candidates),
	existingAgentDir?: string,
) {
	const agentDir = existingAgentDir ?? mkdtempSync(join(tmpdir(), "corrections-extension-"));
	if (!existingAgentDir) roots.push(agentDir);
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const notifications: string[] = [];
	const userMessages: string[] = [];
	const widgets: unknown[] = [];
	const customComponents: Component[] = [];
	const customOptions: Array<{ overlay?: boolean } | undefined> = [];
	const confirmations: string[] = [];
	const entries = [
		{ type: "custom", id: "cx", customType: CX_STATE_ENTRY, data: { active: true } },
		{ type: "message", id: "request", message: { role: "user", content: "What should we do next?" } },
		{ type: "message", id: "answer", message: { role: "assistant", content: [{ type: "text", text: "Use a sanitizer." }] } },
		{ type: "message", id: "correction", message: { role: "user", content: "That is unnecessary." } },
		{ type: "message", id: "logging", message: { role: "assistant", content: [] } },
	];
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		sendUserMessage(content: string) {
			userMessages.push(content);
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: agentDir,
		hasUI: true,
		mode: "tui",
		getSystemPrompt: () => "Compare proposed machinery against doing nothing.",
		modelRegistry: {} as never,
		scopedModels: [],
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => "session",
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setWidget(_key: string, value: unknown) {
				widgets.push(value);
			},
			confirm(title: string, message: string) {
				confirmations.push(`${title}\n${message}`);
				return Promise.resolve(true);
			},
			custom<Result>(
				factory: (
					tui: { requestRender(): void },
					theme: CorrectionReviewTheme,
					keybindings: { matches(data: string, binding: string): boolean },
					done: (result: Result) => void,
				) => Component,
				options?: { overlay?: boolean },
			) {
				customOptions.push(options);
				return new Promise<Result>((resolve) => {
					customComponents.push(factory(
						{ requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{ matches: () => false },
						resolve,
					));
				});
			},
		},
	} as unknown as ExtensionContext;
	registerCorrections(pi, { agentDir, group });
	return {
		agentDir,
		entries,
		handlers,
		tools,
		commands,
		notifications,
		userMessages,
		widgets,
		customComponents,
		customOptions,
		confirmations,
		context,
	};
}

async function execute(tool: ToolDefinition, params: Record<string, unknown>, context: ExtensionContext) {
	return tool.execute("tool-call", params as never, new AbortController().signal, undefined, context);
}

function capture(h: ReturnType<typeof harness>) {
	return h.handlers.get("message_end")?.({
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{
				type: "text",
				text: `You're right.\n<cx-correction>{"category":"prioritization","agentDecision":"Proposed a sanitizer without a current failure","userFeedback":"That is unnecessary","expectedBehavior":"Compare against doing nothing","strength":"strong"}</cx-correction>`,
			}],
		},
	}, h.context);
}

async function surfaceAndPropose(h: ReturnType<typeof harness>) {
	await settle();
	await h.handlers.get("agent_settled")?.({}, h.context);
	const pattern = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!;
	await execute(h.tools.get("correction_propose")!, {
		patternId: pattern.id,
		proof: { kind: "existing_test", reason: "The focused correction test covers the change." },
		intervention: {
			action: "change",
			owner: "agents",
			scope: "global",
			exactChange: "Compare against doing nothing before adding machinery.",
			whyThisOwner: "The behavior applies across projects.",
		},
	}, h.context);
	return correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!;
}

test("does not classify ordinary responses or stop reasons", () => {
	const h = harness();
	const before = h.handlers.get("before_agent_start")?.({ prompt: "Continue.", systemPrompt: "base" }, h.context);
	expect(before.systemPrompt).not.toContain('{"kind":"none"}');
	for (const stopReason of ["toolUse", "length", "error", "aborted", "stop"]) {
		h.handlers.get("message_end")?.({
			message: { role: "assistant", stopReason, content: [{ type: "text", text: "Checking." }] },
		}, h.context);
	}
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates).toEqual([]);
	expect(h.notifications).toEqual([]);
});

test("keeps a correction classification through a failed response retry", () => {
	const h = harness();
	h.handlers.get("before_agent_start")?.({ prompt: "That is unnecessary.", systemPrompt: "base" }, h.context);
	const marker = `Retrying.\n<cx-correction>{"category":"prioritization","agentDecision":"Proposed a sanitizer without a current failure","userFeedback":"That is unnecessary","expectedBehavior":"Compare against doing nothing","strength":"strong"}</cx-correction>`;
	const failed = h.handlers.get("message_end")?.({
		message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: marker }] },
	}, h.context);
	expect(failed?.message.content[0].text).toBe("Retrying.");
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates).toEqual([]);

	h.handlers.get("message_end")?.({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed." }] },
	}, h.context);
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates).toHaveLength(1);
	expect(h.notifications.some((message) => message.startsWith("Correction recorded"))).toBeTrue();
});

test("binds an intermediate correction marker before later steering arrives", () => {
	const h = harness();
	h.handlers.get("before_agent_start")?.({ prompt: "That is unnecessary.", systemPrompt: "base" }, h.context);
	const marker = `Checking.\n<cx-correction>{"category":"prioritization","agentDecision":"Proposed a sanitizer without a current failure","userFeedback":"That is unnecessary","expectedBehavior":"Compare against doing nothing","strength":"strong"}</cx-correction>`;
	h.handlers.get("message_end")?.({
		message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: marker }] },
	}, h.context);
	h.entries.push({ type: "message", id: "later-steering", message: { role: "user", content: "One more thing." } });
	h.handlers.get("message_end")?.({
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed." }] },
	}, h.context);
	const recorded = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates;
	expect(recorded).toHaveLength(1);
	expect(recorded[0]?.source.correctionEntryId).toBe("correction");
});

test("capture returns before background grouping finishes", async () => {
	let resolveGrouping!: (patterns: CorrectionPattern[]) => void;
	let groupedCandidates: CorrectionCandidate[] = [];
	const grouping = new Promise<CorrectionPattern[]>((resolve) => {
		resolveGrouping = resolve;
	});
	const h = harness(async (candidates) => {
		groupedCandidates = candidates;
		return grouping;
	});

	const result = capture(h);
	expect(result?.message.content[0].text).toBe("You're right.");
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates).toHaveLength(1);
	resolveGrouping(readyPatterns(groupedCandidates));
	await settle();
});

test("aborted grouping retries from the durable queue on next startup", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "corrections-retry-"));
	roots.push(agentDir);
	let groupCalls = 0;
	const first = harness((_candidates, _ctx, signal) => {
		groupCalls++;
		return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	}, agentDir);
	capture(first);
	capture(first);
	await settle();
	first.handlers.get("session_shutdown")?.({}, first.context);
	await settle();
	expect(groupCalls).toBe(1);
	expect(correctionState(readCorrectionEvents(correctionsFile(agentDir))).patterns).toEqual([]);

	const second = harness(async (candidates) => readyPatterns(candidates), agentDir);
	second.handlers.get("session_start")?.({}, second.context);
	await settle();
	expect(correctionState(readCorrectionEvents(correctionsFile(agentDir))).patterns).toHaveLength(1);
});

test("captures a correction, groups it off the response path, and supports undo", async () => {
	const h = harness();
	capture(h);
	const candidateId = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates[0]!.id;
	await settle();
	await h.handlers.get("agent_settled")?.({}, h.context);
	expect(h.notifications).toContain("Correction evidence ready: Unnecessary machinery. Run /corrections to inspect it.");
	expect(h.notifications.some((message) => message.includes(`/corrections undo ${candidateId}`))).toBeTrue();

	await h.commands.get("corrections")?.(`undo ${candidateId}`, h.context);
	const state = correctionState(readCorrectionEvents(correctionsFile(h.agentDir)));
	expect(state.candidates).toEqual([]);
	expect(state.patterns).toEqual([]);
});

test("Reflect can backfill an approved correction with exact provenance", async () => {
	const h = harness();
	const result = await execute(h.tools.get("correction_log")!, {
		category: "prioritization",
		agentDecision: "Proposed unnecessary machinery",
		userFeedback: "That is unnecessary",
		expectedBehavior: "Compare against doing nothing",
		strength: "strong",
		source: {
			requestEntryId: "request",
			assistantEntryId: "answer",
			correctionEntryId: "correction",
		},
	}, h.context);
	expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Backfilled correction") });
});

test("deferred proposals remain frozen and can be accepted later", async () => {
	const h = harness();
	capture(h);
	await settle();
	const clusterId = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!.id;

	await h.commands.get("corrections")?.(`defer ${clusterId}`, h.context);
	const deferred = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!;
	expect(deferred.id).toStartWith("proposal-");
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).decisions.get(deferred.id)).toBe("deferred");
	const proposed = await surfaceAndPropose(h);
	await h.commands.get("corrections")?.(`accept ${proposed.id}`, h.context);
	expect(h.userMessages[0]).toContain("Implement the accepted correction proposal");
});

test("opens a dismissible temporary correction review without leaving a widget", async () => {
	const h = harness();
	capture(h);
	await settle();
	const command = h.commands.get("corrections");
	expect(command).toBeDefined();
	if (!command) return;

	const review = command("", h.context);
	await settle();
	const component = h.customComponents[0];
	expect(component).toBeDefined();
	expect(h.customOptions[0]).toBeUndefined();
	expect(h.widgets.at(-1)).toBeUndefined();
	expect(component?.render(120).join("\n")).toContain("Unnecessary machinery");
	component?.handleInput?.("q");
	await review;
	expect(h.userMessages).toEqual([]);
});

test("accepts a selected inspected proposal after confirmation", async () => {
	const h = harness();
	capture(h);
	await surfaceAndPropose(h);
	const command = h.commands.get("corrections");
	expect(command).toBeDefined();
	if (!command) return;

	const review = command("", h.context);
	await settle();
	h.customComponents[0]?.handleInput?.("a");
	await review;
	expect(h.confirmations[0]).toContain("Accept correction?");
	expect(h.userMessages[0]).toContain("Implement the accepted correction proposal");
});

test("does not mutate evidence when acceptance lacks an inspected proposal", async () => {
	const h = harness();
	capture(h);
	await settle();
	const pattern = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!;

	await h.commands.get("corrections")?.(`accept ${pattern.id}`, h.context);
	const state = correctionState(readCorrectionEvents(correctionsFile(h.agentDir)));
	expect(h.notifications).toContain("Discuss and save an inspected proposal before accepting this evidence.");
	expect(state.decisions.size).toBe(0);
	expect(state.surfaced.size).toBe(0);
	expect(state.patterns[0]?.id).toBe(pattern.id);
});

for (const [action, decision] of [["already-fixed", "already_fixed"], ["duplicate", "duplicate"]] as const) {
	test(`${action} settles correction evidence`, async () => {
		const h = harness();
		capture(h);
		await settle();
		const pattern = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!;

		await h.commands.get("corrections")?.(`${action} ${pattern.id}`, h.context);
		const state = correctionState(readCorrectionEvents(correctionsFile(h.agentDir)));
		expect([...state.decisions.values()]).toContain(decision);
		expect(state.candidates).toHaveLength(0);
	});
}

test("blocks project proposals outside their inspected target", async () => {
	const h = harness();
	capture(h);
	await settle();
	await h.handlers.get("agent_settled")?.({}, h.context);
	const frozen = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0]!;
	await execute(h.tools.get("correction_propose")!, {
		patternId: frozen.id,
		proof: { kind: "direct_observation", reason: "The preference was stated directly." },
		intervention: {
			action: "add",
			owner: "memory",
			scope: "project",
			targetProject: h.context.cwd,
			exactChange: "Store the preference in the target project.",
			whyThisOwner: "It is project-specific.",
		},
	}, h.context);
	(h.context as { cwd: string }).cwd = "/another-project";
	await h.commands.get("corrections")?.(`accept ${frozen.id}`, h.context);
	expect(h.notifications).toContain(`Open the target project before accepting this correction: ${h.agentDir}`);
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).decisions.size).toBe(0);
});

test("starts a discussion without deciding or applying the correction", async () => {
	const h = harness();
	capture(h);
	await settle();
	const command = h.commands.get("corrections");
	expect(command).toBeDefined();
	if (!command) return;

	const review = command("", h.context);
	await settle();
	h.customComponents[0]?.handleInput?.("c");
	await review;
	const state = correctionState(readCorrectionEvents(correctionsFile(h.agentDir)));
	expect(state.decisions.size).toBe(0);
	expect(state.surfaced.size).toBe(1);
	expect(state.patterns[0]?.id).toStartWith("proposal-");
	expect(h.userMessages[0]).toContain("This is discussion only");
	expect(h.userMessages[0]).toContain(state.patterns[0]!.id);
	expect(h.userMessages[0]).toContain("Unnecessary machinery");
	expect(h.userMessages[0]).toContain("That is unnecessary");
});

test("accepted proposals stay pending until their proof finishes", async () => {
	const h = harness();
	capture(h);
	const pattern = await surfaceAndPropose(h);

	await h.commands.get("corrections")?.(`accept ${pattern.id}`, h.context);
	expect(h.userMessages[0]).toContain("This is authorization for the exact local change");
	expect(h.userMessages[0]).toContain("not commit, push, publication, or deployment");
	expect(h.userMessages[0]).toContain(pattern.intervention!.exactChange);
	expect(h.userMessages[0]).toContain("Keep the proposal accepted and pending until its proof passes");
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates).toHaveLength(1);
	await h.commands.get("corrections")?.(`reject ${pattern.id}`, h.context);
	expect(h.notifications).toContain("This correction is accepted and waiting for its proof outcome.");
	expect(correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).decisions.get(pattern.id)).toBe("accepted");
	const outcome = await execute(h.tools.get("correction_outcome")!, {
		patternId: pattern.id,
		outcome: "rejected_by_proof",
		evidence: "The candidate regressed a routing case.",
	}, h.context);
	expect(outcome.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("rejected_by_proof") });
	await expect(execute(h.tools.get("correction_outcome")!, {
		patternId: pattern.id,
		outcome: "verified",
		evidence: "A later call tried to replace the failed proof.",
	}, h.context)).rejects.toThrow("already has a proof outcome");
	await settle();
	const events = readCorrectionEvents(correctionsFile(h.agentDir));
	expect(events.some((event) => event.type === "proposal_outcome" && event.outcome === "rejected_by_proof")).toBeTrue();
	const rejected = correctionState(events);
	expect(rejected.candidates).toHaveLength(1);
	expect(rejected.groupingCandidates).toHaveLength(1);
	expect(rejected.patterns.map(({ id }) => id)).not.toContain(pattern.id);
});

test("repeated capture of the same source does not multiply evidence", async () => {
	const h = harness();
	capture(h);
	capture(h);
	await settle();
	const state = correctionState(readCorrectionEvents(correctionsFile(h.agentDir)));
	expect(state.allCandidates).toHaveLength(1);
	expect(state.allCandidates[0]?.evidence?.complete).toBeTrue();
});

test("grouping receives current guidance and frozen decisions", async () => {
	const contexts: CorrectionGroupingContext[] = [];
	const h = harness(async (candidates, _ctx, _signal, context) => {
		contexts.push(context);
		return readyPatterns(candidates);
	});
	capture(h);
	await settle();
	await h.handlers.get("agent_settled")?.({}, h.context);
	const frozen = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).patterns[0];
	if (!frozen) throw new Error("Expected a frozen pattern");
	await h.commands.get("corrections")?.(`defer ${frozen.id}`, h.context);
	h.entries.push(
		{ type: "message", id: "second-answer", message: { role: "assistant", content: [{ type: "text", text: "Add a second sanitizer." }] } },
		{ type: "message", id: "second-feedback", message: { role: "user", content: "Still unnecessary." } },
	);
	capture(h);
	await settle();
	expect(contexts.at(-1)?.guidance).toBe(h.context.getSystemPrompt());
	expect(contexts.at(-1)?.existingPatterns).toContainEqual(expect.objectContaining({ id: frozen.id, decision: "deferred" }));
});

test("does not publish a stale grouping result after evidence is undone", async () => {
	const pending = Promise.withResolvers<CorrectionPattern[]>();
	const h = harness(async () => pending.promise);
	capture(h);
	const recorded = correctionState(readCorrectionEvents(correctionsFile(h.agentDir))).candidates[0];
	if (!recorded) throw new Error("Expected a candidate");
	await h.commands.get("corrections")?.(`undo ${recorded.id}`, h.context);
	pending.resolve(readyPatterns([recorded]));
	await settle();
	const events = readCorrectionEvents(correctionsFile(h.agentDir));
	expect(events.filter(({ type }) => type === "grouping_snapshot")).toHaveLength(0);
	expect(correctionState(events).patterns).toHaveLength(0);
});

test("guidance changes invalidate the previous grouping snapshot", async () => {
	let calls = 0;
	const h = harness(async (candidates) => {
		calls += 1;
		return readyPatterns(candidates);
	});
	capture(h);
	await settle();
	expect(calls).toBe(1);
	h.context.getSystemPrompt = () => "The current owner now covers this behavior.";
	await h.handlers.get("session_start")?.({}, h.context);
	await settle();
	expect(calls).toBe(2);
});

test("selects the newest scoped Fable model and ignores other models", () => {
	const model = (provider: string, id: string) => ({ provider, id }) as never;
	expect(selectFableModel([
		model("openai-codex", "gpt-5.6-sol"),
		model("anthropic", "claude-fable-5"),
		model("anthropic", "claude-opus-5"),
		model("anthropic", "claude-fable-5-1"),
	])).toMatchObject({ provider: "anthropic", id: "claude-fable-5-1" });
	expect(selectFableModel([
		model("anthropic", "claude-fable-5-1"),
		model("anthropic", "claude-fable-6"),
	])).toMatchObject({ id: "claude-fable-6" });
	expect(() => selectFableModel([model("anthropic", "claude-opus-5")])).toThrow("found none");
});
