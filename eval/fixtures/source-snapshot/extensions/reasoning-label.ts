import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerReasoningLabel(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setHiddenThinkingLabel("Reasoning hidden");
	});
}
