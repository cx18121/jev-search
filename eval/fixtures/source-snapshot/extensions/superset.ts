import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const hasSupersetContext = () =>
	Boolean(process.env.SUPERSET_TERMINAL_ID || process.env.SUPERSET_TAB_ID);

const getNotifyScript = () =>
	join(process.env.SUPERSET_HOME_DIR ?? join(homedir(), ".superset"), "hooks", "notify.sh");

const getSessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

export default function (pi: ExtensionAPI) {
	if (!hasSupersetContext()) {
		return;
	}

	const notifyScript = getNotifyScript();
	if (!existsSync(notifyScript)) {
		return;
	}

	const notify = (eventName: string, sessionId?: string) => {
		const child = spawn(notifyScript, [], {
			stdio: ["pipe", "ignore", "ignore"],
			detached: true,
			env: { ...process.env, SUPERSET_AGENT_ID: "pi" },
		});

		child.on("error", () => undefined);
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(JSON.stringify({
			hook_event_name: eventName,
			session_id: sessionId,
		}));
		child.unref();
	};

	const isInteractive = (ctx: ExtensionContext) => ctx.mode === "tui";

	pi.on("session_start", (_event, ctx) => {
		if (!isInteractive(ctx)) {
			return;
		}

		notify("SessionStart", getSessionId(ctx));
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!isInteractive(ctx)) {
			return;
		}

		notify("UserPromptSubmit", getSessionId(ctx));
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!isInteractive(ctx) || event.toolName !== "ask_user_question") {
			return;
		}

		notify("PermissionRequest", getSessionId(ctx));
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (!isInteractive(ctx)) {
			return;
		}

		notify("PostToolUse", getSessionId(ctx));
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isInteractive(ctx) || !ctx.isIdle()) {
			return;
		}

		notify("Stop", getSessionId(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!isInteractive(ctx)) {
			return;
		}

		notify("SessionEnd", getSessionId(ctx));
	});
}
