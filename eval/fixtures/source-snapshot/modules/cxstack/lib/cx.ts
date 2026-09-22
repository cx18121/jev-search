import { createHash } from "node:crypto";

export const CX_STATE_ENTRY = "cx-state";
export const CX_REFERENCE_ENTRY = "cx-reference";
export const CX_ACTIVE_MESSAGE = "cx-active";
export const CX_INACTIVE_MESSAGE = "cx-inactive";
export const CX_MARKER =
	"CX is active. Match the task: stay direct when clear; load rigor only when it earns its cost.";
export const CX_INACTIVE_CONTENT =
	"CX is inactive. Ignore every earlier CX kernel and marker instruction in this session unless a later CX activation message appears.";

export const cxContentVersion = (content: string) =>
	createHash("sha256").update(content).digest("hex").slice(0, 12);

export type CxDirective = "active" | "inactive";
export type CxSessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export type CxRuntimeState = {
	active: boolean;
	hasState: boolean;
	version?: string;
	pending?: CxDirective;
};

export type CxEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

export type CxCommandDecision =
	| { kind: "busy" }
	| { kind: "activate" }
	| { kind: "activate-task"; task: string }
	| { kind: "deactivate" }
	| { kind: "task"; task: string }
	| { kind: "noop-active" }
	| { kind: "noop-inactive" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stateValue = (entry: CxEntry) => {
	if (entry.type !== "custom" || entry.customType !== CX_STATE_ENTRY || !isRecord(entry.data)) {
		return undefined;
	}
	if (typeof entry.data.active !== "boolean") return undefined;
	return {
		active: entry.data.active,
		version: typeof entry.data.version === "string" ? entry.data.version : undefined,
	};
};

export const emptyCxState = (): CxRuntimeState => ({
	active: false,
	hasState: false,
});

export const shouldActivateCxByDefault = (
	reason: CxSessionStartReason,
	state: CxRuntimeState,
	entries: readonly CxEntry[],
) =>
	reason === "new" ||
	(reason !== "fork" &&
		!state.hasState &&
		!entries.some((entry) => entry.type === "message"));

export const restoreCxState = (entries: readonly CxEntry[]): CxRuntimeState => {
	const value = entries.map(stateValue).findLast((item) => item !== undefined);
	return value === undefined
		? emptyCxState()
		: {
				active: value.active,
				hasState: true,
				...(value.active && value.version !== undefined ? { version: value.version } : {}),
			};
};

export const restoreCxStateFile = (content: string) => {
	const entries = content
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line): CxEntry[] => {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				return [];
			}
			if (!isRecord(value) || typeof value.type !== "string") return [];

			return [
				{
					type: value.type,
					...(typeof value.customType === "string" ? { customType: value.customType } : {}),
					...("data" in value ? { data: value.data } : {}),
				},
			];
		});

	return restoreCxState(entries);
};

export const expectedCxDirective = (state: CxRuntimeState): CxDirective | undefined => {
	if (state.active) return "active";
	return state.hasState ? "inactive" : undefined;
};

const directiveValue = (entry: CxEntry): CxDirective | undefined => {
	if (entry.type !== "custom_message") return undefined;
	if (entry.customType === CX_ACTIVE_MESSAGE) return "active";
	if (entry.customType === CX_INACTIVE_MESSAGE) return "inactive";
	return undefined;
};

export const latestCxDirective = (entries: readonly CxEntry[]): CxDirective | undefined =>
	entries.map(directiveValue).findLast((directive) => directive !== undefined);

const latestDirectiveEntry = (entries: readonly CxEntry[]) =>
	entries.findLast((entry) => directiveValue(entry) !== undefined);

const directiveMatches = (entry: CxEntry | undefined, expected: CxDirective) =>
	entry !== undefined && directiveValue(entry) === expected;

export const refreshPendingDirective = (
	state: CxRuntimeState,
	contextEntries: readonly CxEntry[],
	activeVersion?: string,
): CxRuntimeState => {
	const expected = expectedCxDirective(state);
	const versionChanged =
		state.active && activeVersion !== undefined && state.version !== activeVersion;
	return {
		...state,
		...(state.active && activeVersion !== undefined ? { version: activeVersion } : {}),
		pending:
			expected !== undefined &&
			(versionChanged || !directiveMatches(latestDirectiveEntry(contextEntries), expected))
				? expected
				: undefined,
	};
};

export const decideCxCommand = (
	state: CxRuntimeState,
	args: string,
	idle: boolean,
): CxCommandDecision => {
	if (!idle) return { kind: "busy" };

	const command = args.trim();
	if (command === "off") {
		return state.active ? { kind: "deactivate" } : { kind: "noop-inactive" };
	}
	if (!command) {
		return state.active ? { kind: "noop-active" } : { kind: "activate" };
	}
	return state.active
		? { kind: "task", task: args }
		: { kind: "activate-task", task: args };
};

export const applyCxCommand = (
	state: CxRuntimeState,
	decision: CxCommandDecision,
): CxRuntimeState => {
	if (decision.kind === "activate" || decision.kind === "activate-task") {
		return { active: true, hasState: true, pending: "active" };
	}
	if (decision.kind === "deactivate") {
		return { active: false, hasState: true };
	}
	return state;
};

export const takeBeforeAgentDirective = (state: CxRuntimeState) => {
	if (state.pending !== undefined) {
		return {
			state: { ...state, pending: undefined },
			directive: state.pending,
			marker: false,
		};
	}

	return {
		state,
		directive: undefined,
		marker: state.active,
	};
};

export const clearPendingDirective = (state: CxRuntimeState): CxRuntimeState => ({
	...state,
	pending: undefined,
});

export const renderCxKernel = (content: string, resourceRoot: string) =>
	content.trim().replaceAll("(references/", `(${resourceRoot}/references/`);

export const cxDirectiveContent = (directive: CxDirective, kernel: string) =>
	directive === "active" ? kernel : CX_INACTIVE_CONTENT;
