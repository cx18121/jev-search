import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, stripTerminalSequences } from "@earendil-works/pi-tui";

const notifyWithOsc = (title: string, body: string) => {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const notify = (title: string, project: string, body: string) => {
	if (process.env.HERDR_PANE_ID) {
		return;
	}

	notifyWithOsc(title, `${project}: ${body}`);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null) => {
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = stripTerminalSequences(simplified)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) {
		return { body: "Ready for input" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { body };
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { body } = formatNotification(lastText);
		notify("π finished", basename(ctx.cwd), body);
	});
}
