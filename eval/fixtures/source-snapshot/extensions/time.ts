import { Type, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTimeContext } from "../lib/time-context.js";

export default function (pi: ExtensionAPI) {
	let sessionStartedAt = new Date();

	pi.on("session_start", () => {
		sessionStartedAt = new Date();
	});

	pi.registerTool({
		name: "time",
		label: "Current Time",
		description: "Return the current local date, time, weekday, time zone, and elapsed Pi session time. Use when current or relative time affects the answer.",
		promptSnippet: "Use the time tool before interpreting relative dates or times such as today, tomorrow, Friday, later, or in two hours. It reports session elapsed time, not task duration.",
		parameters: Type.Object({}),
		execute: async () => {
			const value = createTimeContext(
				new Date(),
				sessionStartedAt,
				Intl.DateTimeFormat().resolvedOptions().timeZone,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(value, null, 2) }] satisfies TextContent[],
				details: value,
			};
		},
	});
}
