import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_MODE_ENTRY = "personal-fast-mode";
const FAST_MODE_STATUS = "fast-mode";
const PRIORITY_TIER = "priority";
const SUPPORTED_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

type FastModel = {
	provider: string;
	api: string;
	id: string;
};

type FastModeEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

export const supportsFastMode = (model: FastModel | undefined, usingOAuth: boolean) => {
	if (!model || !SUPPORTED_MODELS.has(model.id)) return false;

	const openAiApi = model.provider === "openai" && model.api === "openai-responses";
	const chatGpt = model.provider === "openai-codex" && model.api === "openai-codex-responses" && usingOAuth;
	return openAiApi || chatGpt;
};

export const addPriorityTier = (payload: unknown, modelId: string) => {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	if (!("model" in payload) || payload.model !== modelId || "service_tier" in payload) return undefined;

	return { ...payload, service_tier: PRIORITY_TIER };
};

export const restoreFastMode = (entries: readonly FastModeEntry[]) => {
	const entry = entries.findLast(
		(candidate) => candidate.type === "custom" && candidate.customType === FAST_MODE_ENTRY,
	);
	if (entry?.type !== "custom" || typeof entry.data !== "object" || entry.data === null || !("enabled" in entry.data)) {
		return false;
	}

	return entry.data.enabled === true;
};

export default function (pi: ExtensionAPI) {
	const sessionStates = new WeakMap<object, boolean>();
	const isEnabled = (ctx: ExtensionContext) => sessionStates.get(ctx.sessionManager) === true;
	const currentModelSupportsFastMode = (ctx: ExtensionContext) => {
		const { model } = ctx;
		return model !== undefined && supportsFastMode(model, ctx.modelRegistry.isUsingOAuth(model));
	};
	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const status = isEnabled(ctx) && currentModelSupportsFastMode(ctx)
			? ctx.ui.theme.fg("accent", "fast")
			: undefined;
		ctx.ui.setStatus(FAST_MODE_STATUS, status);
	};
	const restoreState = (ctx: ExtensionContext) => {
		sessionStates.set(ctx.sessionManager, restoreFastMode(ctx.sessionManager.getBranch()));
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(FAST_MODE_STATUS, undefined));

	pi.on("before_provider_request", (event, ctx) => {
		if (!isEnabled(ctx) || !currentModelSupportsFastMode(ctx) || !ctx.model) return undefined;
		return addPriorityTier(event.payload, ctx.model.id);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Fast mode",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "warning");
				return;
			}

			const enabled = !isEnabled(ctx);
			sessionStates.set(ctx.sessionManager, enabled);
			pi.appendEntry(FAST_MODE_ENTRY, { enabled });
			updateStatus(ctx);

			if (!enabled) {
				ctx.ui.notify("Fast mode off.", "info");
				return;
			}
			if (!currentModelSupportsFastMode(ctx)) {
				ctx.ui.notify("Fast mode is on but inactive for the current model or authentication method.", "warning");
				return;
			}

			const message = ctx.model?.provider === "openai-codex"
				? "Fast mode on. Increased ChatGPT usage applies."
				: "Fast mode on. OpenAI Priority pricing applies.";
			ctx.ui.notify(message, "info");
		},
	});
}
