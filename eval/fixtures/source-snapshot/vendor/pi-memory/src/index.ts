import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assertMemoryMutationPermission,
  assertPapercutPermission,
  assertScratchpadPermission,
  autoCaptureEnabled,
  buildStartupContext,
  checklistFilePath,
  findRecoveryScope,
  forgetMemory,
  listTopics,
  memoryFilePath,
  mutateChecklist,
  readText,
  resolveAgentRole,
  resolveLocations,
  resolveScope,
  restoreMemory,
  scopeInventory,
  searchMemory,
  writeMemory,
  type MemoryScope,
} from "./core.js";

const scopeSchema = Type.Optional(
  StringEnum(["global", "project"] as const, {
    description: "Memory scope. Defaults to project at projectPath or the active directory when either is inside Git, otherwise global.",
  }),
);

const projectPathSchema = Type.Optional(
  Type.String({ description: "Repository path to use instead of the active working directory." }),
);

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { ...textResult(`Memory error: ${message}`), isError: true };
}

function runtime(ctx: ExtensionContext, projectPath?: string) {
  const role = resolveAgentRole(process.env, ctx.sessionManager.getSessionId());
  if (projectPath && role !== "root") {
    throw new Error("Explicit project targeting is available only to the root agent.");
  }
  const target = projectPath ? path.resolve(ctx.cwd, projectPath) : ctx.cwd;
  const locations = resolveLocations(target);
  if (projectPath && !locations.project) {
    throw new Error(`Explicit project path is not inside a Git repository: ${projectPath}`);
  }
  return { locations, role };
}

function scopePath(ctx: ExtensionContext, requested?: MemoryScope, projectPath?: string) {
  const state = runtime(ctx, projectPath);
  return { ...state, ...resolveScope(state.locations, requested) };
}

export default function registerMemory(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const { locations, role } = runtime(ctx);
    const context = buildStartupContext({ locations, role, autoCapture: autoCaptureEnabled() });
    return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Visibly save a stable preference, correction, confirmed recurring fix, or useful fact to local Markdown. Current sources override memory. Prefer a concise MEMORY.md index and topic files for detail. During an explicit approval-gated review, propose the write and wait for selection.",
    promptGuidelines: [
      "memory_write: infer scope from content and context. Project-specific facts and decisions use project memory. Cross-project preferences use global memory. Prefer project scope when genuinely unclear.",
    ],
    parameters: Type.Object({
      scope: scopeSchema,
      projectPath: projectPathSchema,
      target: Type.Optional(StringEnum(["memory", "topic"] as const)),
      topic: Type.Optional(Type.String({ description: "Lowercase topic slug when target is topic." })),
      content: Type.String({ description: "Markdown to store." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const state = scopePath(ctx, params.scope, params.projectPath);
        assertMemoryMutationPermission(state.role);
        const target = params.target ?? "memory";
        const filePath = writeMemory({
          dir: state.dir,
          target,
          topic: params.topic,
          content: params.content,
          sessionId: ctx.sessionManager.getSessionId(),
        });
        const destination =
          target === "topic" ? `${state.scope} topic "${params.topic}"` : `${state.scope} MEMORY.md`;
        return textResult(`Saved to ${destination}:\n\n${params.content}`, {
          path: filePath,
          scope: state.scope,
          target,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read global or active-project memory, topics, scratchpad, or papercuts.",
    parameters: Type.Object({
      scope: scopeSchema,
      projectPath: projectPathSchema,
      target: StringEnum(["memory", "topic", "topics", "scratchpad", "papercuts"] as const),
      topic: Type.Optional(Type.String({ description: "Lowercase topic slug for target=topic." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const state = scopePath(ctx, params.scope, params.projectPath);
        if (params.target === "topics") {
          const topics = listTopics(state.dir);
          return textResult(topics.length ? topics.map((topic) => `- ${topic}`).join("\n") : "No topics found.", {
            scope: state.scope,
            topics,
          });
        }
        const filePath =
          params.target === "memory" || params.target === "topic"
            ? memoryFilePath(state.dir, params.target, params.topic)
            : checklistFilePath(state.dir, params.target);
        const content = readText(filePath);
        return textResult(content || `${path.basename(filePath)} is empty or does not exist.`, {
          path: filePath,
          scope: state.scope,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search local Markdown in global and active-project memory with in-process BM25+ ranking. Exact phrases rank first; prefix matching is enabled, with typo tolerance only as a fallback.",
    parameters: Type.Object({
      query: Type.String(),
      projectPath: projectPathSchema,
      limit: Type.Optional(Type.Number({ description: "Maximum results, 1-25. Default 5." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { locations } = runtime(ctx, params.projectPath);
        const results = searchMemory(locations, params.query, params.limit ?? 5);
        if (!results.length) return textResult(`No memory found for "${params.query}".`, { count: 0 });
        const formatted = results
          .map(
            (result, index) =>
              `### Result ${index + 1}\n**File:** ${result.path}\n\n${result.excerpt}`,
          )
          .join("\n\n---\n\n");
        return textResult(formatted, { count: results.length, results });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove matching memory entries and create a local recovery record before deletion.",
    parameters: Type.Object({
      scope: scopeSchema,
      projectPath: projectPathSchema,
      target: Type.Optional(StringEnum(["memory", "topic"] as const)),
      topic: Type.Optional(Type.String()),
      match: Type.String({ description: "Case-insensitive substring identifying entries to remove." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const state = scopePath(ctx, params.scope, params.projectPath);
        assertMemoryMutationPermission(state.role);
        const result = forgetMemory({
          dir: state.dir,
          target: params.target,
          topic: params.topic,
          match: params.match,
        });
        return textResult(
          `Removed ${result.removed} entr${result.removed === 1 ? "y" : "ies"}. Recovery ID: ${result.recoveryId}.`,
          result,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_restore",
    label: "Memory Restore",
    description: "Restore entries deleted by memory_forget using its recovery ID.",
    parameters: Type.Object({ recoveryId: Type.String(), projectPath: projectPathSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { locations, role } = runtime(ctx, params.projectPath);
        assertMemoryMutationPermission(role);
        const found = findRecoveryScope(locations, params.recoveryId);
        const result = restoreMemory(found.dir, params.recoveryId);
        return textResult(
          result.alreadyRestored
            ? `Recovery ${params.recoveryId} was already restored.`
            : `Restored ${result.restored} entr${result.restored === 1 ? "y" : "ies"}.`,
          { ...result, scope: found.scope },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "scratchpad",
    label: "Scratchpad",
    description:
      "Manage global or project unfinished-work checklists. Project scope is the default inside Git. Subagents are read-only.",
    parameters: Type.Object({
      scope: scopeSchema,
      projectPath: projectPathSchema,
      action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const),
      text: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const state = scopePath(ctx, params.scope, params.projectPath);
        assertScratchpadPermission(state.role, params.action);
        const filePath = checklistFilePath(state.dir, "scratchpad");
        const content = mutateChecklist({
          filePath,
          action: params.action,
          text: params.text,
          sessionId: ctx.sessionManager.getSessionId(),
        });
        return textResult(content || "Scratchpad is empty.", { path: filePath, scope: state.scope });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "papercut",
    label: "Papercut",
    description:
      "Report and manage small workflow friction. Add even a first occurrence when a tool, prompt, skill, helper, or repository change could plausibly prevent it. Include the activity, friction, and plausible structural improvement. Skip incidental mistakes with no structural lesson and never include secrets. During an explicit approval-gated review, propose the entry and wait for selection. Any agent may append or list; only root agents may edit, resolve, or clear items.",
    promptGuidelines: [
      "papercut: treat entries as evidence, not a backlog. Before recommending a repair, confirm the current failure, frequency, consequence, and owner. Compare doing nothing or deferring. Target the observed failure rather than the suggested remedy.",
      "papercut cleanup: when clearing resolved entries is authorized, clear them directly without reviewing them again. Resolve historical items from current code when it settles the recorded issue. Run additional checks only when they could change the resolution.",
    ],
    parameters: Type.Object({
      scope: scopeSchema,
      projectPath: projectPathSchema,
      action: StringEnum(["add", "done", "undo", "clear_done", "list", "edit", "resolve"] as const),
      text: Type.Optional(Type.String({ description: "Item text or substring to match." })),
      replacement: Type.Optional(Type.String({ description: "Replacement text for edit." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const state = scopePath(ctx, params.scope, params.projectPath);
        assertPapercutPermission(state.role, params.action);
        const filePath = checklistFilePath(state.dir, "papercuts");
        const content = mutateChecklist({
          filePath,
          action: params.action,
          text: params.text,
          replacement: params.replacement,
          sessionId: ctx.sessionManager.getSessionId(),
        });
        return textResult(content || "Papercuts are empty.", { path: filePath, scope: state.scope });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show local memory paths, active project identity, role, permissions, and file counts.",
    parameters: Type.Object({ projectPath: projectPathSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { locations, role } = runtime(ctx, params.projectPath);
        const global = scopeInventory(locations.globalDir);
        const project = locations.projectDir ? scopeInventory(locations.projectDir) : null;
        const lines = [
          "# Memory status",
          "",
          `- Base: ${locations.baseDir}`,
          `- Role: ${role}`,
          `- Durable memory writes: ${role === "root" ? "allowed" : "read-only"}`,
          `- Scratchpad writes: ${role === "root" ? "allowed" : "read-only"}`,
          `- Papercut append: allowed`,
          `- Papercut edit/resolve: ${role === "root" ? "allowed" : "read-only"}`,
          `- Project: ${locations.project ? `${locations.project.id} (${locations.project.commonRoot})` : "none"}`,
          "",
          `- Global: ${global.dir} — ${global.files} files, ${global.bytes} bytes, ${global.topics} topics`,
          ...(project
            ? [`- Project: ${project.dir} — ${project.files} files, ${project.bytes} bytes, ${project.topics} topics`]
            : []),
          "",
          "Configuration: PI_MEMORY_DIR, PI_MEMORY_AUTO_CAPTURE, PI_MEMORY_SUBAGENT_MODE",
        ];
        return textResult(lines.join("\n"), { role, locations, global, project });
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
