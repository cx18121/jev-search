import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CORRECTION_GROUPING_VERSION = 3;

export type CorrectionStrength = "weak" | "strong";
export type CorrectionOwner = "code_or_test" | "agents" | "project_docs" | "cxstack" | "skill" | "memory" | "papercut";
export type CorrectionProofKind = "existing_test" | "new_mechanical_eval" | "new_live_eval" | "direct_observation" | "no_additional_proof";
export type CorrectionDecision = "accepted" | "rejected" | "deferred" | "already_fixed" | "duplicate";
export type CorrectionOutcome = "applied" | "verified" | "rejected_by_proof";

export type CorrectionInterpretation = {
	category: string;
	agentDecision: string;
	userFeedback: string;
	expectedBehavior: string;
	strength: CorrectionStrength;
};

export type CorrectionSource = {
	requestEntryId: string;
	assistantEntryId: string;
	correctionEntryId: string;
};

export type CorrectionCandidate = {
	id: string;
	sessionId: string;
	project: string;
	source: CorrectionSource;
	category: string;
	agentDecision: string;
	userFeedback: string;
	expectedBehavior: string;
	strength: CorrectionStrength;
	kernelVersion: string;
	createdAt: string;
	evidence?: {
		messages: Array<{ id: string; role: string; text: string }>;
		complete: boolean;
	};
};

export type CorrectionEval = {
	input: string;
	expectedBehavior: string;
	forbiddenBehavior: string[];
	rubric: string[];
	models: Array<"openai" | "fable">;
};

export type CorrectionIntervention = {
	action: "add" | "change" | "remove";
	owner: CorrectionOwner;
	scope: "project" | "global";
	targetProject?: string;
	exactChange: string;
	whyThisOwner: string;
};

export type CorrectionProposal = {
	proof: {
		kind: CorrectionProofKind;
		reason: string;
	};
	eval?: CorrectionEval;
	intervention?: CorrectionIntervention;
};

export type CorrectionPattern = {
	id: string;
	title: string;
	summary: string;
	candidateIds: string[];
	disposition: "one_off" | "hold" | "ready";
	relatedPatternId?: string;
	readiness?: { scope: "global" | "project"; mismatch: string; gap: string; benefit: string };
	proof?: CorrectionProposal["proof"];
	eval?: CorrectionEval;
	intervention?: CorrectionIntervention;
	reason: string;
};

export type CorrectionEvent =
	| { type: "candidate_recorded"; at: string; candidate: CorrectionCandidate }
	| { type: "candidate_undone"; at: string; candidateId: string }
	| { type: "grouping_snapshot"; at: string; version?: number; candidateIds: string[]; patterns: CorrectionPattern[]; guidance?: { project: string; hash: string } }
	| { type: "proposal_surfaced"; at: string; patternId: string; pattern?: CorrectionPattern }
	| { type: "proposal_authored"; at: string; patternId: string; proposal: CorrectionProposal }
	| { type: "proposal_decided"; at: string; patternId: string; decision: CorrectionDecision }
	| { type: "proposal_outcome"; at: string; patternId: string; outcome: CorrectionOutcome; evidence: string };

export type CorrectionState = {
	candidates: CorrectionCandidate[];
	groupingCandidates: CorrectionCandidate[];
	patterns: CorrectionPattern[];
	allCandidates: CorrectionCandidate[];
	allPatterns: CorrectionPattern[];
	decisions: Map<string, CorrectionDecision>;
	outcomes: Map<string, CorrectionOutcome>;
	surfaced: Set<string>;
};

type SessionEntry = {
	id?: unknown;
	type?: unknown;
	message?: { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown };
};

export type CorrectionGroupingContext = {
	project: string;
	guidance: string;
	existingPatterns: Array<{
		id: string;
		projects: string[];
		intervention?: CorrectionIntervention;
		title: string;
		summary: string;
		reason: string;
		decision?: CorrectionDecision;
		outcome?: CorrectionOutcome;
	}>;
};

const bounded = (value: string, max = 600) => value.replace(/\s+/g, " ").trim().slice(0, max);
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const stringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string")
	? value
	: undefined;
export function correctionsFile(agentDir: string): string {
	return join(agentDir, "corrections", "events.jsonl");
}

export function appendCorrectionEvent(filePath: string, event: CorrectionEvent): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
	chmodSync(filePath, 0o600);
}

export function readCorrectionEvents(filePath: string): CorrectionEvent[] {
	let content = "";
	try {
		content = readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return content.split("\n").filter(Boolean).map((line, index) => {
		try {
			return JSON.parse(line) as CorrectionEvent;
		} catch {
			throw new Error(`Invalid correction event at line ${index + 1}.`);
		}
	});
}

export function correctionState(events: CorrectionEvent[]): CorrectionState {
	const candidates = new Map<string, CorrectionCandidate>();
	const undone = new Set<string>();
	const decisions = new Map<string, CorrectionDecision>();
	const outcomes = new Map<string, CorrectionOutcome>();
	const surfaced = new Set<string>();
	const surfacedPatterns = new Map<string, CorrectionPattern>();
	const proposals = new Map<string, CorrectionProposal>();
	const patternsById = new Map<string, CorrectionPattern>();
	let patterns: CorrectionPattern[] = [];

	for (const event of events) {
		if (event.type === "candidate_recorded") candidates.set(event.candidate.id, event.candidate);
		if (event.type === "candidate_undone") undone.add(event.candidateId);
		if (event.type === "grouping_snapshot") {
			if (event.version === CORRECTION_GROUPING_VERSION) patterns = event.patterns;
			for (const pattern of event.patterns) patternsById.set(pattern.id, pattern);
		}
		if (event.type === "proposal_surfaced" && event.pattern) {
			surfaced.add(event.patternId);
			surfacedPatterns.set(event.patternId, event.pattern);
			patternsById.set(event.patternId, event.pattern);
		}
		if (event.type === "proposal_authored") proposals.set(event.patternId, event.proposal);
		if (event.type === "proposal_decided") decisions.set(event.patternId, event.decision);
		if (event.type === "proposal_outcome") outcomes.set(event.patternId, event.outcome);
	}

	const proposed = (pattern: CorrectionPattern): CorrectionPattern => {
		const proposal = proposals.get(pattern.id);
		return proposal ? { ...pattern, ...proposal } : pattern;
	};
	const terminal = (patternId: string): boolean => {
		const decision = decisions.get(patternId);
		if (decision === "rejected" || decision === "already_fixed" || decision === "duplicate") return true;
		return decision === "accepted" && ["applied", "verified"].includes(outcomes.get(patternId) ?? "");
	};
	const settledCandidates = new Set(
		[...decisions]
			.filter(([patternId]) => terminal(patternId))
			.flatMap(([patternId]) => patternsById.get(patternId)?.candidateIds ?? []),
	);
	const allCandidates = [...candidates.values()].filter((candidate) => !undone.has(candidate.id));
	const activeCandidates = allCandidates.filter((candidate) => !settledCandidates.has(candidate.id));
	const activeIds = new Set(activeCandidates.map(({ id }) => id));
	const frozenPatterns = [...surfacedPatterns.values()]
		.filter((pattern) => !terminal(pattern.id) && outcomes.get(pattern.id) !== "rejected_by_proof")
		.filter((pattern) => pattern.candidateIds.every((id) => activeIds.has(id)))
		.map(proposed);
	const reservedIds = new Set(frozenPatterns.flatMap(({ candidateIds }) => candidateIds));
	const groupingCandidates = activeCandidates.filter(({ id }) => !reservedIds.has(id));
	const groupingIds = new Set(groupingCandidates.map(({ id }) => id));
	const dynamicPatterns = patterns
		.filter((pattern) => !terminal(pattern.id))
		.filter((pattern) => pattern.candidateIds.every((id) => groupingIds.has(id)))
		.map(proposed);
	const activePatterns = new Map<string, CorrectionPattern>();
	for (const pattern of [...frozenPatterns, ...dynamicPatterns]) activePatterns.set(pattern.id, pattern);
	const allPatterns = new Map<string, CorrectionPattern>();
	for (const pattern of patternsById.values()) allPatterns.set(pattern.id, proposed(pattern));

	return {
		candidates: activeCandidates,
		groupingCandidates,
		patterns: [...activePatterns.values()],
		allCandidates,
		allPatterns: [...allPatterns.values()],
		decisions,
		outcomes,
		surfaced,
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const isFeedback = (entry: SessionEntry) => entry.message?.role === "user"
	|| (entry.message?.role === "toolResult" && entry.message.toolName === "ask_user_question");
const hasQuestion = (entry: SessionEntry, callId?: unknown) => Array.isArray(entry.message?.content)
	&& entry.message.content.some((part: unknown) => isRecord(part) && part.type === "toolCall"
		&& part.name === "ask_user_question" && (callId === undefined || part.id === callId));
const entryText = (entry: SessionEntry): string => {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => {
		if (!isRecord(part)) return [];
		if (part.type === "text" && typeof part.text === "string") return [part.text];
		if (part.type === "toolCall" && part.name === "ask_user_question") return [JSON.stringify(part.arguments)];
		return [];
	}).join("\n");
};

export function inferCorrectionSource(entries: SessionEntry[], explicit?: CorrectionSource): CorrectionSource {
	const messages = entries.filter((entry) => entry.type === "message" && typeof entry.id === "string" && entry.message);
	const correction = explicit
		? messages.findIndex((entry) => entry.id === explicit.correctionEntryId)
		: messages.findLastIndex(isFeedback);
	const feedback = messages[correction];
	const assistant = explicit
		? messages.findIndex((entry) => entry.id === explicit.assistantEntryId)
		: messages.findLastIndex((entry, index) => index < correction && entry.message?.role === "assistant"
			&& (feedback?.message?.role === "toolResult"
				? hasQuestion(entry, feedback.message.toolCallId)
				: entryText(entry).trim().length > 0 || entry.message.content === undefined));
	const request = explicit
		? messages.findIndex((entry) => entry.id === explicit.requestEntryId)
		: messages.findLastIndex((entry, index) => index < assistant && entry.message?.role === "user");
	const requestEntry = messages[request];
	const assistantEntry = messages[assistant];
	if (!requestEntry || !assistantEntry || !feedback || request >= assistant || assistant >= correction
		|| requestEntry.message?.role !== "user" || assistantEntry.message?.role !== "assistant" || !isFeedback(feedback)
		|| (feedback.message?.role === "toolResult" && !hasQuestion(assistantEntry, feedback.message.toolCallId))
		|| typeof requestEntry.id !== "string" || typeof assistantEntry.id !== "string" || typeof feedback.id !== "string") {
		throw new Error("Correction logging needs an ordered request, corrected assistant response, and user or questionnaire feedback.");
	}
	return { requestEntryId: requestEntry.id, assistantEntryId: assistantEntry.id, correctionEntryId: feedback.id };
}

export function correctionEvidence(entries: SessionEntry[], source: CorrectionSource): NonNullable<CorrectionCandidate["evidence"]> {
	inferCorrectionSource(entries, source);
	const start = entries.findIndex(({ id }) => id === source.requestEntryId);
	const end = entries.findIndex(({ id }) => id === source.correctionEntryId);
	const messages = entries.slice(0, end + 1).flatMap((entry, index) => {
		if (typeof entry.id !== "string" || typeof entry.message?.role !== "string") return [];
		if (index < start && !hasQuestion(entry) && !(entry.message.role === "toolResult" && isFeedback(entry))) return [];
		if (!isFeedback(entry) && entry.message.role !== "assistant") return [];
		return [{ id: entry.id, role: entry.message.role, text: entryText(entry) }];
	});
	const complete = messages.every(({ text }) => text.length <= 12000)
		&& messages.reduce((length, { text }) => length + text.length, 0) <= 36000
		&& Object.values(source).every((id) => messages.some((message) => message.id === id && message.text.trim()));
	let remaining = 36000;
	return {
		complete,
		messages: messages.map((message) => {
			const text = message.text.slice(0, Math.min(12000, remaining));
			remaining -= text.length;
			return { ...message, text };
		}),
	};
}

export function extractCorrectionMarker(content: string): { content: string; interpretation?: CorrectionInterpretation } {
	const startToken = "<cx-correction>";
	const endToken = "</cx-correction>";
	const start = content.lastIndexOf(startToken);
	const end = content.indexOf(endToken, start + startToken.length);
	if (start < 0 || end < 0) return { content };
	const cleaned = `${content.slice(0, start)}${content.slice(end + endToken.length)}`.trimEnd();
	let value: unknown;
	try {
		value = JSON.parse(content.slice(start + startToken.length, end));
	} catch {
		return { content: cleaned };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return { content: cleaned };
	const record = value as Record<string, unknown>;
	const category = text(record.category);
	const agentDecision = text(record.agentDecision);
	const userFeedback = text(record.userFeedback);
	const expectedBehavior = text(record.expectedBehavior);
	const strength = record.strength === "weak" || record.strength === "strong" ? record.strength : undefined;
	if (!category || !agentDecision || !userFeedback || !expectedBehavior || !strength) return { content: cleaned };
	return {
		content: cleaned,
		interpretation: { category, agentDecision, userFeedback, expectedBehavior, strength },
	};
}

export function createCorrectionCandidate(input: {
	sessionId: string;
	project: string;
	source: CorrectionSource;
	category: string;
	agentDecision: string;
	userFeedback: string;
	expectedBehavior: string;
	strength: CorrectionStrength;
	kernelVersion: string;
	evidence?: CorrectionCandidate["evidence"];
	now?: Date;
}): CorrectionCandidate {
	return {
		id: `correction-${randomUUID().slice(0, 8)}`,
		sessionId: input.sessionId,
		project: input.project,
		source: input.source,
		category: bounded(input.category, 80),
		agentDecision: bounded(input.agentDecision),
		userFeedback: bounded(input.userFeedback),
		expectedBehavior: bounded(input.expectedBehavior),
		strength: input.strength,
		kernelVersion: input.kernelVersion,
		...(input.evidence ? { evidence: input.evidence } : {}),
		createdAt: (input.now ?? new Date()).toISOString(),
	};
}

export function groupingInput(candidates: CorrectionCandidate[], context: CorrectionGroupingContext): string {
	return JSON.stringify({ candidates, ...context }, null, 2);
}

export function freezeCorrectionPattern(pattern: CorrectionPattern): CorrectionPattern {
	const { proof: _proof, eval: _eval, intervention: _intervention, ...cluster } = pattern;
	return { ...cluster, id: `proposal-${randomUUID().slice(0, 8)}` };
}

export function parseCorrectionProposal(value: unknown): CorrectionProposal {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid correction proposal.");
	const record = value as Record<string, unknown>;
	const proofRecord = record.proof && typeof record.proof === "object" && !Array.isArray(record.proof)
		? record.proof as Record<string, unknown>
		: undefined;
	const proofKind = ["existing_test", "new_mechanical_eval", "new_live_eval", "direct_observation", "no_additional_proof"].includes(String(proofRecord?.kind))
		? proofRecord?.kind as CorrectionProofKind
		: undefined;
	const proofReason = text(proofRecord?.reason);
	if (!proofKind || !proofReason) throw new Error("Incomplete correction proposal proof.");

	let evalCase: CorrectionEval | undefined;
	if (record.eval !== undefined) {
		if (!record.eval || typeof record.eval !== "object" || Array.isArray(record.eval)) throw new Error("Invalid correction eval.");
		const evalRecord = record.eval as Record<string, unknown>;
		const input = text(evalRecord.input);
		const expectedBehavior = text(evalRecord.expectedBehavior);
		const forbiddenBehavior = stringArray(evalRecord.forbiddenBehavior);
		const rubric = stringArray(evalRecord.rubric);
		const models = stringArray(evalRecord.models)?.filter((model): model is "openai" | "fable" => model === "openai" || model === "fable");
		if (!input || !expectedBehavior || !forbiddenBehavior || !rubric || !models?.length) throw new Error("Incomplete correction eval.");
		evalCase = {
			input: bounded(input),
			expectedBehavior: bounded(expectedBehavior),
			forbiddenBehavior,
			rubric,
			models: [...new Set(models)],
		};
	}

	let intervention: CorrectionIntervention | undefined;
	if (record.intervention !== undefined) {
		if (!record.intervention || typeof record.intervention !== "object" || Array.isArray(record.intervention)) throw new Error("Invalid correction intervention.");
		const interventionRecord = record.intervention as Record<string, unknown>;
		const action = ["add", "change", "remove"].includes(String(interventionRecord.action))
			? interventionRecord.action as CorrectionIntervention["action"]
			: undefined;
		const owner = ["code_or_test", "agents", "project_docs", "cxstack", "skill", "memory", "papercut"].includes(String(interventionRecord.owner))
			? interventionRecord.owner as CorrectionOwner
			: undefined;
		const scope = interventionRecord.scope === "project" || interventionRecord.scope === "global" ? interventionRecord.scope : undefined;
		const targetProject = text(interventionRecord.targetProject);
		const exactChange = text(interventionRecord.exactChange);
		const whyThisOwner = text(interventionRecord.whyThisOwner);
		if (!action || !owner || !scope || !exactChange || !whyThisOwner) throw new Error("Incomplete correction intervention.");
		if (scope === "project" && !targetProject) throw new Error("Project correction interventions require targetProject.");
		if (scope === "global" && targetProject) throw new Error("Global correction interventions cannot set targetProject.");
		intervention = {
			action,
			owner,
			scope,
			...(targetProject ? { targetProject: bounded(targetProject, 1000) } : {}),
			exactChange: bounded(exactChange, 1000),
			whyThisOwner: bounded(whyThisOwner),
		};
	}

	const needsEval = proofKind === "new_mechanical_eval" || proofKind === "new_live_eval";
	if (needsEval !== Boolean(evalCase)) throw new Error("Correction proposal has an inconsistent eval proof.");
	if (evalCase && (!evalCase.models.includes("openai") || !evalCase.models.includes("fable"))) {
		throw new Error("Correction eval must cover OpenAI and Fable.");
	}
	if (!evalCase && !intervention) throw new Error("Correction proposal has no action.");
	return {
		proof: { kind: proofKind, reason: bounded(proofReason) },
		...(evalCase ? { eval: evalCase } : {}),
		...(intervention ? { intervention } : {}),
	};
}

export function parseGroupingOutput(output: string, candidates: CorrectionCandidate[], context?: CorrectionGroupingContext): CorrectionPattern[] {
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	if (start < 0 || end < start) throw new Error("Correction grouping returned no JSON array.");
	const value: unknown = JSON.parse(output.slice(start, end + 1));
	if (!Array.isArray(value)) throw new Error("Correction grouping must return an array.");
	const candidateIds = new Set(candidates.map((candidate) => candidate.id));
	const patterns = value.map((item, index): CorrectionPattern => {
		if (!isRecord(item)) throw new Error(`Invalid correction pattern ${index + 1}.`);
		const record = item;
		const evidence = stringArray(record.candidateIds);
		const title = text(record.title);
		const summary = text(record.summary);
		const reason = text(record.reason);
		const disposition = record.disposition === "one_off" || record.disposition === "hold" || record.disposition === "ready"
			? record.disposition : undefined;
		if (!title || !summary || !evidence?.length || !disposition || !reason) {
			throw new Error(`Incomplete correction pattern ${index + 1}.`);
		}
		if (evidence.some((id) => !candidateIds.has(id))) throw new Error(`Correction pattern ${index + 1} references unknown evidence.`);
		const relatedPatternId = text(record.relatedPatternId);
		if (relatedPatternId && !context?.existingPatterns.some(({ id }) => id === relatedPatternId)) {
			throw new Error(`Correction pattern ${index + 1} references an unknown related pattern.`);
		}
		const assessment = isRecord(record.readiness) ? record.readiness : {};
		const mismatch = text(assessment.mismatch)?.trim();
		const gap = text(assessment.gap)?.trim();
		const benefit = text(assessment.benefit)?.trim();
		const scope = assessment.scope === "global" || assessment.scope === "project" ? assessment.scope : undefined;
		const readiness: CorrectionPattern["readiness"] = mismatch && gap && benefit && scope
			? { scope, mismatch: bounded(mismatch), gap: bounded(gap), benefit: bounded(benefit) }
			: undefined;
		const grounded = context?.guidance.trim() && evidence.every((id) => {
			const candidate = candidates.find((candidate) => candidate.id === id);
			return candidate?.evidence?.complete && (readiness?.scope === "global" || candidate.project === context.project);
		});
		const checkedDisposition = relatedPatternId ? "one_off" : disposition === "ready" && (!grounded || !readiness) ? "hold" : disposition;
		const uniqueEvidence = [...new Set(evidence)].sort();
		const fingerprint = createHash("sha256").update(uniqueEvidence.join("\0")).digest("hex").slice(0, 10);
		return {
			id: `cluster-${fingerprint}`,
			title: bounded(title, 120),
			summary: bounded(summary),
			candidateIds: uniqueEvidence,
			disposition: checkedDisposition,
			...(relatedPatternId ? { relatedPatternId } : {}),
			...(readiness ? { readiness } : {}),
			reason: disposition === "ready" && checkedDisposition === "hold"
				? "Needs complete source evidence, guidance for the affected scope, and a specific uncovered gap before discussion."
				: bounded(reason),
		};
	});
	const assignedCandidates = new Set<string>();
	for (const [index, pattern] of patterns.entries()) {
		for (const candidateId of pattern.candidateIds) {
			if (assignedCandidates.has(candidateId)) throw new Error(`Correction pattern ${index + 1} reuses candidate ${candidateId}.`);
			assignedCandidates.add(candidateId);
		}
	}
	if (assignedCandidates.size !== candidateIds.size) throw new Error("Correction grouping omitted candidate evidence.");
	return patterns;
}
