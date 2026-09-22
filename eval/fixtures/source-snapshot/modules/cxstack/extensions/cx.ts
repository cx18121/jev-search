import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyCxCommand,
	clearPendingDirective,
	CX_ACTIVE_MESSAGE,
	cxContentVersion,
	cxDirectiveContent,
	CX_INACTIVE_MESSAGE,
	CX_MARKER,
	CX_REFERENCE_ENTRY,
	CX_STATE_ENTRY,
	decideCxCommand,
	emptyCxState,
	refreshPendingDirective,
	renderCxKernel,
	restoreCxState,
	restoreCxStateFile,
	shouldActivateCxByDefault,
	takeBeforeAgentDirective,
	type CxDirective,
} from "../lib/cx.js";

const resourceRoot = fileURLToPath(new URL("../resources", import.meta.url));
const referencesRoot = join(resourceRoot, "references");
const kernelSource = readFileSync(join(resourceRoot, "kernel.md"), "utf8");
const kernel = renderCxKernel(kernelSource, resourceRoot);
const kernelVersion = cxContentVersion(kernel);

const referenceFiles = (directory: string): string[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return referenceFiles(path);
		return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
	});

const references = new Map(
	referenceFiles(referencesRoot).map((path) => {
		const content = readFileSync(path, "utf8");
		return [
			resolve(path),
			{
				reference: relative(referencesRoot, path).replace(/\.md$/, ""),
				version: cxContentVersion(content),
				lines: content.split("\n").length,
			},
		];
	}),
);

const stateEntryData = (active: boolean) =>
	active ? { active, version: kernelVersion } : { active };

const directiveMessage = (directive: CxDirective) => ({
	customType: directive === "active" ? CX_ACTIVE_MESSAGE : CX_INACTIVE_MESSAGE,
	content: cxDirectiveContent(directive, kernel),
	display: false,
	details: { directive },
});

const syncStatus = (ctx: ExtensionContext, active: boolean) => {
	ctx.ui.setStatus("cx-mode", active ? ctx.ui.theme.fg("accent", "CX") : undefined);
};

export default function registerCx(pi: ExtensionAPI) {
	let state = emptyCxState();

	const activateByDefault = () => {
		state = {
			active: true,
			hasState: true,
			version: kernelVersion,
			pending: "active",
		};
		pi.appendEntry(CX_STATE_ENTRY, stateEntryData(true));
	};

	const restoreCurrentSession = (ctx: ExtensionContext) => {
		const restored = restoreCxState(ctx.sessionManager.getEntries());
		if (restored.active && restored.version !== kernelVersion) {
			pi.appendEntry(CX_STATE_ENTRY, stateEntryData(true));
		}
		state = refreshPendingDirective(
			restored,
			ctx.sessionManager.buildContextEntries(),
			kernelVersion,
		);
	};

	pi.on("session_start", (event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		if (shouldActivateCxByDefault(event.reason, restoreCxState(entries), entries)) {
			activateByDefault();
			syncStatus(ctx, state.active);
			return;
		}

		if (event.reason === "fork" && event.previousSessionFile) {
			try {
				state = restoreCxStateFile(readFileSync(event.previousSessionFile, "utf8"));
			} catch (error) {
				ctx.ui.notify(
					`CX could not read the source session state: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				state = restoreCxState(ctx.sessionManager.getEntries());
			}
			if (state.hasState) pi.appendEntry(CX_STATE_ENTRY, stateEntryData(state.active));
			state = refreshPendingDirective(
				state,
				ctx.sessionManager.buildContextEntries(),
				kernelVersion,
			);
			syncStatus(ctx, state.active);
			return;
		}

		restoreCurrentSession(ctx);
		syncStatus(ctx, state.active);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreCurrentSession(ctx);
		syncStatus(ctx, state.active);
	});

	pi.on("before_agent_start", (event) => {
		const next = takeBeforeAgentDirective(state);
		state = next.state;
		if (next.directive) return { message: directiveMessage(next.directive) };
		if (next.marker) return { systemPrompt: `${event.systemPrompt}\n\n${CX_MARKER}` };
		return undefined;
	});

	pi.on("session_compact", (event, ctx) => {
		state = refreshPendingDirective(
			state,
			ctx.sessionManager.buildContextEntries(),
			kernelVersion,
		);
		const directive = state.pending;
		if (!directive) return;

		state = clearPendingDirective(state);
		if (event.willRetry) {
			pi.sendMessage(directiveMessage(directive), { deliverAs: "steer" });
			return;
		}
		pi.sendMessage(directiveMessage(directive), { triggerTurn: false });
	});

	pi.on("tool_result", (event, ctx) => {
		if (!state.active || event.toolName !== "read" || event.isError) return;
		const path = event.input.path;
		if (typeof path !== "string") return;
		const reference = references.get(resolve(ctx.cwd, path.replace(/^@/, "")));
		if (reference === undefined) return;
		const offset = event.input.offset;
		const limit = event.input.limit;
		const startsAtBeginning = offset === undefined || offset === 1;
		const reachesEnd = limit === undefined || (typeof limit === "number" && limit >= reference.lines);
		if (!startsAtBeginning || !reachesEnd) return;
		pi.appendEntry(CX_REFERENCE_ENTRY, {
			reference: reference.reference,
			version: reference.version,
		});
	});

	pi.on("session_shutdown", () => {
		state = emptyCxState();
	});

	pi.registerCommand("cx", {
		description: "Activate or deactivate CXStack",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for Pi to finish, then retry /cx.", "warning");
				return;
			}

			const decision = decideCxCommand(state, args, true);
			state = applyCxCommand(state, decision);
			if (decision.kind === "activate" || decision.kind === "activate-task") {
				state = { ...state, version: kernelVersion };
			}
			syncStatus(ctx, state.active);

			if (decision.kind === "noop-active") {
				ctx.ui.notify("CX is already active.", "info");
				return;
			}
			if (decision.kind === "noop-inactive") {
				ctx.ui.notify("CX is already inactive.", "info");
				return;
			}
			if (decision.kind === "deactivate") {
				pi.appendEntry(CX_STATE_ENTRY, stateEntryData(false));
				pi.sendMessage(directiveMessage("inactive"), { triggerTurn: false });
				ctx.ui.notify("CX off.", "info");
				return;
			}
			if (decision.kind === "activate" || decision.kind === "activate-task") {
				pi.appendEntry(CX_STATE_ENTRY, stateEntryData(true));
			}
			if (decision.kind === "activate") {
				ctx.ui.notify("CX active.", "info");
				return;
			}
			if (decision.kind === "activate-task" || decision.kind === "task") {
				ctx.ui.notify("CX active.", "info");
				pi.sendUserMessage(decision.task);
			}
		},
	});
}
