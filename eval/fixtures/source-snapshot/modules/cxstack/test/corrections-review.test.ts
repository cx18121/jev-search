import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildCorrectionReviewGroups,
	CorrectionReviewComponent,
	type CorrectionReviewAction,
	type CorrectionReviewTheme,
} from "../components/corrections-review.ts";
import type {
	CorrectionCandidate,
	CorrectionPattern,
	CorrectionState,
} from "../lib/corrections.ts";

const candidate = (id: string, createdAt: string): CorrectionCandidate => ({
	id,
	sessionId: "session",
	project: "/workspace",
	source: { requestEntryId: "request", assistantEntryId: "answer", correctionEntryId: "correction" },
	category: "scope",
	agentDecision: "Expanded the requested work",
	userFeedback: "Keep this focused on the requested outcome.",
	expectedBehavior: "Preserve the requested scope.",
	strength: "strong",
	kernelVersion: "kernel",
	createdAt,
});

const readyPattern = (id: string, candidateId: string, title: string): CorrectionPattern => ({
	id,
	title,
	summary: "The agent expanded a bounded request.",
	candidateIds: [candidateId],
	disposition: "ready",
	proof: { kind: "existing_test", reason: "The routing suite covers the intended boundary." },
	intervention: {
		action: "change",
		owner: "cxstack",
		scope: "global",
		exactChange: "Keep direct work direct when no consequence trigger applies. Inspect the actual consequence before choosing a route. Remove duplicate process when the work remains local and reversible. Preserve the requested outcome while changing the method. State the proof boundary before reporting completion.",
		whyThisOwner: "CXStack owns route selection.",
	},
	reason: "The correction identifies a repeated routing mistake.",
});

function fixture(): CorrectionState {
	const candidates = [
		candidate("candidate-ready", "2026-08-29T10:00:00Z"),
		candidate("candidate-deferred", "2026-08-29T09:00:00Z"),
		candidate("candidate-watching", "2026-08-29T08:00:00Z"),
		candidate("candidate-history", "2026-08-29T07:00:00Z"),
	];
	const ready = readyPattern("pattern-ready", "candidate-ready", "Keep bounded work direct");
	const deferred = readyPattern("pattern-deferred", "candidate-deferred", "Inspect provider evidence first");
	const watching: CorrectionPattern = {
		id: "pattern-watching",
		title: "Possible wording preference",
		summary: "One weak correction may indicate a preference.",
		candidateIds: ["candidate-watching"],
		disposition: "hold",
		proof: { kind: "no_additional_proof", reason: "Wait for repeated evidence." },
		reason: "One weak occurrence does not justify a durable change.",
	};
	const history = readyPattern("pattern-history", "candidate-history", "Avoid stale package forks");
	return {
		candidates: candidates.slice(0, 3),
		groupingCandidates: candidates.slice(0, 3),
		patterns: [ready, deferred, watching],
		allCandidates: candidates,
		allPatterns: [ready, deferred, watching, history],
		decisions: new Map([
			["pattern-deferred", "deferred"],
			["pattern-history", "rejected"],
		]),
		outcomes: new Map(),
		surfaced: new Set(),
	};
}

const theme: CorrectionReviewTheme = {
	fg: (_color: Parameters<Theme["fg"]>[0], text: string) => text,
	bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
	bold: (text: string) => text,
};

const noBinding = () => false;

describe("correction review queue", () => {
	test("groups ready, deferred, watching, and historical proposals", () => {
		const groups = buildCorrectionReviewGroups(fixture());
		expect(groups.ready.map(({ pattern }) => pattern.id)).toEqual(["pattern-ready"]);
		expect(groups.deferred.map(({ pattern }) => pattern.id)).toEqual(["pattern-deferred"]);
		expect(groups.watching.map(({ pattern }) => pattern.id)).toEqual(["pattern-watching"]);
		expect(groups.history.map(({ pattern }) => pattern.id)).toEqual(["pattern-history"]);
		expect(groups.history[0]?.status).toBe("Rejected");
	});

	test("renders and scrolls the selected proposal within the available width", () => {
		const component = new CorrectionReviewComponent(
			buildCorrectionReviewGroups(fixture()),
			theme,
			() => {},
			(data, binding) => data === "page-down" && binding === "tui.select.pageDown",
			() => {},
			() => {},
		);
		const lines = component.render(120);
		expect(lines.join("\n")).toContain("Ready 1");
		expect(lines.join("\n")).toContain("Keep bounded work direct");
		expect(lines.join("\n")).toContain("Proposed change");
		expect(lines.join("\n")).toContain("0%");
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBeTrue();

		component.handleInput("page-down");
		const scrolled = component.render(120).join("\n");
		expect(scrolled).toContain("existing test");
		expect(scrolled).toContain("100%");
	});

	test("scrolls details, moves between proposals, and exposes simple actions", () => {
		const actions: CorrectionReviewAction[] = [];
		let closed = false;
		let renders = 0;
		const groups = buildCorrectionReviewGroups(fixture());
		const first = groups.ready[0];
		if (!first) throw new Error("Ready fixture is missing.");
		groups.ready.push({
			...first,
			pattern: { ...first.pattern, id: "pattern-second", title: "Second proposal" },
		});
		const component = new CorrectionReviewComponent(
			groups,
			theme,
			() => { renders++; },
			noBinding,
			(action) => actions.push(action),
			() => { closed = true; },
		);

		const beforeScroll = component.render(120).join("\n");
		component.handleInput("j");
		expect(component.render(120).join("\n")).not.toBe(beforeScroll);
		component.handleInput("l");
		expect(component.render(120).join("\n")).toContain("Second proposal");
		component.handleInput("e");
		expect(component.render(120).join("\n")).toContain("Keep this focused on the requested outcome.");
		component.handleInput("c");
		component.handleInput("a");
		expect(actions).toEqual([
			{ type: "discuss", patternId: "pattern-second" },
			{ type: "decide", patternId: "pattern-second", decision: "accepted" },
		]);
		component.handleInput("q");
		expect(closed).toBeTrue();
		expect(renders).toBe(3);
	});
});
