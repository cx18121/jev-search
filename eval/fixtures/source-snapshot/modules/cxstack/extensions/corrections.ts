import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type Message,
	type Model,
	StringEnum,
	Type,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	buildCorrectionReviewGroups,
	CorrectionReviewComponent,
	type CorrectionReviewAction,
} from "../components/corrections-review.js";
import {
	appendCorrectionEvent,
	CORRECTION_GROUPING_VERSION,
	correctionState,
	correctionEvidence,
	correctionsFile,
	createCorrectionCandidate,
	extractCorrectionMarker,
	freezeCorrectionPattern,
	groupingInput,
	inferCorrectionSource,
	parseCorrectionProposal,
	parseGroupingOutput,
	readCorrectionEvents,
	type CorrectionCandidate,
	type CorrectionGroupingContext,
	type CorrectionDecision,
	type CorrectionInterpretation,
	type CorrectionPattern,
	type CorrectionSource,
} from "../lib/corrections.js";
import { cxContentVersion, renderCxKernel, restoreCxState } from "../lib/cx.js";

const resourceRoot = fileURLToPath(new URL("../resources/", import.meta.url));
const kernel = renderCxKernel(
	readFileSync(join(resourceRoot, "kernel.md"), "utf8"),
	resourceRoot,
);
const kernelVersion = cxContentVersion(kernel);
const captureInstructions = `Correction capture is evidence, not a durable rule. Capture only when Charlie identifies a concrete mismatch in your prior answer or action, or explicitly establishes a standing preference that your prior choice missed. Check what you actually said or did against the request at that time. Answer normally and append this hidden marker at the end:
<cx-correction>{"category":"...","agentDecision":"...","userFeedback":"...","expectedBehavior":"...","strength":"weak|strong"}</cx-correction>
Do not mention the marker. Confirmation questions, status requests, selecting an option you offered, new information, and changed requirements are not corrections by themselves. Do not invent a prior mistake from the user's later preference. Do not capture the same incident again just because you discuss it further.`;
const groupingInstructions = readFileSync(join(resourceRoot, "correction-grouping.md"), "utf8").trim();

type CorrectionsDependencies = {
	agentDir?: string;
	group?: (candidates: CorrectionCandidate[], ctx: ExtensionContext, signal: AbortSignal, context: CorrectionGroupingContext) => Promise<CorrectionPattern[]>;
};

const now = () => new Date().toISOString();
const sorted = (values: string[]) => [...values].sort();
const discussionPrompt = (pattern: CorrectionPattern, candidates: CorrectionCandidate[]) => `Discuss the frozen correction evidence below with me. This is discussion only. Do not accept, reject, defer, save a proposal, implement, edit files, or write durable memory unless I explicitly decide later.

Pattern ID: ${pattern.id}
Problem: ${pattern.title}
Summary: ${pattern.summary}
Why it was grouped: ${pattern.reason}
${pattern.relatedPatternId ? `Related pattern: ${pattern.relatedPatternId}\n` : ""}${pattern.readiness ? `Readiness assessment: ${JSON.stringify(pattern.readiness)}\n` : ""}Evidence:
${candidates.map((candidate) => `- ${candidate.id} · ${candidate.createdAt} · ${candidate.project}\n  Source entries: ${candidate.source.requestEntryId}, ${candidate.source.assistantEntryId}, ${candidate.source.correctionEntryId}\n  Agent decision: ${candidate.agentDecision}\n  Feedback: ${candidate.userFeedback}\n  Expected behavior: ${candidate.expectedBehavior}\n  Source exchange: ${JSON.stringify(candidate.evidence ?? { complete: false })}`).join("\n")}
${pattern.intervention ? `Current proposal:\n${JSON.stringify({ proof: pattern.proof, eval: pattern.eval, intervention: pattern.intervention }, null, 2)}\n` : "No intervention has been authored yet.\n"}
Inspect the current instruction, skill, memory, documentation, code, or test that would own any proposed change before recommending one. Explain the problem, existing owner, exact change, exclusions, proof, and tradeoffs in plain terms. Keep unrelated failure mechanisms separate. If I later ask to save the inspected proposal, use correction_propose. Do not save it during this discussion.`;
const acceptedPrompt = (pattern: CorrectionPattern) => `Implement the accepted correction proposal below. This is authorization for the exact local change and focused verification, but not commit, push, publication, or deployment.

Pattern ID: ${pattern.id}
Pattern: ${pattern.title}
Evidence: ${pattern.summary}
Proof: ${pattern.proof?.kind ?? "unspecified"} — ${pattern.proof?.reason ?? "No proof was recorded."}
${pattern.eval ? `Eval:\n${JSON.stringify(pattern.eval, null, 2)}\n` : ""}${pattern.intervention ? `Intervention:\n${JSON.stringify(pattern.intervention, null, 2)}\n` : ""}
Keep the proposal accepted and pending until its proof passes. If the proof fails or a relevant regression appears, revert the candidate intervention and call correction_outcome with outcome rejected_by_proof. Otherwise call correction_outcome with outcome verified and concise evidence.`;
const sameValues = (left: string[], right: string[]) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const sameProject = (left: string, right: string) => {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
};

const versionKey = (id: string) => (id.match(/\d+/g) ?? []).map(Number);
const newerVersionFirst = (left: string, right: string) => {
	const [leftKey, rightKey] = [versionKey(left), versionKey(right)];
	for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
		const difference = (rightKey[index] ?? -1) - (leftKey[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return right.localeCompare(left);
};

export function selectFableModel(models: Model<Api>[]): Model<Api> {
	const model = models
		.filter(({ provider, id }) => provider === "anthropic" && id.includes("fable"))
		.sort((left, right) => newerVersionFirst(left.id, right.id))[0];
	if (!model) throw new Error("Correction grouping requires a scoped Anthropic Fable model; found none.");
	return model;
}

function fableModel(ctx: ExtensionContext): Model<Api> {
	return selectFableModel(ctx.scopedModels.map(({ model }) => model));
}

async function defaultGroup(
	candidates: CorrectionCandidate[],
	ctx: ExtensionContext,
	signal: AbortSignal,
	context: CorrectionGroupingContext,
): Promise<CorrectionPattern[]> {
	const model = fableModel(ctx);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Correction grouping could not authenticate Fable: ${auth.error}`);
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: groupingInput(candidates, context) }],
		timestamp: Date.now(),
	};
	const response = await complete(
		model,
		{ systemPrompt: groupingInstructions, messages: [message] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);
	if (response.stopReason === "aborted") throw new Error("Correction grouping was cancelled.");
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "Correction grouping failed without provider details.");
	}
	const output = response.content
		.flatMap((part) => part.type === "text" ? [part.text] : [])
		.join("\n")
		.trim();
	if (!output) throw new Error("Correction grouping returned no text.");
	return parseGroupingOutput(output, candidates, context);
}

export default function registerCorrections(
	pi: ExtensionAPI,
	dependencies: CorrectionsDependencies = {},
): void {
	const filePath = correctionsFile(dependencies.agentDir ?? getAgentDir());
	const group = dependencies.group ?? defaultGroup;
	let grouping: Promise<void> | undefined;
	let groupAgain = false;
	let currentCorrection: { interpretation: CorrectionInterpretation; source: CorrectionSource } | undefined;
	let groupingController: AbortController | undefined;

	const activeState = () => correctionState(readCorrectionEvents(filePath));
	const recordCandidate = (
		interpretation: CorrectionInterpretation,
		ctx: ExtensionContext,
		explicitSource?: CorrectionSource,
	) => {
		if (!restoreCxState(ctx.sessionManager.getEntries()).active) throw new Error("Correction capture requires an active CX session.");
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) throw new Error("Correction capture requires a persisted session.");
		const entries = ctx.sessionManager.getBranch();
		const source = inferCorrectionSource(entries, explicitSource);
		const existing = activeState().allCandidates.find((candidate) => candidate.sessionId === sessionId
			&& candidate.source.assistantEntryId === source.assistantEntryId
			&& candidate.source.correctionEntryId === source.correctionEntryId);
		if (existing) return existing;
		const candidate = createCorrectionCandidate({
			sessionId,
			project: ctx.cwd,
			source,
			...interpretation,
			evidence: correctionEvidence(entries, source),
			kernelVersion,
		});
		appendCorrectionEvent(filePath, { type: "candidate_recorded", at: now(), candidate });
		scheduleGrouping(ctx);
		return candidate;
	};
	const needsGrouping = (ctx: ExtensionContext) => {
		const events = readCorrectionEvents(filePath);
		const state = correctionState(events);
		const guidance = ctx.getSystemPrompt();
		const guidanceVersion = { project: ctx.cwd, hash: cxContentVersion(guidance) };
		const snapshotIndex = events.findLastIndex(
			(event) => event.type === "grouping_snapshot" && event.version === CORRECTION_GROUPING_VERSION,
		);
		const snapshot = snapshotIndex < 0 ? undefined : events[snapshotIndex];
		const invalidated = events.slice(snapshotIndex + 1).some(
			(event) => event.type === "candidate_recorded"
				|| event.type === "candidate_undone"
				|| event.type === "proposal_surfaced"
				|| event.type === "proposal_decided"
				|| event.type === "proposal_outcome",
		);
		return {
			revision: events.length,
			guidance,
			guidanceVersion,
			state,
			candidates: state.groupingCandidates,
			needed: state.groupingCandidates.length > 0 && (
				!snapshot
				|| snapshot.type !== "grouping_snapshot"
				|| snapshot.guidance?.project !== guidanceVersion.project
				|| snapshot.guidance?.hash !== guidanceVersion.hash
				|| !sameValues(snapshot.candidateIds, state.groupingCandidates.map(({ id }) => id))
				|| invalidated
			),
		};
	};

	const scheduleGrouping = (ctx: ExtensionContext) => {
		groupAgain = true;
		if (grouping) return;
		groupingController = new AbortController();
		const controller = groupingController;
		grouping = (async () => {
			while (groupAgain) {
				groupAgain = false;
				const pending = needsGrouping(ctx);
				if (!pending.needed) continue;
				const context: CorrectionGroupingContext = {
					project: ctx.cwd,
					guidance: pending.guidance,
					existingPatterns: pending.state.allPatterns
						.filter(({ id }) => (pending.state.surfaced.has(id) || pending.state.decisions.has(id))
							&& pending.state.outcomes.get(id) !== "rejected_by_proof")
						.map(({ id, title, summary, reason, candidateIds, intervention }) => ({
							id, title, summary, reason, intervention,
							projects: [...new Set(pending.state.allCandidates
								.filter((candidate) => candidateIds.includes(candidate.id))
								.map(({ project }) => project))],
							decision: pending.state.decisions.get(id),
							outcome: pending.state.outcomes.get(id),
						})),
				};
				const patterns = await group(pending.candidates, ctx, controller.signal, context);
				if (controller.signal.aborted) return;
				if (readCorrectionEvents(filePath).length !== pending.revision) {
					groupAgain = true;
					continue;
				}
				appendCorrectionEvent(filePath, {
					type: "grouping_snapshot",
					at: now(),
					version: CORRECTION_GROUPING_VERSION,
					guidance: pending.guidanceVersion,
					candidateIds: pending.candidates.map(({ id }) => id),
					patterns,
				});
			}
		})().catch((error) => {
			if (!controller.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`Correction grouping failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}).finally(() => {
			const restart = groupAgain && !controller.signal.aborted;
			grouping = undefined;
			groupingController = undefined;
			if (restart) scheduleGrouping(ctx);
		});
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (!restoreCxState(ctx.sessionManager.getEntries()).active) return undefined;
		currentCorrection = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${captureInstructions}` };
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;
		if (!restoreCxState(ctx.sessionManager.getEntries()).active) return undefined;
		let interpretation: CorrectionInterpretation | undefined;
		let changed = false;
		const content: typeof event.message.content = [];
		for (const part of event.message.content) {
			if (part.type !== "text") {
				content.push(part);
				continue;
			}
			const extracted = extractCorrectionMarker(part.text);
			if (extracted.content !== part.text) changed = true;
			if (extracted.interpretation) interpretation = extracted.interpretation;
			if (extracted.content === part.text) content.push(part);
			else if (extracted.content) content.push({ ...part, text: extracted.content });
		}
		const safeContent = content.some((part) => part.type === "text" || part.type === "toolCall")
			? content
			: [...content, { type: "text" as const, text: "I completed the response." }];
		if (interpretation) {
			try {
				currentCorrection = {
					interpretation,
					source: inferCorrectionSource(ctx.sessionManager.getBranch()),
				};
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Correction capture failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}

		if (event.message.stopReason === "stop") {
			const completedCorrection = currentCorrection;
			currentCorrection = undefined;
			if (completedCorrection) {
				try {
					const candidate = recordCandidate(completedCorrection.interpretation, ctx, completedCorrection.source);
					if (ctx.hasUI) ctx.ui.notify(`Correction recorded · ${candidate.category} · ${candidate.strength}. Undo: /corrections undo ${candidate.id}`, "info");
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`Correction capture failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			}
		} else if (changed && !interpretation && ctx.hasUI) {
			ctx.ui.notify("Ignored an invalid correction marker.", "warning");
		}
		return changed ? { message: { ...event.message, content: safeContent } } : undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("corrections-review", undefined);
		if (!restoreCxState(ctx.sessionManager.getEntries()).active) return;
		scheduleGrouping(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		groupingController?.abort();
		ctx.ui.setWidget("corrections-review", undefined);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const state = activeState();
		const pattern = state.patterns.find(({ disposition, id }) => disposition === "ready" && !state.surfaced.has(id));
		if (!pattern || !ctx.hasUI) return;
		const frozen = freezeCorrectionPattern(pattern);
		appendCorrectionEvent(filePath, { type: "proposal_surfaced", at: now(), patternId: frozen.id, pattern: frozen });
		scheduleGrouping(ctx);
		ctx.ui.notify(`Correction evidence ready: ${frozen.title}. Run /corrections to inspect it.`, "info");
	});

	pi.registerTool({
		name: "correction_log",
		label: "Backfill Correction",
		description: "Backfill one approved correction candidate from Reflect using exact session entry ids.",
		parameters: Type.Object({
			category: Type.String({ minLength: 1, maxLength: 80 }),
			agentDecision: Type.String({ minLength: 1, maxLength: 600 }),
			userFeedback: Type.String({ minLength: 1, maxLength: 600 }),
			expectedBehavior: Type.String({ minLength: 1, maxLength: 600 }),
			strength: StringEnum(["weak", "strong"] as const),
			source: Type.Object({
				requestEntryId: Type.String({ minLength: 1, maxLength: 64 }),
				assistantEntryId: Type.String({ minLength: 1, maxLength: 64 }),
				correctionEntryId: Type.String({ minLength: 1, maxLength: 64 }),
			}),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const candidate = recordCandidate({
				category: params.category,
				agentDecision: params.agentDecision,
				userFeedback: params.userFeedback,
				expectedBehavior: params.expectedBehavior,
				strength: params.strength,
			}, ctx, params.source);
			return {
				content: [{ type: "text", text: `Backfilled correction ${candidate.id}. Undo with /corrections undo ${candidate.id}.` }],
				details: { id: candidate.id, category: candidate.category, strength: candidate.strength },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("muted", "Backfill correction"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { id?: string; category?: string; strength?: string } | undefined;
			const label = [details?.category, details?.strength].filter(Boolean).join(" · ");
			const undo = details?.id ? `\n${theme.fg("dim", `/corrections undo ${details.id}`)}` : "";
			return new Text(`${theme.fg("accent", `Correction recorded${label ? ` · ${label}` : ""}`)}${undo}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "correction_propose",
		label: "Save Correction Proposal",
		description: "Save an inspected correction proposal after Charlie explicitly asks to preserve it for review.",
		parameters: Type.Object({
			patternId: Type.String({ minLength: 1, maxLength: 64 }),
			proof: Type.Object({
				kind: StringEnum(["existing_test", "new_mechanical_eval", "new_live_eval", "direct_observation", "no_additional_proof"] as const),
				reason: Type.String({ minLength: 1, maxLength: 600 }),
			}),
			eval: Type.Optional(Type.Object({
				input: Type.String({ minLength: 1, maxLength: 600 }),
				expectedBehavior: Type.String({ minLength: 1, maxLength: 600 }),
				forbiddenBehavior: Type.Array(Type.String({ minLength: 1, maxLength: 600 })),
				rubric: Type.Array(Type.String({ minLength: 1, maxLength: 600 })),
				models: Type.Array(StringEnum(["openai", "fable"] as const)),
			})),
			intervention: Type.Optional(Type.Object({
				action: StringEnum(["add", "change", "remove"] as const),
				owner: StringEnum(["code_or_test", "agents", "project_docs", "cxstack", "skill", "memory", "papercut"] as const),
				scope: StringEnum(["project", "global"] as const),
				targetProject: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
				exactChange: Type.String({ minLength: 1, maxLength: 1000 }),
				whyThisOwner: Type.String({ minLength: 1, maxLength: 600 }),
			})),
		}),
		async execute(_toolCallId, params, _signal, _update, _ctx) {
			const state = activeState();
			const pattern = state.patterns.find(({ id }) => id === params.patternId);
			if (!pattern || !state.surfaced.has(pattern.id)) throw new Error(`Correction pattern ${params.patternId} is not a frozen review item.`);
			const decision = state.decisions.get(pattern.id);
			if (decision && decision !== "deferred") throw new Error(`Correction pattern ${params.patternId} already has a terminal decision.`);
			const proposal = parseCorrectionProposal({
				proof: params.proof,
				eval: params.eval,
				intervention: params.intervention,
			});
			const target = proposal.intervention?.targetProject;
			if (target) {
				const evidenceProjects = state.allCandidates
					.filter(({ id }) => pattern.candidateIds.includes(id))
					.map(({ project }) => project);
				if (!evidenceProjects.some((project) => sameProject(project, target))) {
					throw new Error(`Correction target ${target} is not represented in its evidence.`);
				}
			}
			appendCorrectionEvent(filePath, { type: "proposal_authored", at: now(), patternId: pattern.id, proposal });
			return {
				content: [{ type: "text", text: `Saved an inspected proposal for ${pattern.id}. It remains undecided.` }],
				details: { patternId: pattern.id },
			};
		},
	});

	pi.registerTool({
		name: "correction_outcome",
		label: "Record Correction Outcome",
		description: "Record whether an accepted correction proposal passed or failed its proof.",
		parameters: Type.Object({
			patternId: Type.String({ minLength: 1, maxLength: 64 }),
			outcome: StringEnum(["verified", "rejected_by_proof"] as const),
			evidence: Type.String({ minLength: 1, maxLength: 600 }),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const state = activeState();
			if (state.decisions.get(params.patternId) !== "accepted") throw new Error(`Correction pattern ${params.patternId} is not accepted.`);
			if (state.outcomes.has(params.patternId)) throw new Error(`Correction pattern ${params.patternId} already has a proof outcome.`);
			appendCorrectionEvent(filePath, {
				type: "proposal_outcome",
				at: now(),
				patternId: params.patternId,
				outcome: params.outcome,
				evidence: params.evidence.replace(/\s+/g, " ").trim(),
			});
			scheduleGrouping(ctx);
			return {
				content: [{ type: "text", text: `Recorded ${params.outcome} for ${params.patternId}.` }],
				details: { patternId: params.patternId, outcome: params.outcome },
			};
		},
	});

	const decide = (
		patternId: string,
		decision: CorrectionDecision,
		pattern: CorrectionPattern,
		ctx: ExtensionContext,
	) => {
		const state = activeState();
		const existing = state.decisions.get(patternId);
		if (existing === "accepted") {
			ctx.ui.notify("This correction is accepted and waiting for its proof outcome.", "warning");
			return;
		}
		if (existing && existing !== "deferred") {
			ctx.ui.notify(`This correction already has a ${existing.replaceAll("_", " ")} decision.`, "warning");
			return;
		}
		const wasSurfaced = state.surfaced.has(patternId);
		const decidedPattern = wasSurfaced ? pattern : freezeCorrectionPattern(pattern);
		if (decision === "accepted") {
			if (!decidedPattern.proof || (!decidedPattern.intervention && !decidedPattern.eval)) {
				ctx.ui.notify("Discuss and save an inspected proposal before accepting this evidence.", "warning");
				return;
			}
			const target = decidedPattern.intervention?.targetProject;
			if (decidedPattern.intervention?.scope === "project" && (!target || !sameProject(ctx.cwd, target))) {
				ctx.ui.notify(`Open the target project before accepting this correction: ${target ?? "target missing"}`, "warning");
				return;
			}
		}
		if (!wasSurfaced) {
			patternId = decidedPattern.id;
			appendCorrectionEvent(filePath, { type: "proposal_surfaced", at: now(), patternId, pattern: decidedPattern });
			scheduleGrouping(ctx);
		}
		appendCorrectionEvent(filePath, {
			type: "proposal_decided",
			at: now(),
			patternId,
			decision,
		});
		scheduleGrouping(ctx);
		if (decision === "accepted") {
			pi.sendUserMessage(acceptedPrompt(decidedPattern));
			return;
		}
		const label = decision === "rejected" ? "Rejected" : decision === "deferred" ? "Deferred" : decision === "already_fixed" ? "Already fixed" : "Marked duplicate";
		ctx.ui.notify(`${label}: ${decidedPattern.title}.`, "info");
	};

	const showReview = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Correction review requires interactive Pi. Use /corrections accept, reject, or defer with a pattern id.", "warning");
			return;
		}
		while (true) {
			const state = activeState();
			const action = await ctx.ui.custom<CorrectionReviewAction | undefined>(
				(tui, theme, keybindings, done) => new CorrectionReviewComponent(
					buildCorrectionReviewGroups(state),
					theme,
					() => tui.requestRender(),
					(data, binding) => keybindings.matches(data, binding),
					done,
					() => done(undefined),
				),
			);
			if (!action) return;
			const current = activeState();
			const pattern = current.allPatterns.find(({ id }) => id === action.patternId);
			if (!pattern) {
				ctx.ui.notify(`Unknown correction pattern: ${action.patternId}`, "warning");
				continue;
			}
			if (action.type === "discuss") {
				const discussed = current.surfaced.has(pattern.id) ? pattern : freezeCorrectionPattern(pattern);
				if (discussed !== pattern) {
					appendCorrectionEvent(filePath, { type: "proposal_surfaced", at: now(), patternId: discussed.id, pattern: discussed });
					scheduleGrouping(ctx);
				}
				const evidence = current.allCandidates.filter(({ id }) => discussed.candidateIds.includes(id));
				pi.sendUserMessage(discussionPrompt(discussed, evidence));
				return;
			}
			if (action.decision === "accepted") {
				if (!pattern.proof || (!pattern.intervention && !pattern.eval)) {
					ctx.ui.notify("Discuss this evidence before accepting it. No inspected proposal is saved yet.", "warning");
					continue;
				}
				const confirmed = await ctx.ui.confirm(
					"Accept correction?",
					`${pattern.title}\n\n${pattern.intervention?.exactChange ?? pattern.eval?.expectedBehavior ?? pattern.proof.reason}\n\nThis starts the approved implementation flow.`,
				);
				if (!confirmed) continue;
				decide(action.patternId, action.decision, pattern, ctx);
				return;
			}
			if (action.decision === "rejected") {
				const confirmed = await ctx.ui.confirm(
					"Reject correction?",
					`${pattern.title}\n\nThis dismisses the proposal and settles its correction evidence.`,
				);
				if (!confirmed) continue;
			}
			decide(action.patternId, action.decision, pattern, ctx);
		}
	};

	pi.registerCommand("corrections", {
		description: "Review, undo, accept, reject, defer, or settle correction evidence",
		handler: async (args, ctx) => {
			ctx.ui.setWidget("corrections-review", undefined);
			const [action, id] = args.trim().split(/\s+/, 2);
			if (action === "close") return;
			if (action === "undo" && id) {
				appendCorrectionEvent(filePath, { type: "candidate_undone", at: now(), candidateId: id });
				scheduleGrouping(ctx);
				ctx.ui.notify(`Undid ${id}.`, "info");
				return;
			}

			const state = activeState();
			const pattern = id ? state.patterns.find(({ id: patternId }) => patternId === id) : undefined;
			if (["accept", "reject", "defer", "already-fixed", "duplicate"].includes(action) && id) {
				if (!pattern) {
					ctx.ui.notify(`Unknown correction pattern: ${id}`, "warning");
					return;
				}
				const decision: CorrectionDecision = action === "accept"
					? "accepted"
					: action === "reject"
						? "rejected"
						: action === "defer"
							? "deferred"
							: action === "already-fixed"
								? "already_fixed"
								: "duplicate";
				decide(id, decision, pattern, ctx);
				return;
			}

			await showReview(ctx);
		},
	});
}
