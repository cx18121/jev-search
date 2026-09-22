import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extractCxSessionEvidence,
	selectCxAuditSessions,
} from "../lib/audit.ts";
import {
	applyCxCommand,
	CX_ACTIVE_MESSAGE,
	CX_INACTIVE_MESSAGE,
	CX_MARKER,
	CX_REFERENCE_ENTRY,
	CX_STATE_ENTRY,
	decideCxCommand,
	emptyCxState,
	latestCxDirective,
	refreshPendingDirective,
	renderCxKernel,
	restoreCxState,
	restoreCxStateFile,
	shouldActivateCxByDefault,
	takeBeforeAgentDirective,
} from "../lib/cx.ts";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(moduleRoot, "../..");
const stateEntry = (active: boolean, version?: string) => ({
	type: "custom",
	customType: CX_STATE_ENTRY,
	data: { active, ...(version === undefined ? {} : { version }) },
});
const directiveEntry = (directive: "active" | "inactive") => ({
	type: "custom_message",
	customType: directive === "active" ? CX_ACTIVE_MESSAGE : CX_INACTIVE_MESSAGE,
});
const compactionDirective = (
	state: { active: boolean; hasState: boolean },
	entries: ReturnType<typeof directiveEntry>[],
) => refreshPendingDirective(state, entries).pending;

describe("CX commands", () => {
	test("rejects every command while Pi is busy", () => {
		const active = { active: true, hasState: true };
		expect(decideCxCommand(active, "", false)).toEqual({ kind: "busy" });
		expect(decideCxCommand(active, "off", false)).toEqual({ kind: "busy" });
		expect(decideCxCommand(active, "ship it", false)).toEqual({ kind: "busy" });
	});

	test("reserves only the exact trimmed off argument", () => {
		const active = { active: true, hasState: true };
		expect(decideCxCommand(active, " off ", true)).toEqual({ kind: "deactivate" });
		expect(decideCxCommand(active, "off now", true)).toEqual({ kind: "task", task: "off now" });
	});

	test("preserves the activation task exactly once", () => {
		const task = "  fix the real surface  ";
		const decision = decideCxCommand(emptyCxState(), task, true);
		expect(decision).toEqual({ kind: "activate-task", task });
		expect(applyCxCommand(emptyCxState(), decision)).toEqual({
			active: true,
			hasState: true,
			pending: "active",
		});
	});

	test("keeps repeated activation and deactivation idempotent", () => {
		expect(decideCxCommand({ active: true, hasState: true }, "", true)).toEqual({
			kind: "noop-active",
		});
		expect(decideCxCommand(emptyCxState(), "off", true)).toEqual({
			kind: "noop-inactive",
		});
	});
});

describe("CX session defaults", () => {
	test("activates new and genuinely blank sessions", () => {
		expect(shouldActivateCxByDefault("new", emptyCxState(), [{ type: "message" }])).toBe(
			true,
		);
		expect(shouldActivateCxByDefault("startup", emptyCxState(), [])).toBe(true);
		expect(shouldActivateCxByDefault("reload", emptyCxState(), [])).toBe(true);
		expect(shouldActivateCxByDefault("resume", emptyCxState(), [])).toBe(true);
	});

	test("preserves explicit state and historical sessions without state", () => {
		expect(
			shouldActivateCxByDefault("startup", { active: false, hasState: true }, []),
		).toBe(false);
		expect(
			shouldActivateCxByDefault("startup", emptyCxState(), [{ type: "message" }]),
		).toBe(false);
		expect(
			shouldActivateCxByDefault("resume", emptyCxState(), [{ type: "message" }]),
		).toBe(false);
		expect(shouldActivateCxByDefault("fork", emptyCxState(), [])).toBe(false);
	});
});

describe("CX session state", () => {
	test("uses the latest state across the whole session", () => {
		expect(restoreCxState([stateEntry(true), stateEntry(false)])).toEqual({
			active: false,
			hasState: true,
		});
		expect(restoreCxState([stateEntry(false), stateEntry(true, "kernel-v1")])).toEqual({
			active: true,
			hasState: true,
			version: "kernel-v1",
		});
	});

	test("restores fork state from the source session file", () => {
		const content = [
			JSON.stringify({ type: "session", id: "source" }),
			JSON.stringify(stateEntry(true)),
			JSON.stringify(stateEntry(false)),
		].join("\n");
		expect(restoreCxStateFile(content)).toEqual({ active: false, hasState: true });
	});

	test("marks a directive pending when the selected branch lacks current state", () => {
		expect(refreshPendingDirective({ active: true, hasState: true }, [])).toEqual({
			active: true,
			hasState: true,
			pending: "active",
		});
		expect(
			refreshPendingDirective({ active: false, hasState: true }, [directiveEntry("active")]),
		).toEqual({ active: false, hasState: true, pending: "inactive" });
	});

	test("refreshes active guidance when its content version changes", () => {
		expect(
			refreshPendingDirective(
				{ active: true, hasState: true, version: "old" },
				[directiveEntry("active")],
				"current",
			),
		).toEqual({ active: true, hasState: true, version: "current", pending: "active" });
		expect(
			refreshPendingDirective(
				{ active: true, hasState: true, version: "current" },
				[directiveEntry("active")],
				"current",
			),
		).toEqual({ active: true, hasState: true, version: "current", pending: undefined });
	});

	test("injects a pending directive before using the marker", () => {
		const first = takeBeforeAgentDirective({ active: true, hasState: true, pending: "active" });
		expect(first.directive).toBe("active");
		expect(first.marker).toBe(false);
		expect(takeBeforeAgentDirective(first.state)).toEqual({
			state: { active: true, hasState: true, pending: undefined },
			directive: undefined,
			marker: true,
		});
	});
});

describe("CX compaction", () => {
	test("adds nothing when the rebuilt context already has the right directive", () => {
		expect(compactionDirective({ active: true, hasState: true }, [directiveEntry("active")])).toBeUndefined();
		expect(compactionDirective({ active: false, hasState: true }, [directiveEntry("inactive")])).toBeUndefined();
	});

	test("repairs a missing or stale directive", () => {
		expect(compactionDirective({ active: true, hasState: true }, [])).toBe("active");
		expect(compactionDirective({ active: false, hasState: true }, [directiveEntry("active")])).toBe("inactive");
		expect(compactionDirective(emptyCxState(), [])).toBeUndefined();
	});

	test("uses the newest explicit directive", () => {
		expect(latestCxDirective([directiveEntry("active"), directiveEntry("inactive")])).toBe(
			"inactive",
		);
	});
});

describe("CX audit evidence", () => {
	test("extracts only CX versions and reference markers", () => {
		const evidence = extractCxSessionEvidence(
			[
				JSON.stringify({ type: "session", id: "one" }),
				JSON.stringify({
					type: "custom",
					customType: CX_STATE_ENTRY,
					data: { active: true, version: "kernel-v2", private: "ignored" },
				}),
				JSON.stringify({
					type: "custom",
					customType: CX_REFERENCE_ENTRY,
					data: {
						reference: "playbooks/diagnose-and-fix",
						version: "reference-v3",
						path: "/private/path",
					},
				}),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: "private customer data" },
				}),
			].join("\n"),
		);
		expect(evidence).toEqual({
			used: true,
			kernelVersions: ["kernel-v2"],
			references: [
				{ reference: "playbooks/diagnose-and-fix", version: "reference-v3" },
			],
		});
		expect(JSON.stringify(evidence)).not.toContain("private");
	});

	test("selects CX sessions and excludes the current one", () => {
		const sessions = selectCxAuditSessions(
			[
				{
					path: "/sessions/current.jsonl",
					id: "current",
					modified: new Date("2026-08-20T12:00:00Z"),
				},
				{
					path: "/sessions/plain.jsonl",
					id: "plain",
					modified: new Date("2026-08-20T11:00:00Z"),
				},
				{
					path: "/sessions/cx.jsonl",
					id: "cx",
					modified: new Date("2026-08-20T10:00:00Z"),
				},
			],
			"/sessions/current.jsonl",
			(path) =>
				path.endsWith("cx.jsonl")
					? JSON.stringify(stateEntry(true))
					: JSON.stringify({ type: "session" }),
			"current-kernel",
		);
		expect(sessions).toEqual([
			{
				path: "/sessions/cx.jsonl",
				id: "cx",
				modified: "2026-08-20T10:00:00.000Z",
				kernelVersions: [],
				references: [],
			},
		]);
	});

	test("skips an unreadable session and continues selecting", () => {
		const readErrors: string[] = [];
		const sessions = selectCxAuditSessions(
			[
				{
					path: "/sessions/broken.jsonl",
					id: "broken",
					modified: new Date("2026-08-20T11:00:00Z"),
				},
				{
					path: "/sessions/cx.jsonl",
					id: "cx",
					modified: new Date("2026-08-20T10:00:00Z"),
				},
			],
			undefined,
			(path) => {
				if (path.endsWith("broken.jsonl")) throw new Error("unreadable");
				return JSON.stringify(stateEntry(true));
			},
			"current-kernel",
			(session) => readErrors.push(session.id),
		);
		expect(readErrors).toEqual(["broken"]);
		expect(sessions.map((session) => session.id)).toEqual(["cx"]);
	});

	test("returns the complete current-kernel cohort", () => {
		const current = Array.from({ length: 7 }, (_, index) => ({
			path: `/sessions/current-${index}.jsonl`,
			id: `current-${index}`,
			modified: new Date(`2026-08-20T10:00:0${index}Z`),
		}));
		const sessions = selectCxAuditSessions(
			[
				...current,
				{
					path: "/sessions/old.jsonl",
					id: "old",
					modified: new Date("2026-08-19T10:00:00Z"),
				},
			],
			undefined,
			(path) =>
				JSON.stringify(
					stateEntry(true, path.endsWith("old.jsonl") ? "old-kernel" : "current-kernel"),
				),
			"current-kernel",
		);
		expect(sessions).toHaveLength(7);
		expect(sessions.every((session) => session.id.startsWith("current-"))).toBe(true);
	});
});

describe("CX package resources", () => {
	test("keeps the reviewed kernel and marker compact", () => {
		const kernel = readFileSync(join(moduleRoot, "resources/kernel.md"), "utf8").trim();
		expect(kernel.split(/\s+/).filter((word) => word !== "-").length).toBeLessThanOrEqual(500);
		expect(CX_MARKER.split(/\s+/)).toHaveLength(18);
	});

	test("resolves every kernel reference from the installed resource root", () => {
		const resourceRoot = join(moduleRoot, "resources");
		const kernel = renderCxKernel(
			readFileSync(join(resourceRoot, "kernel.md"), "utf8"),
			resourceRoot,
		);
		const references = [...kernel.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
		expect(references).toHaveLength(15);
		expect(references.every((reference) => existsSync(reference))).toBe(true);
	});

	test("routes Reflect through Codex Subagents", () => {
		const reflect = readFileSync(join(moduleRoot, "resources/reflect.md"), "utf8");
		expect(reflect).toContain("when `spawn_agent` is available");
		expect(reflect).toContain("complementary model from Model roles");
		expect(reflect).not.toContain("pi --list-models");
		expect(reflect).not.toContain("context: \"fresh\"");
		expect(reflect).not.toContain("mission: false");
		expect(reflect).not.toContain("artifacts: false");
		expect(reflect).toContain("Missed correction candidate for the correction log");
		expect(reflect).toContain("call `correction_log`");
	});

	test("registers extension commands without public skill bypasses", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		expect(manifest.pi.skills).toBeUndefined();
		expect(manifest.pi.prompts).toBeUndefined();
		expect(manifest.pi.extensions).toContain("./modules/cxstack/extensions/corrections.ts");
		expect(manifest.pi.extensions).toContain("./modules/cxstack/extensions/audit.ts");
		expect(manifest.pi.extensions).toContain("./modules/cxstack/extensions/cx.ts");
		expect(manifest.pi.extensions).toContain("./modules/cxstack/extensions/reflect.ts");
		expect(existsSync(join(packageRoot, "skills/cx/SKILL.md"))).toBe(false);
	});
});
