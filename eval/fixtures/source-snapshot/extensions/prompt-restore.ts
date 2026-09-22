import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	armPromptRestore,
	assistantHasOutput,
	beginPromptRestore,
	recordAssistantOutput,
	type PromptRestoreState,
} from "../lib/prompt-restore.js";

const RESTORE_COMMAND = "restore-cancelled-prompt";
const ANCHOR_TYPE = "prompt-restore-anchor";

export default function registerPromptRestore(pi: ExtensionAPI) {
	let state: PromptRestoreState = { status: "idle" };
	let abortCurrent: (() => void) | undefined;
	let pendingMessagesExist = () => false;
	let readEditorText = () => "";

	pi.registerCommand(RESTORE_COMMAND, {
		description: "Restore an immediately cancelled prompt to the editor",
		handler: async (_args, ctx) => {
			if (state.status !== "restoring") return;

			const { parentId, text } = state;
			const editorText = readEditorText();
			state = { status: "idle" };
			const result = await ctx.navigateTree(parentId, { summarize: false });
			if (result.cancelled) return;
			ctx.ui.setEditorText([text, editorText].filter((value) => value.trim()).join("\n\n"));
		},
	});

	pi.on("session_start", (_event, ctx) => {
		state = { status: "idle" };
		abortCurrent = undefined;
		pendingMessagesExist = () => false;
		readEditorText = () => "";
		if (ctx.mode !== "tui") return;

		if (ctx.sessionManager.getLeafId() === null) {
			pi.appendEntry(ANCHOR_TYPE);
		}

		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions) return null;
				const items = suggestions.items.filter((item) => item.value !== RESTORE_COMMAND);
				return items.length > 0 ? { ...suggestions, items } : null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));

		const previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			readEditorText = () => editor.getExpandedText?.() ?? editor.getText();
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data) => {
				if (
					!keybindings.matches(data, "app.interrupt") ||
					state.status !== "waiting" ||
					state.outputSeen ||
					pendingMessagesExist()
				) {
					handleInput(data);
					return;
				}

				state = beginPromptRestore(state);
				abortCurrent?.();
			};
			return editor;
		});
	});

	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive" || event.streamingBehavior !== undefined) {
			return;
		}

		state = { status: "idle" };
		abortCurrent = undefined;
		pendingMessagesExist = () => false;
		if (event.images?.length) return;

		const parentId = ctx.sessionManager.getLeafId();
		if (!parentId) return;
		state = { status: "candidate", text: event.text, parentId };
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (state.status !== "candidate") return;
		state = armPromptRestore(state);
		abortCurrent = () => ctx.abort();
		pendingMessagesExist = () => ctx.hasPendingMessages();
	});

	pi.on("message_update", (event) => {
		if (state.status !== "waiting" || event.message.role !== "assistant") return;
		if (assistantHasOutput(event.message.content)) state = recordAssistantOutput(state);
	});

	pi.on("agent_settled", () => {
		abortCurrent = undefined;
		pendingMessagesExist = () => false;
		if (state.status === "restoring") {
			pi.sendUserMessage(`/${RESTORE_COMMAND}`, { expandPromptTemplates: true });
			return;
		}
		state = { status: "idle" };
	});

	pi.on("session_shutdown", () => {
		state = { status: "idle" };
		abortCurrent = undefined;
		pendingMessagesExist = () => false;
		readEditorText = () => "";
	});
}
