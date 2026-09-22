import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a fresh session with empty conversation context",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions) return null;

				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (!beforeCursor.startsWith("/") || beforeCursor.includes(" ")) return suggestions;

				const items = suggestions.items.filter((item) => item.value !== "new");
				return items.length > 0 ? { ...suggestions, items } : null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
