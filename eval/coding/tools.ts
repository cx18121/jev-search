import { access } from "node:fs/promises";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import currentFff from "../../vendor/pi-fff/src/index.ts";
import stockFff from "../../vendor/stock-pi-fff/src/index.ts";
import { DockerWorkspace } from "./docker.ts";
import { assertRelativeSearchPath, truncateUtf8, WorkspaceGuard } from "./path-guard.ts";
import type { Arm } from "./types.ts";

export const TOOL_NAMES = ["read", "edit", "write", "bash", "ffgrep", "fffind"] as const;
export const OUTPUT_CAP_BYTES = 12_000;
export const SEARCH_DEFAULTS = { limit: 20, context: 3 } as const;

export function createConfinedCodingTools(guard: WorkspaceGuard, container: DockerWorkspace): ToolDefinition<any, any, any>[] {
  const read = createReadToolDefinition(guard.root, {
    operations: {
      readFile: (path) => guard.read(path, true),
      access: async (path) => { await access(await guard.existing(path, true)); },
      detectImageMimeType: async () => null,
    },
  });
  const edit = createEditToolDefinition(guard.root, {
    operations: {
      readFile: (path) => guard.read(path, true),
      writeFile: (path, content) => guard.write(path, content, true),
      access: async (path) => { await access(await guard.existing(path, true)); },
    },
  });
  const write = createWriteToolDefinition(guard.root, {
    operations: {
      writeFile: (path, content) => guard.write(path, content, true),
      mkdir: (path) => guard.makeDirectory(path, true),
    },
  });
  const bash = createBashToolDefinition(guard.root, {
    operations: container.bashOperations(),
    exposeSessionEnvironment: false,
  });
  return [read, edit, write, bash].map((tool) => ({ ...tool, executionMode: "sequential" as const })) as ToolDefinition<any, any, any>[];
}

function normalizedParams(name: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const params = { ...(value as Record<string, unknown>) };
  if (name === "ffgrep") {
    params.limit ??= SEARCH_DEFAULTS.limit;
    params.context ??= SEARCH_DEFAULTS.context;
  } else if (name === "fffind") {
    params.limit ??= SEARCH_DEFAULTS.limit;
  }
  return params;
}

function wrapFffFactory(pi: ExtensionAPI, arm: Arm): void {
  const factory = arm === "stock" ? stockFff : currentFff;
  const proxied = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (definition: ToolDefinition) => {
        const original = definition.execute.bind(definition);
        const name = definition.name;
        const wrapped: ToolDefinition = {
          ...definition,
          ...(name === "ffgrep" || name === "fffind" ? {
            description: `${definition.description} Harness-normalized defaults: limit 20${name === "ffgrep" ? ", context 3" : ""}; output cap 12000 UTF-8 bytes.`,
            prepareArguments: (args: unknown) => normalizedParams(name, definition.prepareArguments ? definition.prepareArguments(args) : args) as never,
          } : {}),
          async execute(id, params, signal, onUpdate, ctx) {
            const effective = normalizedParams(name, params) as never;
            const result = await original(id, effective, signal, onUpdate, ctx);
            if (name !== "ffgrep" && name !== "fffind") return result;
            return {
              ...result,
              details: {
                ...(typeof result.details === "object" && result.details !== null ? result.details : {}),
                harness: {
                  arm,
                  stockInterface: arm === "stock" ? "pristine factory; normalized presentation/default wrapper" : undefined,
                  normalizedDefaults: SEARCH_DEFAULTS,
                  outputCapBytes: OUTPUT_CAP_BYTES,
                  ...(arm === "stock" ? { stockNativeOrderPreserved: true } : {}),
                },
              },
            };
          },
        };
        target.registerTool(wrapped);
      };
    },
  });
  factory(proxied);
}

/** FFF factory plus harness-only default/output/path normalization. No additional tool name is registered. */
export function codingExtension(arm: Arm): InlineExtension {
  return {
    name: `coding-${arm}`,
    factory: (pi) => {
      wrapFffFactory(pi, arm);
      pi.on("tool_call", (event) => {
        if (event.toolName === "ffgrep" || event.toolName === "fffind") {
          try {
            assertRelativeSearchPath((event.input as Record<string, unknown>).path);
          } catch (error) {
            return { block: true, reason: error instanceof Error ? error.message : String(error) };
          }
        }
        if (["read", "edit", "write"].includes(event.toolName)) {
          const path = (event.input as Record<string, unknown>).path;
          try {
            assertRelativeSearchPath(path);
          } catch (error) {
            return { block: true, reason: error instanceof Error ? error.message : String(error) };
          }
        }
        return undefined;
      });
      pi.on("tool_result", (event) => {
        let changed = false;
        const content = event.content.map((part) => {
          if (part.type !== "text") return part;
          const capped = truncateUtf8(part.text, OUTPUT_CAP_BYTES);
          if (!capped.truncated) return part;
          changed = true;
          return { ...part, text: capped.text };
        });
        return changed ? { content } : undefined;
      });
    },
  };
}
