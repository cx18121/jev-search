import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { confinedFffExtension, verifySnapshot } from "./runner.ts";

const EVAL_DIR = new URL(".", import.meta.url).pathname;
const FIXTURE_DIR = join(EVAL_DIR, "fixtures", "source-snapshot");

function controlledEnvironment(runtimeDir: string): () => void {
  const database = (name: string) => join(runtimeDir, name);
  const changes: Record<string, string> = {
    JEV_SEARCH_ORDER: "native",
    PI_FFF_MODE: "tools-only",
    FFF_ENABLE_HOME_SCAN: "0",
    FFF_WARN_HOME_SCAN: "0",
    FFF_FRECENCY_DB: database("fff-frecency.sqlite"),
    FFF_HISTORY_DB: database("fff-history.sqlite"),
    PI_CODING_AGENT_DIR: join(runtimeDir, "agent"),
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
}

function rerankDetails(result: unknown): { cursor?: string; shown?: number; poolSize?: number } {
  if (typeof result !== "object" || result === null) return {};
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return {};
  const rerank = (details as { rerank?: unknown }).rerank;
  return typeof rerank === "object" && rerank !== null
    ? rerank as { cursor?: string; shown?: number; poolSize?: number }
    : {};
}

/**
 * Offline lifecycle check for SDK binding and the real vendored extension.
 * It never prompts a model: fffind and ffgrep are invoked directly through the
 * registered ToolDefinition, and every returned grep cursor is consumed.
 */
export async function runOfflineSmoke(): Promise<{
  findCount: number;
  grepPages: number;
  grepCandidates: number;
}> {
  const tempRoot = join(EVAL_DIR, ".tmp", `offline-smoke-${process.pid}-${randomUUID().slice(0, 8)}`);
  const workspace = join(tempRoot, "workspace");
  const runtimeDir = join(tempRoot, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await cp(FIXTURE_DIR, workspace, { recursive: true, errorOnExist: true });
  await verifySnapshot(workspace);
  const restoreEnvironment = controlledEnvironment(runtimeDir);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    const extension = confinedFffExtension(workspace);
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: join(runtimeDir, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error("offline smoke extension load failed");

    // ModelRuntime.create restores local catalogs/auth but does not refresh or
    // issue a model request. No credential values are inspected or emitted.
    const modelRuntime = await ModelRuntime.create();
    const created = await createAgentSession({
      cwd: workspace,
      agentDir: join(runtimeDir, "agent"),
      modelRuntime,
      tools: ["read", "ffgrep", "fffind"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace),
      settingsManager,
    });
    session = created.session;
    const runtimeErrors: string[] = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => runtimeErrors.push(`${error.extensionPath}: ${error.error}`),
      abortHandler: () => undefined,
      shutdownHandler: () => undefined,
    });
    if (runtimeErrors.length) throw new Error(`offline smoke extension errors: ${runtimeErrors.join("; ")}`);

    const blocked = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "offline-confinement",
      toolName: "read",
      input: { path: "../outside-snapshot.ts" },
    });
    if (!blocked?.block) throw new Error("workspace confinement guard did not block parent traversal");

    const find = session.extensionRunner.getToolDefinition("fffind");
    const grep = session.extensionRunner.getToolDefinition("ffgrep");
    if (!find || !grep) throw new Error("offline smoke tools were not registered");
    const context = session.extensionRunner.createContext();
    const findResult = await find.execute(
      "offline-find",
      { pattern: "audit", limit: 10 },
      undefined,
      undefined,
      context,
    );
    if (!resultText(findResult).trim()) throw new Error("fffind returned no text");

    const base = {
      pattern: "selectCxAuditSessions",
      intent: "Locate every implementation and call site involved in CX audit session selection.",
      context: 1,
      limit: 1,
    };
    let cursor: string | undefined;
    let grepPages = 0;
    let grepCandidates = 0;
    do {
      const result = await grep.execute(
        `offline-grep-${grepPages + 1}`,
        cursor ? { ...base, intent: undefined, cursor } : base,
        undefined,
        undefined,
        context,
      );
      if (!resultText(result).trim()) throw new Error("ffgrep returned no text");
      const rerank = rerankDetails(result);
      grepPages += 1;
      grepCandidates += rerank.shown ?? 0;
      cursor = rerank.cursor;
      if (grepPages > 20) throw new Error("ffgrep cursor did not drain within 20 pages");
    } while (cursor);
    if (grepPages < 2 || grepCandidates < 2) {
      throw new Error(`cursor smoke lacked multiple candidates: pages=${grepPages} shown=${grepCandidates}`);
    }

    return {
      findCount: resultText(findResult).split("\n").filter(Boolean).length,
      grepPages,
      grepCandidates,
    };
  } finally {
    if (session) {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    }
    restoreEnvironment();
    await rm(tempRoot, { recursive: true, force: true });
  }
}
