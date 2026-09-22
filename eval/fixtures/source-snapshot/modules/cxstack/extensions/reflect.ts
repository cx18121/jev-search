import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const cxstackRoot = fileURLToPath(new URL("../", import.meta.url));
const instructionsTemplate = readFileSync(
	fileURLToPath(new URL("../resources/reflect.md", import.meta.url)),
	"utf8",
)
	.replace("{{CXSTACK_ROOT}}", cxstackRoot)
	.trim();

export default function registerReflect(pi: ExtensionAPI) {
	let pendingInstructions: string | undefined;

	pi.on("before_agent_start", () => {
		if (!pendingInstructions) return undefined;
		const content = pendingInstructions;
		pendingInstructions = undefined;
		return {
			message: {
				customType: "reflect-instructions",
				content,
				display: false,
			},
		};
	});

	pi.on("session_shutdown", () => {
		pendingInstructions = undefined;
	});

	pi.registerCommand("reflect", {
		description: "Review this session for durable learning",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for Pi to finish, then retry /reflect.", "warning");
				return;
			}

			const sessionPath = ctx.sessionManager.getSessionFile() ?? "(ephemeral current conversation)";
			pendingInstructions = instructionsTemplate.replace("{{SESSION_PATH}}", sessionPath);
			const focus = args.trim()
				? `Reflect on this session.\n\nFocus:\n${args}`
				: "Reflect on this session.";
			pi.sendUserMessage(focus);
		},
	});
}
