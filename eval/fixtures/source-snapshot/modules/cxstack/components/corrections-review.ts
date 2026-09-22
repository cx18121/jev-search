import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	CorrectionCandidate,
	CorrectionPattern,
	CorrectionState,
} from "../lib/corrections.js";

export const correctionReviewSections = ["ready", "deferred", "watching", "history"] as const;

export type CorrectionReviewSection = (typeof correctionReviewSections)[number];
export type CorrectionReviewDecision = "accepted" | "rejected" | "deferred";
export type CorrectionReviewAction =
	| { type: "decide"; patternId: string; decision: CorrectionReviewDecision }
	| { type: "discuss"; patternId: string };

export type CorrectionReviewItem = {
	pattern: CorrectionPattern;
	candidates: CorrectionCandidate[];
	status: string;
	target: string;
};

export type CorrectionReviewGroups = Record<CorrectionReviewSection, CorrectionReviewItem[]>;
export type CorrectionReviewTheme = Pick<Theme, "fg" | "bg" | "bold">;

type ReviewKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.cancel";

const viewportHeight = 15;

function words(value: string) {
	return value.replaceAll("_", " ");
}

function patternTarget(pattern: CorrectionPattern) {
	if (pattern.intervention) {
		const project = pattern.intervention.targetProject ? ` · ${pattern.intervention.targetProject}` : "";
		return `${pattern.intervention.scope} ${words(pattern.intervention.owner)}${project}`;
	}
	return pattern.eval ? "evaluation" : "inspection needed";
}

function patternTimestamp(pattern: CorrectionPattern, candidates: Map<string, CorrectionCandidate>) {
	return Math.max(
		0,
		...pattern.candidateIds.map((id) => Date.parse(candidates.get(id)?.createdAt ?? "") || 0),
	);
}

function itemFor(pattern: CorrectionPattern, state: CorrectionState, candidates: Map<string, CorrectionCandidate>): CorrectionReviewItem {
	const decision = state.decisions.get(pattern.id);
	const outcome = state.outcomes.get(pattern.id);
	const status = decision === "accepted"
		? outcome === "applied" || outcome === "verified"
			? "Verified"
			: outcome === "rejected_by_proof"
				? "Proof failed"
				: "Accepted"
		: decision === "rejected"
			? "Rejected"
			: decision === "already_fixed"
				? "Already fixed"
				: decision === "duplicate"
					? "Duplicate"
					: decision === "deferred"
						? "Deferred"
						: pattern.disposition === "ready"
							? "Ready"
							: pattern.disposition === "hold"
								? "Watching"
								: "One-off";
	return {
		pattern,
		candidates: pattern.candidateIds.flatMap((id) => {
			const candidate = candidates.get(id);
			return candidate ? [candidate] : [];
		}),
		status,
		target: patternTarget(pattern),
	};
}

export function buildCorrectionReviewGroups(state: CorrectionState): CorrectionReviewGroups {
	const candidates = new Map(state.allCandidates.map((candidate) => [candidate.id, candidate]));
	const recentFirst = (patterns: CorrectionPattern[]) => [...patterns]
		.sort((left, right) => patternTimestamp(right, candidates) - patternTimestamp(left, candidates));
	const active = recentFirst(state.patterns);
	const history = recentFirst(state.allPatterns.filter((pattern) => {
		const decision = state.decisions.get(pattern.id);
		if (decision === "rejected" || decision === "already_fixed" || decision === "duplicate") return true;
		return decision === "accepted" && ["applied", "verified"].includes(state.outcomes.get(pattern.id) ?? "");
	}));
	return {
		ready: active
			.filter((pattern) => pattern.disposition === "ready" && state.decisions.get(pattern.id) !== "deferred")
			.map((pattern) => itemFor(pattern, state, candidates)),
		deferred: active
			.filter((pattern) => state.decisions.get(pattern.id) === "deferred")
			.map((pattern) => itemFor(pattern, state, candidates)),
		watching: active
			.filter((pattern) => pattern.disposition !== "ready" && state.decisions.get(pattern.id) !== "deferred")
			.map((pattern) => itemFor(pattern, state, candidates)),
		history: history.map((pattern) => itemFor(pattern, state, candidates)),
	};
}

function pad(text: string, width: number) {
	return truncateToWidth(text, Math.max(1, width), "…", true);
}

function wrapped(theme: CorrectionReviewTheme, text: string, width: number, color: "text" | "muted" = "text") {
	return wrapTextWithAnsi(theme.fg(color, text), Math.max(1, width));
}

function proposalLines(theme: CorrectionReviewTheme, item: CorrectionReviewItem | undefined, width: number, showEvidence: boolean) {
	if (!item) return [theme.fg("muted", "No proposals in this queue.")];
	const lines: string[] = [
		theme.bold(theme.fg("accent", item.pattern.title)),
		theme.fg("muted", `${item.status} · ${item.candidates.length} correction candidate${item.candidates.length === 1 ? "" : "s"} · ${item.target}`),
		"",
	];
	const addBlock = (label: string, value: string) => {
		if (!value) return;
		if (lines.at(-1) !== "") lines.push("");
		lines.push(theme.bold(theme.fg("accent", label)));
		lines.push(...wrapped(theme, value, width));
	};

	if (showEvidence) {
		const evidence = item.candidates.flatMap((candidate, index) => [
			`${index + 1}. Agent decision: ${candidate.agentDecision}`,
			`Feedback: ${candidate.userFeedback}`,
			`Expected: ${candidate.expectedBehavior}`,
		]);
		addBlock("Evidence", evidence.length > 0 ? evidence.join("\n") : "The original correction evidence is no longer active.");
		return lines;
	}

	addBlock("Summary", item.pattern.summary);
	if (item.pattern.relatedPatternId) addBlock("Related item", item.pattern.relatedPatternId);
	if (item.pattern.readiness) {
		addBlock("Uncovered gap", item.pattern.readiness.gap);
		addBlock("Worth changing", item.pattern.readiness.benefit);
	}
	addBlock(
		item.pattern.intervention || item.pattern.eval ? "Proposed change" : "Next step",
		item.pattern.intervention?.exactChange
			?? item.pattern.eval?.expectedBehavior
			?? "Discuss this evidence so a tool-using agent can inspect the current owner and prepare an exact proposal.",
	);
	if (item.pattern.intervention) addBlock("Why this destination", item.pattern.intervention.whyThisOwner);
	if (item.pattern.proof) addBlock("Proof", `${words(item.pattern.proof.kind)}. ${item.pattern.proof.reason}`);
	return lines;
}

export class CorrectionReviewComponent implements Component {
	private sectionIndex = 0;
	private readonly selected: Record<CorrectionReviewSection, number> = {
		ready: 0,
		deferred: 0,
		watching: 0,
		history: 0,
	};
	private showEvidence = false;
	private scroll = 0;
	private maxScroll = 0;

	constructor(
		private readonly groups: CorrectionReviewGroups,
		private readonly theme: CorrectionReviewTheme,
		private readonly requestRender: () => void,
		private readonly matchesBinding: (data: string, binding: ReviewKeybinding) => boolean,
		private readonly onAction: (action: CorrectionReviewAction) => void,
		private readonly onClose: () => void,
	) {}

	private get section() {
		return correctionReviewSections[this.sectionIndex] ?? "ready";
	}

	private get items() {
		return this.groups[this.section];
	}

	private get selectedItem() {
		return this.items[this.selected[this.section]];
	}

	private resetView() {
		this.showEvidence = false;
		this.scroll = 0;
		this.maxScroll = 0;
		this.requestRender();
	}

	private moveProposal(delta: number) {
		if (this.items.length === 0) return;
		this.selected[this.section] = Math.max(0, Math.min(this.items.length - 1, this.selected[this.section] + delta));
		this.resetView();
	}

	private moveSection() {
		this.sectionIndex = (this.sectionIndex + 1) % correctionReviewSections.length;
		this.resetView();
	}

	private moveScroll(delta: number) {
		this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
		this.requestRender();
	}

	private decide(decision: CorrectionReviewDecision) {
		const item = this.selectedItem;
		if (!item || (this.section !== "ready" && this.section !== "deferred")) return;
		if (item.status === "Accepted") return;
		if (decision === "accepted" && !item.pattern.intervention && !item.pattern.eval) return;
		if (decision === "deferred" && this.section === "deferred") return;
		this.onAction({ type: "decide", patternId: item.pattern.id, decision });
	}

	handleInput(data: string) {
		if (this.matchesBinding(data, "tui.select.cancel") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.moveSection();
			return;
		}
		if (matchesKey(data, Key.left) || data === "h") {
			this.moveProposal(-1);
			return;
		}
		if (matchesKey(data, Key.right) || data === "l") {
			this.moveProposal(1);
			return;
		}
		if (this.matchesBinding(data, "tui.select.up") || data === "k") {
			this.moveScroll(-1);
			return;
		}
		if (this.matchesBinding(data, "tui.select.down") || data === "j") {
			this.moveScroll(1);
			return;
		}
		if (this.matchesBinding(data, "tui.select.pageUp")) {
			this.moveScroll(-viewportHeight);
			return;
		}
		if (this.matchesBinding(data, "tui.select.pageDown")) {
			this.moveScroll(viewportHeight);
			return;
		}
		if (data === "e") {
			if (this.selectedItem) {
				this.showEvidence = !this.showEvidence;
				this.scroll = 0;
				this.requestRender();
			}
			return;
		}
		if (data === "c" && this.selectedItem) {
			this.onAction({ type: "discuss", patternId: this.selectedItem.pattern.id });
			return;
		}
		if (data === "a") this.decide("accepted");
		if (data === "r") this.decide("rejected");
		if (data === "d") this.decide("deferred");
	}

	render(width: number) {
		if (width < 24) return [truncateToWidth("Corrections · Esc return", width)];
		const contentWidth = width - 2;
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const divider = (text: string) => this.theme.fg("borderMuted", text);
		const position = this.items.length > 0 ? `${this.selected[this.section] + 1} of ${this.items.length}` : "empty";
		const tabs = correctionReviewSections.map((section) => {
			const label = section === this.section
				? `${section[0]?.toUpperCase() ?? ""}${section.slice(1)} ${position}`
				: `${section[0]?.toUpperCase() ?? ""}${section.slice(1)} ${this.groups[section].length}`;
			return section === this.section
				? this.theme.bold(this.theme.fg("accent", label))
				: this.theme.fg("dim", label);
		}).join(this.theme.fg("borderMuted", "  ·  "));
		const header = pad(` Corrections  ${tabs} `, width);
		const lines = proposalLines(this.theme, this.selectedItem, contentWidth, this.showEvidence);
		this.maxScroll = Math.max(0, lines.length - viewportHeight);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + viewportHeight);
		const progress = this.maxScroll === 0 ? "100%" : `${Math.round((this.scroll / this.maxScroll) * 100)}%`;
		const body = Array.from({ length: viewportHeight }, (_, index) => pad(`  ${visible[index] ?? ""}`, width));
		const rule = divider("─".repeat(width));
		const actionable = (this.section === "ready" || this.section === "deferred") && this.selectedItem?.status !== "Accepted";
		const navigation = pad(` ↑↓ scroll · ←→ previous/next · Tab queue · e evidence · c discuss${" ".repeat(4)}${progress} `, width);
		const canAccept = Boolean(this.selectedItem?.pattern.intervention || this.selectedItem?.pattern.eval);
		const decisions = actionable
			? this.section === "ready"
				? ` ${canAccept ? "a accept · " : ""}r reject · d defer · Esc/q return `
				: ` ${canAccept ? "a accept · " : ""}r reject · Esc/q return `
			: " c discuss · Esc/q return ";
		return [
			border("─".repeat(width)),
			header,
			rule,
			...body,
			rule,
			navigation,
			pad(decisions, width),
			border("─".repeat(width)),
		];
	}

	invalidate() {}
}
