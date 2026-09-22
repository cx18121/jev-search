import { access } from "node:fs/promises";
import {
  createReadToolDefinition,
  type ExtensionAPI,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import currentFff from "../../vendor/pi-fff/src/index.ts";
import { assertRelativeSearchPath, WorkspaceGuard } from "../coding/path-guard.ts";
import type { Arm, FrozenQuery } from "./types.ts";

export const TOOL_NAMES = ["read", "ffgrep", "fffind"] as const;
export const SEARCH_DEFAULTS = { limit: 20, context: 3 } as const;
export const OUTPUT_CAP_BYTES = 12_000;

export type BlockedInitialCall = { toolName: string; args: unknown; effectiveArgs?: unknown; reason: string };
export type FirstCallState = {
  readonly expected: Record<string, unknown>;
  succeeded: boolean;
  totalAttempts: number;
  followupAttempts: number;
  attemptedByTool: Record<string, number>;
  forwardedFffCalls: number;
  initialInFlight: boolean;
  blocked: BlockedInitialCall[];
};

export function expectedFirstArgs(query: FrozenQuery): Record<string, unknown> {
  return {
    pattern: query.pattern,
    ...(query.path === undefined ? {} : { path: query.path }),
    intent: query.intent,
    limit: SEARCH_DEFAULTS.limit,
    context: SEARCH_DEFAULTS.context,
  };
}

export function createFirstCallState(query: FrozenQuery): FirstCallState {
  return { expected: expectedFirstArgs(query), succeeded: false, totalAttempts: 0, followupAttempts: 0, attemptedByTool: {}, forwardedFffCalls: 0, initialInFlight: false, blocked: [] };
}

function recordAttempt(state: FirstCallState, toolName: string): void {
  state.totalAttempts += 1;
  state.attemptedByTool[toolName] = (state.attemptedByTool[toolName] ?? 0) + 1;
}

export function normalizeToolArgs(name: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const params = { ...(value as Record<string, unknown>) };
  if (name === "ffgrep") {
    params.limit ??= SEARCH_DEFAULTS.limit;
    params.context ??= SEARCH_DEFAULTS.context;
  } else if (name === "fffind") params.limit ??= SEARCH_DEFAULTS.limit;
  return params;
}

function sameRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const row = actual as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index] && row[key] === expected[key]);
}

/** Returns a block reason until the exact mandatory search has succeeded. */
export function checkInitialCall(state: FirstCallState, toolName: string, args: unknown, record = true): string | undefined {
  if (record) recordAttempt(state, toolName);
  if (state.succeeded) return undefined;
  const effectiveArgs = normalizeToolArgs(toolName, args);
  let reason: string | undefined;
  if (toolName !== "ffgrep") reason = "The mandatory frozen ffgrep call must succeed before any other tool call.";
  else if (!sameRecord(effectiveArgs, state.expected)) reason = "The first ffgrep call must use exactly the frozen pattern, optional path, byte-identical intent, limit 20 and context 3, with no other arguments.";
  if (reason && record) state.blocked.push({ toolName, args, effectiveArgs, reason });
  return reason;
}

function takeUtf8(value: string, bytes: number): string {
  if (bytes <= 0) return "";
  const data = Buffer.from(value, "utf8");
  if (data.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
  return data.subarray(0, end).toString("utf8");
}

/** Neutralize only the arm label at the start of the final GrepPilot footer. */
export function neutralizeOrderFooter(value: string): string {
  if (!value.endsWith("]")) return value;
  const marker = "\n\n[Order: ";
  const start = value.lastIndexOf(marker);
  if (start < 0) return value;
  const labelStart = start + marker.length;
  const period = value.indexOf(". ", labelStart);
  if (period < 0) return value;
  const label = value.slice(labelStart, period);
  if (!["native", "deterministic", "jev", "native fallback"].includes(label)) return value;
  return `${value.slice(0, labelStart)}search${value.slice(period)}`;
}

/** Cap all text parts together, rather than granting 12KB independently to each part. */
export function blindAndCapContent(content: unknown, cap = OUTPUT_CAP_BYTES): unknown {
  if (!Array.isArray(content)) return content;
  const marker = "\n[tool output truncated by effort harness]";
  let remaining = cap;
  let textParts = 0;
  const output: unknown[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text" || typeof (part as { text?: unknown }).text !== "string") { output.push(part); continue; }
    // Pi's text projection separates text parts with a newline; include that byte
    // in the single aggregate allowance and omit empty overflow parts.
    if (textParts > 0) {
      if (remaining < 1) continue;
      remaining -= 1;
    }
    if (remaining <= 0) continue;
    const blinded = neutralizeOrderFooter((part as { text: string }).text);
    const bytes = Buffer.byteLength(blinded);
    if (bytes <= remaining) { output.push({ ...part, text: blinded }); remaining -= bytes; textParts += 1; continue; }
    const markerBytes = Buffer.byteLength(marker);
    const text = takeUtf8(blinded, Math.max(0, remaining - markerBytes)) + (remaining >= markerBytes ? marker : "");
    output.push({ ...part, text });
    remaining -= Buffer.byteLength(text);
    textParts += 1;
  }
  return output;
}

export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n");
}

export function createGuardedRead(guard: WorkspaceGuard): ToolDefinition<any, any, any> {
  const read = createReadToolDefinition(guard.root, {
    operations: {
      readFile: (path) => guard.read(path, true),
      access: async (path) => { await access(await guard.existing(path, true)); },
      detectImageMimeType: async () => null,
    },
  });
  return { ...read, executionMode: "sequential" as const } as ToolDefinition<any, any, any>;
}

/** Enhanced current FFF with harness-only confinement, first-call gate and presentation blinding. */
export function effortExtension(arm: Arm, state: FirstCallState): InlineExtension {
  return {
    name: `effort-${arm}`,
    factory: (pi: ExtensionAPI) => {
      const proxied = new Proxy(pi, {
        get(target, property, receiver) {
          if (property !== "registerTool") return Reflect.get(target, property, receiver);
          return (definition: ToolDefinition) => {
            if (definition.name !== "ffgrep" && definition.name !== "fffind") return;
            const original = definition.execute.bind(definition);
            const name = definition.name;
            target.registerTool({
              ...definition,
              prepareArguments: (args: unknown) => normalizeToolArgs(name, definition.prepareArguments ? definition.prepareArguments(args) : args) as never,
              async execute(id, params, signal, onUpdate, ctx) {
                const effective = normalizeToolArgs(name, params);
                if (state.forwardedFffCalls > 0) state.forwardedFffCalls -= 1;
                else if (!state.succeeded) {
                  const reason = checkInitialCall(state, name, params);
                  if (reason) throw new Error(reason);
                } else {
                  recordAttempt(state, name);
                  state.followupAttempts += 1;
                }
                if (!state.succeeded && name === "ffgrep") state.initialInFlight = true;
                try {
                  const result = await original(id, effective as never, signal, onUpdate, ctx);
                  if (!state.succeeded && name === "ffgrep") state.succeeded = true;
                  return { ...result, content: blindAndCapContent(result.content) as typeof result.content };
                } finally {
                  if (name === "ffgrep") state.initialInFlight = false;
                }
              },
            });
          };
        },
      });
      currentFff(proxied);
      pi.on("tool_call", (event) => {
        if (!state.succeeded) {
          if (state.initialInFlight) {
            const reason = "The mandatory frozen ffgrep call must succeed before another tool call starts.";
            recordAttempt(state, event.toolName);
            state.blocked.push({ toolName: event.toolName, args: event.input, effectiveArgs: normalizeToolArgs(event.toolName, event.input), reason });
            return { block: true, reason };
          }
          // Invalid calls are counted here because a blocked tool never reaches execute.
          const reason = checkInitialCall(state, event.toolName, event.input, false);
          if (reason) {
            checkInitialCall(state, event.toolName, event.input, true);
            return { block: true, reason };
          }
        }
        if (!TOOL_NAMES.includes(event.toolName as typeof TOOL_NAMES[number])) return { block: true, reason: `Tool is not allowed in effort harness: ${event.toolName}` };
        if (state.succeeded) {
          recordAttempt(state, event.toolName);
          state.followupAttempts += 1;
        } else recordAttempt(state, event.toolName);
        try { assertRelativeSearchPath((event.input as Record<string, unknown>).path); }
        catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
        if (event.toolName === "ffgrep" || event.toolName === "fffind") state.forwardedFffCalls += 1;
        if (!state.succeeded && event.toolName === "ffgrep") state.initialInFlight = true;
        return undefined;
      });
      pi.on("tool_result", (event) => ({ content: blindAndCapContent(event.content) as typeof event.content }));
    },
  };
}
