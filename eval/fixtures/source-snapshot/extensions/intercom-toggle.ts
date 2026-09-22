import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerIntercom from "pi-intercom";
import { fileURLToPath } from "node:url";

const INTERCOM_ENABLED_ENV = "PI_INTERCOM_SESSION_ENABLED";
const intercomSkillsPath = fileURLToPath(new URL("../node_modules/pi-intercom/skills", import.meta.url));

type ToggleDependencies = {
	registerIntercom: typeof registerIntercom;
};

const defaults: ToggleDependencies = { registerIntercom };

function enabled() {
	return process.env[INTERCOM_ENABLED_ENV] === "1";
}

export default function registerIntercomToggle(pi: ExtensionAPI, dependencies: ToggleDependencies = defaults) {
	if (enabled()) {
		dependencies.registerIntercom(pi);
		pi.on("resources_discover", () => ({ skillPaths: [intercomSkillsPath] }));
	}

	pi.registerCommand("intercom-on", {
		description: "Enable intercom for this session",
		handler: async (_args, ctx) => {
			if (enabled()) {
				ctx.ui.notify("Intercom is already enabled for this session.", "info");
				return;
			}
			process.env[INTERCOM_ENABLED_ENV] = "1";
			await ctx.reload();
		},
	});

	pi.registerCommand("intercom-off", {
		description: "Disable intercom for this session",
		handler: async (_args, ctx) => {
			if (!enabled()) {
				ctx.ui.notify("Intercom is already disabled for this session.", "info");
				return;
			}
			delete process.env[INTERCOM_ENABLED_ENV];
			await ctx.reload();
		},
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload") {
			delete process.env[INTERCOM_ENABLED_ENV];
		}
	});
}
