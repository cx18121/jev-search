import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export default function (pi: ExtensionAPI) {
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), {
		projectTrusted: false,
	});

	async function flushSettings(): Promise<void> {
		await settings.flush();

		const error = settings.drainErrors().at(0);
		if (error) {
			throw error.error;
		}
	}

	async function rememberSelection(
		provider: string,
		modelId: string,
		thinkingLevel: ThinkingLevel | undefined,
	): Promise<void> {
		settings.setDefaultModelAndProvider(provider, modelId);

		if (thinkingLevel) {
			settings.setDefaultThinkingLevel(thinkingLevel);
		}

		await flushSettings();
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.model) {
			return;
		}

		await rememberSelection(ctx.model.provider, ctx.model.id, ctx.thinkingLevel);
	});

	pi.on("model_select", async (event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		await rememberSelection(event.model.provider, event.model.id, ctx.thinkingLevel);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		settings.setDefaultThinkingLevel(event.level);
		await flushSettings();
	});
}
