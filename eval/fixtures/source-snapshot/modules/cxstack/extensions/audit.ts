import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	selectCxAuditSessions,
	type CxAuditSessionSource,
} from "../lib/audit.js";
import { cxContentVersion, renderCxKernel } from "../lib/cx.js";

const cxstackRoot = fileURLToPath(new URL("../", import.meta.url));
const resourceRoot = fileURLToPath(new URL("../resources", import.meta.url));
const kernel = renderCxKernel(
	readFileSync(join(resourceRoot, "kernel.md"), "utf8"),
	resourceRoot,
);
const currentKernelVersion = cxContentVersion(kernel);
const instructions = readFileSync(join(resourceRoot, "audit.md"), "utf8").trim();

type AuditDependencies = {
	listSessions: () => Promise<readonly CxAuditSessionSource[]>;
	readSession: (path: string) => string;
};

const defaultDependencies: AuditDependencies = {
	listSessions: () => SessionManager.listAll(),
	readSession: (path) => readFileSync(path, "utf8"),
};

const renderInstructions = (manifest: unknown) =>
	instructions
		.replace("{{CXSTACK_ROOT}}", cxstackRoot)
		.replace("{{SESSION_MANIFEST}}", JSON.stringify(manifest, null, 2));

export default function registerCxAudit(
	pi: ExtensionAPI,
	dependencies: AuditDependencies = defaultDependencies,
) {
	let pendingInstructions: string | undefined;

	pi.on("before_agent_start", () => {
		if (pendingInstructions === undefined) return undefined;
		const content = pendingInstructions;
		pendingInstructions = undefined;
		return {
			message: {
				customType: "cx-audit-instructions",
				content,
				display: false,
			},
		};
	});

	pi.on("session_shutdown", () => {
		pendingInstructions = undefined;
	});

	pi.registerCommand("cx-audit", {
		description: "Review recent CX sessions for evidence-backed improvements",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for Pi to finish, then retry /cx-audit.", "warning");
				return;
			}

			try {
				const unreadableSessionIds: string[] = [];
				const sessions = selectCxAuditSessions(
					await dependencies.listSessions(),
					ctx.sessionManager.getSessionFile(),
					dependencies.readSession,
					currentKernelVersion,
					(session) => unreadableSessionIds.push(session.id),
				);
				if (unreadableSessionIds.length > 0) {
					ctx.ui.notify(
						`CX audit skipped ${unreadableSessionIds.length} unreadable session${unreadableSessionIds.length === 1 ? "" : "s"}.`,
						"warning",
					);
				}
				if (sessions.length === 0) {
					ctx.ui.notify("No earlier CX sessions are available to audit.", "info");
					return;
				}

				pendingInstructions = renderInstructions(sessions);
				pi.sendUserMessage("Audit the recent CXStack sessions in the supplied manifest.");
			} catch (error) {
				ctx.ui.notify(
					`CX audit could not read recent sessions: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		},
	});
}
