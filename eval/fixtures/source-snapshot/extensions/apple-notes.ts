import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/apple-notes.js");

export default function (pi: ExtensionAPI) {
	const runNotes = async (request: object, signal?: AbortSignal) => {
		const result = await pi.exec("osascript", [
			"-l",
			"JavaScript",
			scriptPath,
			JSON.stringify(request),
		], { signal, timeout: 60_000 });

		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || "Apple Notes automation failed.");
		}

		return JSON.parse(result.stdout);
	};

	const toolResult = (value: unknown) => ({
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }] satisfies TextContent[],
		details: value,
	});

	pi.registerCommand("note", {
		description: "Save text to the Pi Inbox in Apple Notes",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /note <text>", "warning");
				return;
			}

			await runNotes({ operation: "inbox", text });
			ctx.ui.notify("Saved to Apple Notes · Pi/Inbox", "info");
		},
	});

	pi.registerTool({
		name: "notes_search",
		label: "Search Apple Notes",
		description: "Search titles and plaintext across every Apple Notes account and folder. Use only when the user asks to find or retrieve their notes. Returns identifiers, locations, dates, and short matching snippets.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Text to find in note titles or contents" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum matches, default 20" })),
		}),
		execute: async (_id, params, signal) => toolResult(await runNotes({
			operation: "search",
			query: params.query,
			limit: params.limit,
		}, signal)),
	});

	pi.registerTool({
		name: "notes_list",
		label: "List Apple Notes",
		description: "List recent Apple Notes metadata across all accounts and folders. Use only when the user asks to browse their notes. Optionally filter by exact account name or partial folder path.",
		parameters: Type.Object({
			account: Type.Optional(Type.String({ description: "Exact Apple Notes account name" })),
			folder: Type.Optional(Type.String({ description: "Text contained in the folder path" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum notes, default 50" })),
		}),
		execute: async (_id, params, signal) => toolResult(await runNotes({
			operation: "list",
			account: params.account,
			folder: params.folder,
			limit: params.limit,
		}, signal)),
	});

	pi.registerTool({
		name: "notes_read",
		label: "Read Apple Note",
		description: "Read plaintext and attachment metadata from one Apple Note returned by notes_search or notes_list. Password-protected notes return metadata only.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: "Exact Apple Note identifier" }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset, default 0" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000, description: "Maximum characters, default 12000" })),
		}),
		execute: async (_id, params, signal) => toolResult(await runNotes({
			operation: "read",
			id: params.id,
			offset: params.offset,
			limit: params.limit,
		}, signal)),
	});

	pi.registerTool({
		name: "notes_save",
		label: "Save to Apple Notes",
		description: "Save a simple entry to Pi/Inbox when the user explicitly asks. Use the same natural format a person would type in Apple Notes: a short title followed by normal prose or up to six concise bullets. Do not add dates, metadata, or labels. Preserve exact wording when the user requests verbatim text.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, description: "Short descriptive entry title" }),
			text: Type.Optional(Type.String({ description: "Short prose or verbatim text when bullets are unsuitable" })),
			bullets: Type.Optional(Type.Array(
				Type.String({ minLength: 1 }),
				{ minItems: 1, maxItems: 6, description: "Concise facts, decisions, or next steps" },
			)),
		}),
		execute: async (_id, params, signal) => toolResult(await runNotes({
			operation: "inbox",
			title: params.title,
			text: params.text,
			bullets: params.bullets,
		}, signal)),
	});

	pi.registerTool({
		name: "notes_create",
		label: "Create Apple Note",
		description: "Create an Apple Note when the user explicitly asks to save new information. Defaults to the Pi folder in the default Notes account. Missing top-level folders are created.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, description: "Note title" }),
			content: Type.Optional(Type.String({ description: "Initial plaintext content" })),
			account: Type.Optional(Type.String({ description: "Exact account name, otherwise the default account" })),
			folder: Type.Optional(Type.String({ description: "Top-level folder name, default Pi" })),
		}),
		execute: async (_id, params, signal) => toolResult(await runNotes({
			operation: "create",
			title: params.title,
			content: params.content,
			account: params.account,
			folder: params.folder,
		}, signal)),
	});
}
