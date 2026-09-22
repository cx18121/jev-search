import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	groupReminders,
	parseReminderList,
	reminderSummary,
	timingSummary,
	type ReminderGroups,
	validateReminderDates,
} from "../lib/reminders.js";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/apple-reminders.js");

const shortReminderId = (id: string) => id.replace(/^x-apple-reminder:\/\//, "").slice(0, 8);

const groupOptions = (groups: ReminderGroups) => [
	...groups.overdue.map((reminder) => ({ reminder, label: `Overdue · ${reminder.title} · ${reminder.list} · ${timingSummary(reminder)} · ${shortReminderId(reminder.id)}` })),
	...groups.today.map((reminder) => ({ reminder, label: `Today · ${reminder.title} · ${reminder.list} · ${timingSummary(reminder)} · ${shortReminderId(reminder.id)}` })),
	...groups.nextSevenDays.map((reminder) => ({ reminder, label: `Next 7 days · ${reminder.title} · ${reminder.list} · ${timingSummary(reminder)} · ${shortReminderId(reminder.id)}` })),
	...groups.noDate.map((reminder) => ({ reminder, label: `No date · ${reminder.title} · ${reminder.list} · ${shortReminderId(reminder.id)}` })),
];

const toolResult = (value: unknown) => ({
	content: [{ type: "text", text: JSON.stringify(value, null, 2) }] satisfies TextContent[],
	details: value,
});

export default function (pi: ExtensionAPI) {
	const runReminders = async (request: object, signal?: AbortSignal) => {
		const result = await pi.exec("osascript", [
			"-l",
			"JavaScript",
			scriptPath,
			JSON.stringify(request),
		], { signal, timeout: 60_000 });

		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || "Apple Reminders automation failed.");
		}

		const value: unknown = JSON.parse(result.stdout);
		return value;
	};

	const listReminders = async (request: object, signal?: AbortSignal) => parseReminderList(
		await runReminders({ operation: "list", ...request }, signal),
	);

	const chooseReminder = async (query: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		const reminders = await listReminders({ query, includeCompleted: true, limit: 100 }, signal);
		if (reminders.length <= 1) {
			return reminders[0] ?? null;
		}
		if (!ctx.hasUI) {
			throw new Error("Multiple reminders match. Use an exact reminder ID.");
		}
		const options = reminders.map((reminder) => `${reminder.title} · ${reminder.list} · ${timingSummary(reminder)} · ${shortReminderId(reminder.id)}`);
		const selected = await ctx.ui.select("Choose a reminder", options);
		const index = selected ? options.indexOf(selected) : -1;
		return index >= 0 ? reminders[index] : null;
	};

	pi.registerCommand("reminders", {
		description: "Browse upcoming Apple Reminders",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Use /reminders without arguments, or ask in normal chat.", "warning");
				return;
			}
			const reminders = await listReminders({ includeCompleted: false, limit: 200 });
			const groups = groupReminders(reminders, new Date());
			const options = groupOptions(groups);
			if (options.length === 0) {
				ctx.ui.notify(groups.later.length > 0 ? `${groups.later.length} later reminders. Nothing due in the next seven days.` : "No incomplete reminders.", "info");
				return;
			}
			if (groups.later.length > 0) {
				ctx.ui.notify(`${groups.later.length} later reminders are not shown.`, "info");
			}
			const selected = await ctx.ui.select("Reminders", options.map((option) => option.label));
			const option = options.find((candidate) => candidate.label === selected);
			if (option) {
				ctx.ui.notify(reminderSummary(option.reminder), "info");
			}
		},
	});

	pi.registerTool({
		name: "reminders",
		label: "Apple Reminders",
		description: "List, create, update, complete, or delete Apple Reminders. New reminders use Apple's default list unless another list is named.",
		promptSnippet: "Use reminders only after an explicit request or an accepted reminder suggestion. You may briefly suggest a reminder once when the user states a future commitment that could outlive the session, including a useful reminder without a date. Never create one without approval. Call the time tool before resolving relative dates or times.",
		promptGuidelines: [
			"Searches cover every Apple Reminders list. Always show the list when presenting matches.",
			"For 'remind me Friday', use allDayDate. For 'remind me Friday at 3', use alertAt without a due date. Set dueAt only when the user says the task is due at a specific time.",
			"Use allDayDate for an all-day item. Apple stores it as an all-day due date and uses the user's Today Notification setting.",
			"Pass alertAt and dueAt as absolute ISO 8601 values with a UTC offset. Do not guess the current date, time, or time zone.",
			"Do not repeat a reminder suggestion after the user declines.",
			"Creating, updating, completing, and deleting reminders require explicit user approval. Deletion also requires an interactive confirmation.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("create"),
				Type.Literal("update"),
				Type.Literal("complete"),
				Type.Literal("delete"),
			]),
			title: Type.Optional(Type.String({ description: "Reminder title for create, or replacement title for update" })),
			notes: Type.Optional(Type.String({ description: "Optional reminder notes" })),
			list: Type.Optional(Type.String({ description: "Exact Apple Reminders list name for creation or list filtering. New reminders otherwise use the default list." })),
			query: Type.Optional(Type.String({ description: "Reminder ID or title text for list, update, complete, or delete" })),
			alertAt: Type.Optional(Type.Union([
				Type.String({ minLength: 1, description: "Absolute notification time in ISO 8601 format with a UTC offset" }),
				Type.Null({ description: "Clear the notification time during update" }),
			])),
			dueAt: Type.Optional(Type.Union([
				Type.String({ minLength: 1, description: "Absolute due time in ISO 8601 format with a UTC offset" }),
				Type.Null({ description: "Clear the due time during update" }),
			])),
			allDayDate: Type.Optional(Type.Union([
				Type.String({ minLength: 1, description: "All-day reminder date in YYYY-MM-DD format" }),
				Type.Null({ description: "Clear the all-day date during update" }),
			])),
			includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed reminders when listing, default false" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum list results, default 100" })),
		}),
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			const dateError = validateReminderDates(params);
			if (dateError) {
				return toolResult({ error: dateError });
			}

			if (params.action === "list") {
				return toolResult(await listReminders({
					query: params.query,
					list: params.list,
					includeCompleted: params.includeCompleted,
					limit: params.limit,
				}, signal));
			}

			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) {
					return toolResult({ error: "A title is required to create a reminder." });
				}
				return toolResult(await runReminders({
					operation: "create",
					title,
					notes: params.notes,
					list: params.list,
					alertAt: params.alertAt,
					dueAt: params.dueAt,
					allDayDate: params.allDayDate,
				}, signal));
			}

			const query = params.query?.trim();
			if (!query) {
				return toolResult({ error: `A reminder ID or title is required to ${params.action} a reminder.` });
			}
			const reminder = await chooseReminder(query, ctx, signal);
			if (!reminder) {
				return toolResult({ error: "No matching reminder was selected." });
			}

			if (params.action === "delete") {
				if (!ctx.hasUI) {
					return toolResult({ error: "Deletion requires an interactive confirmation." });
				}
				const confirmed = await ctx.ui.confirm("Delete this reminder?", reminderSummary(reminder));
				if (!confirmed) {
					return toolResult({ cancelled: true });
				}
			}

			if (params.action === "update" && !params.title?.trim() && params.notes === undefined && params.alertAt === undefined && params.dueAt === undefined && params.allDayDate === undefined) {
				return toolResult({ error: "At least one changed field is required to update a reminder." });
			}

			return toolResult(await runReminders({
				operation: params.action,
				id: reminder.id,
				title: params.title?.trim(),
				notes: params.notes,
				alertAt: params.alertAt,
				dueAt: params.dueAt,
				allDayDate: params.allDayDate,
			}, signal));
		},
	});
}
