import { expect, test } from "bun:test";
import {
	CORRECTION_GROUPING_VERSION,
	correctionEvidence,
	correctionState,
	createCorrectionCandidate,
	groupingInput,
	inferCorrectionSource,
	parseGroupingOutput,
	type CorrectionGroupingContext,
	type CorrectionPattern,
} from "../lib/corrections.ts";

const entries = [
	{ type: "message", id: "request", message: { role: "user", content: "How should we handle existing returns?" } },
	{ type: "message", id: "answer", message: { role: "assistant", content: [
		{ type: "toolCall", id: "question-1", name: "ask_user_question", arguments: { options: ["New only", "Include backlog"] } },
	] } },
	{ type: "message", id: "feedback", message: { role: "toolResult", toolName: "ask_user_question", toolCallId: "question-1", content: [
		{ type: "text", text: "New only" },
	] } },
];
const source = { requestEntryId: "request", assistantEntryId: "answer", correctionEntryId: "feedback" };
const candidate = () => createCorrectionCandidate({
	sessionId: "session-1", project: "/project", source, category: "rollout", agentDecision: "Chose new returns only",
	userFeedback: "Include backlog", expectedBehavior: "Include existing returns", strength: "strong", kernelVersion: "test",
	evidence: correctionEvidence(entries, source),
});
const context: CorrectionGroupingContext = {
	project: "/project", guidance: "Do not replay existing returns unless explicitly requested.",
	existingPatterns: [{ id: "proposal-existing", projects: ["/project"], title: "Honor rollout decisions", summary: "Covered by current guidance.", reason: "No new rule", decision: "rejected" }],
};
const ready = (id: string) => ({
	title: "Rollout behavior", summary: "A claimed rollout mistake", candidateIds: [id], disposition: "ready",
	reason: "A concrete gap", readiness: { scope: "project" as const, mismatch: "Actual source mismatch", gap: "A missing constraint", benefit: "Prevents an expensive failure" },
});

test("questionnaire feedback binds to the matching call and retains its offered options", () => {
	expect(inferCorrectionSource(entries)).toEqual(source);
	expect(correctionEvidence(entries, source)).toEqual({ complete: true, messages: [
		{ id: "request", role: "user", text: "How should we handle existing returns?" },
		{ id: "answer", role: "assistant", text: '{"options":["New only","Include backlog"]}' },
		{ id: "feedback", role: "toolResult", text: "New only" },
	] });
	const wrongCall = entries.map((entry) => entry.id === "feedback" ? { ...entry, message: { ...entry.message, toolCallId: "unrelated" } } : entry);
	expect(() => inferCorrectionSource(wrongCall)).toThrow("ordered request");
	expect(() => inferCorrectionSource(entries, { ...source, requestEntryId: "feedback" })).toThrow("ordered request");
});

test("inference skips a tool-only assistant after the actual answer", () => {
	const conversation = [entries[0],
		{ type: "message", id: "actual-answer", message: { role: "assistant", content: [{ type: "text", text: "The backlog is excluded." }] } },
		{ type: "message", id: "read-call", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] } },
		{ type: "message", id: "user-correction", message: { role: "user", content: "That wasn't the agreed scope." } },
	].filter((entry) => entry !== undefined);
	expect(inferCorrectionSource(conversation).assistantEntryId).toBe("actual-answer");
});

test("source snapshots preserve earlier questionnaire decisions across implementation work", () => {
	const conversation = [...entries,
		{ type: "message", id: "later-request", message: { role: "user", content: "How do we enable it?" } },
		{ type: "message", id: "later-answer", message: { role: "assistant", content: "Only new returns qualify, as agreed." } },
		{ type: "message", id: "later-feedback", message: { role: "user", content: "Why not include the backlog?" } },
	];
	const evidence = correctionEvidence(conversation, inferCorrectionSource(conversation));
	expect(evidence.complete).toBeTrue();
	expect(evidence.messages.map(({ id }) => id)).toEqual(["answer", "feedback", "later-request", "later-answer", "later-feedback"]);
	expect(evidence.messages.find(({ id }) => id === "feedback")?.text).toBe("New only");
});

test("missing or truncated source text cannot support automatic readiness", () => {
	const missing = entries.map((entry) => entry.id === "request" ? { ...entry, message: { role: "user", content: "" } } : entry);
	expect(correctionEvidence(missing, source).complete).toBeFalse();
	const long = entries.map((entry) => entry.id === "request" ? { ...entry, message: { role: "user", content: "x".repeat(12001) } } : entry);
	const evidence = correctionEvidence(long, source);
	expect(evidence.complete).toBeFalse();
	expect(evidence.messages[0]?.text).toHaveLength(12000);
	const recorded = { ...candidate(), evidence };
	expect(parseGroupingOutput(JSON.stringify([ready(recorded.id)]), [recorded], context)[0]?.disposition).toBe("hold");
});

test("ready requires complete provenance, guidance and a specific readiness case", () => {
	const recorded = candidate();
	const output = JSON.stringify([ready(recorded.id)]);
	expect(parseGroupingOutput(output, [recorded], context)[0]?.disposition).toBe("ready");
	expect(parseGroupingOutput(output, [{ ...recorded, evidence: undefined }], context)[0]?.disposition).toBe("hold");
	expect(parseGroupingOutput(output, [recorded], { ...context, guidance: "" })[0]?.disposition).toBe("hold");
	expect(parseGroupingOutput(JSON.stringify([{ ...ready(recorded.id), readiness: { gap: "   " } }]), [recorded], context)[0]?.disposition).toBe("hold");
	expect(parseGroupingOutput(output, [recorded])[0]?.disposition).toBe("hold");
});

test("project-scoped readiness cannot borrow another project's guidance", () => {
	const recorded = candidate();
	const output = JSON.stringify([ready(recorded.id)]);
	const otherProject = { ...context, project: "/different-project" };
	expect(parseGroupingOutput(output, [recorded], otherProject)[0]?.disposition).toBe("hold");
	const global = { ...ready(recorded.id), readiness: { ...ready(recorded.id).readiness, scope: "global", gap: "A conflict in the shared interview skill" } };
	expect(parseGroupingOutput(JSON.stringify([global]), [recorded], otherProject)[0]?.disposition).toBe("ready");
});

test("known duplicates remain linked evidence without a new ready item", () => {
	const recorded = candidate();
	const linked = { ...ready(recorded.id), relatedPatternId: "proposal-existing" };
	expect(parseGroupingOutput(JSON.stringify([linked]), [recorded], context)[0]).toMatchObject({ disposition: "one_off", relatedPatternId: "proposal-existing" });
	expect(() => parseGroupingOutput(JSON.stringify([{ ...linked, relatedPatternId: "invented" }]), [recorded], context)).toThrow("unknown related pattern");
	expect(() => parseGroupingOutput("[]", [recorded], context)).toThrow("omitted candidate");
});

test("group input includes source evidence, incident identity and existing decisions", () => {
	const recorded = candidate();
	const input = groupingInput([recorded], context);
	expect(input).toContain('"sessionId": "session-1"');
	expect(input).toContain('"correctionEntryId": "feedback"');
	expect(input).toContain('"text": "New only"');
	expect(input).toContain('"decision": "rejected"');
	expect(input).toContain(context.guidance);
});

test("a grouping upgrade and linked recurrence never rewrite a frozen approved proposal", () => {
	const original = candidate();
	const recurrence = { ...candidate(), sessionId: "session-2" };
	const frozen: CorrectionPattern = { ...ready(original.id), id: "proposal-existing", disposition: "ready" };
	const linked = parseGroupingOutput(JSON.stringify([{ ...ready(recurrence.id), relatedPatternId: frozen.id }]), [recurrence], context);
	const state = correctionState([
		{ type: "candidate_recorded", at: "now", candidate: original },
		{ type: "proposal_surfaced", at: "now", patternId: frozen.id, pattern: frozen },
		{ type: "proposal_decided", at: "now", patternId: frozen.id, decision: "accepted" },
		{ type: "candidate_recorded", at: "now", candidate: recurrence },
		{ type: "grouping_snapshot", at: "now", version: CORRECTION_GROUPING_VERSION, candidateIds: [recurrence.id], patterns: linked },
	]);
	expect(state.decisions.get(frozen.id)).toBe("accepted");
	expect(state.patterns.find(({ id }) => id === frozen.id)?.candidateIds).toEqual([original.id]);
	expect(state.patterns.filter(({ disposition }) => disposition === "ready")).toHaveLength(1);
	expect(state.groupingCandidates.map(({ id }) => id)).toEqual([recurrence.id]);
});
