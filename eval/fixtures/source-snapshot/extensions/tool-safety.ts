import {
	createBashToolDefinition,
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this command" })),
});

type BashInput = Static<typeof bashSchema>;

function resolvePath(path: string, cwd: string): string {
	let normalized = path.replace(unicodeSpaces, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return resolve(homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) return fileURLToPath(normalized);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function isAbort(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message === "Command aborted" || error.message.endsWith("\n\nCommand aborted");
}

export default function registerToolSafety(pi: ExtensionAPI) {
	let failedFingerprint: string | undefined;
	let consecutiveFailures = 0;

	const resetFailures = () => {
		failedFingerprint = undefined;
		consecutiveFailures = 0;
	};

	pi.on("agent_start", resetFailures);
	pi.on("session_start", resetFailures);
	pi.on("session_tree", resetFailures);

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command. Use cwd to run it from a specific working directory without an inline cd.",
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
			"Use the bash cwd field when a command targets a repository or directory other than the session working directory.",
		],
		parameters: bashSchema,
		async execute(toolCallId, params: BashInput, signal, onUpdate, ctx) {
			const commandCwd = params.cwd ? resolvePath(params.cwd, ctx.cwd) : ctx.cwd;
			const fingerprint = `${commandCwd}\0${params.command.trim()}`;

			if (failedFingerprint !== fingerprint) {
				failedFingerprint = fingerprint;
				consecutiveFailures = 0;
			}
			if (consecutiveFailures >= 2) {
				throw new Error(
					"Blocked a third consecutive identical failed bash command. Change the command or working directory, inspect the failure, or report the blocker.",
				);
			}

			const base = createBashToolDefinition(ctx.cwd, {
				spawnHook: (spawn) => ({ ...spawn, cwd: commandCwd }),
			});
			try {
				const result = await base.execute(
					toolCallId,
					{ command: params.command, timeout: params.timeout },
					signal,
					onUpdate,
					ctx,
				);
				resetFailures();
				return result;
			} catch (error) {
				if (!isAbort(error)) consecutiveFailures += 1;
				throw error;
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") resetFailures();
		if (!isToolCallEventType("write", event)) return;

		const target = resolvePath(event.input.path, ctx.cwd);
		try {
			if (!(await lstat(target)).isSymbolicLink()) return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}

		return {
			block: true,
			reason: `Refusing to write through symbolic link: ${event.input.path}. Remove or replace the link explicitly first.`,
		};
	});
}
