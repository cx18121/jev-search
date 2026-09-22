import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendCorrectionEvent,
	CORRECTION_GROUPING_VERSION,
	correctionState,
	correctionsFile,
	createCorrectionCandidate,
	extractCorrectionMarker,
	freezeCorrectionPattern,
	inferCorrectionSource,
	parseCorrectionProposal,
	parseGroupingOutput,
	readCorrectionEvents,
} from "../lib/corrections.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type TestSessionEntry = { type: string; id: string; message: { role: string } };
const sourceEntries = (): TestSessionEntry[] => [
	{ type: "message", id: "request", message: { role: "user" } },
	{ type: "message", id: "answer", message: { role: "assistant" } },
	{ type: "message", id: "correction", message: { role: "user" } },
	{ type: "message", id: "logging", message: { role: "assistant" } },
];

const candidate = () => createCorrectionCandidate({
	sessionId: "session",
	project: "/workspace",
	source: { requestEntryId: "request", assistantEntryId: "answer", correctionEntryId: "correction" },
	category: "prioritization",
	agentDecision: "Proposed unnecessary machinery",
	userFeedback: "This does not solve a current problem",
	expectedBehavior: "Compare against doing nothing",
	strength: "strong",
	kernelVersion: "kernel",
	now: new Date("2026-08-28T00:00:00Z"),
});

describe("correction storage", () => {
	test("appends private events and derives undo state", () => {
		const root = mkdtempSync(join(tmpdir(), "corrections-"));
		roots.push(root);
		const file = correctionsFile(root);
		const recorded = candidate();
		appendCorrectionEvent(file, { type: "candidate_recorded", at: recorded.createdAt, candidate: recorded });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(correctionState(readCorrectionEvents(file)).candidates).toHaveLength(1);
		appendCorrectionEvent(file, { type: "candidate_undone", at: recorded.createdAt, candidateId: recorded.id });
		expect(correctionState(readCorrectionEvents(file)).candidates).toEqual([]);
	});

	test("extracts and hides model-authored correction markers", () => {
		const extracted = extractCorrectionMarker(`You're right.\n<cx-correction>{"category":"scope","agentDecision":"Expanded the task","userFeedback":"Keep it narrow","expectedBehavior":"Preserve the requested scope","strength":"strong"}</cx-correction>`);
		expect(extracted.content).toBe("You're right.");
		expect(extracted.interpretation).toEqual({
			category: "scope",
			agentDecision: "Expanded the task",
			userFeedback: "Keep it narrow",
			expectedBehavior: "Preserve the requested scope",
			strength: "strong",
		});
		expect(extractCorrectionMarker("ordinary answer")).toEqual({ content: "ordinary answer" });
	});

	test("infers exact request, answer, and correction provenance", () => {
		expect(inferCorrectionSource(sourceEntries())).toEqual({
			requestEntryId: "request",
			assistantEntryId: "answer",
			correctionEntryId: "correction",
		});
		expect(() => inferCorrectionSource(sourceEntries(), {
			requestEntryId: "answer",
			assistantEntryId: "request",
			correctionEntryId: "correction",
		})).toThrow("ordered request");
	});

	test("groups evidence without authoring a proposal", () => {
		const recorded = candidate();
		const output = JSON.stringify([{
			title: "Unnecessary machinery",
			summary: "The agent proposed tooling without a current failure.",
			candidateIds: [recorded.id],
			disposition: "ready",
			reason: "The correction identifies a durable prioritization rule.",
		}]);
		const first = parseGroupingOutput(output, [recorded]);
		const second = parseGroupingOutput(output, [recorded]);
		expect(first).toEqual(second);
		expect(first[0]?.id).toStartWith("cluster-");
		expect(first[0]?.intervention).toBeUndefined();
		const repeatedEvidence = output.replace(`"candidateIds":["${recorded.id}"]`, `"candidateIds":["${recorded.id}","${recorded.id}"]`);
		expect(parseGroupingOutput(repeatedEvidence, [recorded])[0]).toMatchObject({
			id: first[0]?.id,
			candidateIds: [recorded.id],
		});
		expect(() => parseGroupingOutput(output.replaceAll(recorded.id, "unknown"), [recorded])).toThrow("unknown evidence");
		const duplicate = JSON.stringify([...(JSON.parse(output) as object[]), { ...(JSON.parse(output) as object[])[0], title: "Duplicate" }]);
		expect(() => parseGroupingOutput(duplicate, [recorded])).toThrow("reuses candidate");
	});

	test("freezes evidence before attaching an inspected proposal", () => {
		const recorded = candidate();
		const cluster = parseGroupingOutput(JSON.stringify([{
			title: "Prioritize common work",
			summary: "Frequent value was underweighted.",
			candidateIds: [recorded.id],
			disposition: "ready",
			reason: "A strong correction identifies baseline behavior.",
		}]), [recorded])[0]!;
		const frozen = freezeCorrectionPattern(cluster);
		expect(frozen.id).toStartWith("proposal-");
		expect(frozen.candidateIds).toEqual([recorded.id]);
		expect(frozen.intervention).toBeUndefined();

		const proposal = parseCorrectionProposal({
			proof: { kind: "existing_test", reason: "The routing suite covers this contract." },
			intervention: {
				action: "change",
				owner: "agents",
				scope: "global",
				exactChange: "Clarify the existing priority rule.",
				whyThisOwner: "It applies even when CX is off.",
			},
		});
		expect(proposal.intervention?.owner).toBe("agents");
		expect(() => parseCorrectionProposal({
			proof: { kind: "direct_observation", reason: "Observed." },
			intervention: {
				action: "add",
				owner: "memory",
				scope: "project",
				exactChange: "Remember it.",
				whyThisOwner: "It is a project preference.",
			},
		})).toThrow("targetProject");
	});

	test("keeps legacy applied outcomes terminal", () => {
		const recorded = candidate();
		const pattern = {
			id: "pattern-legacy",
			title: "Legacy proposal",
			summary: "A correction accepted by the previous format.",
			candidateIds: [recorded.id],
			disposition: "ready" as const,
			proof: { kind: "direct_observation" as const, reason: "Observed." },
			intervention: {
				action: "add" as const,
				owner: "memory" as const,
				scope: "global" as const,
				exactChange: "Remember it.",
				whyThisOwner: "It is a stable preference.",
			},
			reason: "Legacy evidence.",
		};
		const state = correctionState([
			{ type: "candidate_recorded", at: recorded.createdAt, candidate: recorded },
			{ type: "grouping_snapshot", at: recorded.createdAt, candidateIds: [recorded.id], patterns: [pattern] },
			{ type: "proposal_surfaced", at: recorded.createdAt, patternId: pattern.id },
			{ type: "proposal_decided", at: recorded.createdAt, patternId: pattern.id, decision: "accepted" },
			{ type: "proposal_outcome", at: recorded.createdAt, patternId: pattern.id, outcome: "applied", evidence: "Saved." },
		]);
		expect(state.candidates).toHaveLength(0);
		expect(state.allPatterns.map(({ id }) => id)).toContain(pattern.id);
	});

	test("keeps surfaced evidence stable until verification finishes", () => {
		const first = candidate();
		const second = { ...candidate(), id: "correction-second", source: { requestEntryId: "request-2", assistantEntryId: "answer-2", correctionEntryId: "correction-2" } };
		const cluster = parseGroupingOutput(JSON.stringify([{
			title: "Verify state",
			summary: "The agent used stale evidence.",
			candidateIds: [first.id],
			disposition: "ready",
			reason: "Repeated claims need direct checks.",
		}]), [first])[0]!;
		const frozen = freezeCorrectionPattern(cluster);
		const events = [
			{ type: "candidate_recorded", at: first.createdAt, candidate: first },
			{ type: "candidate_recorded", at: second.createdAt, candidate: second },
			{ type: "grouping_snapshot", at: first.createdAt, version: CORRECTION_GROUPING_VERSION, candidateIds: [first.id], patterns: [cluster] },
			{ type: "proposal_surfaced", at: first.createdAt, patternId: frozen.id, pattern: frozen },
		] as const;
		const surfaced = correctionState([...events]);
		expect(surfaced.patterns).toContainEqual(frozen);
		expect(surfaced.groupingCandidates.map(({ id }) => id)).toEqual([second.id]);

		const legacy = correctionState([...events, {
			type: "grouping_snapshot",
			at: second.createdAt,
			candidateIds: [first.id, second.id],
			patterns: [{ ...cluster, id: "pattern-written-by-old-session", candidateIds: [first.id, second.id] }],
		}]);
		expect(legacy.patterns.map(({ id }) => id)).toEqual([frozen.id]);
		expect(legacy.groupingCandidates.map(({ id }) => id)).toEqual([second.id]);

		const accepted = correctionState([...events, { type: "proposal_decided", at: first.createdAt, patternId: frozen.id, decision: "accepted" }]);
		expect(accepted.candidates.map(({ id }) => id)).toContain(first.id);
		expect(accepted.patterns.map(({ id }) => id)).toContain(frozen.id);

		const verified = correctionState([
			...events,
			{ type: "proposal_decided", at: first.createdAt, patternId: frozen.id, decision: "accepted" },
			{ type: "proposal_outcome", at: first.createdAt, patternId: frozen.id, outcome: "verified", evidence: "Focused proof passed." },
		]);
		expect(verified.candidates.map(({ id }) => id)).not.toContain(first.id);
		expect(verified.patterns.map(({ id }) => id)).not.toContain(frozen.id);
	});
});
