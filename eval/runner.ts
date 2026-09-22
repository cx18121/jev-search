import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import fffExtension from "../vendor/pi-fff/src/index.ts";
import { gradeAnswer, type Grade } from "./grader.ts";
import { SEARCH_ORDERS, TASKS, type NavigationTask, type SearchOrder } from "./tasks.ts";

export const MODEL = { provider: "openai-codex", id: "gpt-6-astra", thinking: "high" } as const;
export const MAX_TURNS = 12;
export const WALL_TIMEOUT_MS = 120_000;
export const TOOLS = ["read", "ffgrep", "fffind"] as const;

const EVAL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_DIR = resolve(EVAL_DIR, "..");
const FIXTURE_DIR = join(EVAL_DIR, "fixtures", "source-snapshot");
const SNAPSHOT_MANIFEST_PATH = join(EVAL_DIR, "fixtures", "snapshot-manifest.json");
const RESULTS_DIR = join(PROJECT_DIR, "results");

const SYSTEM_PROMPT = [
  "You are evaluating read-only code navigation over a disposable TypeScript source snapshot.",
  "Use ffgrep as the primary content locator and fffind for path discovery; choose search patterns yourself and then read relevant files.",
  "Do not modify files. Do not infer facts you did not verify in source.",
  "Your final response must be JSON only with exactly this shape: {\"paths\":[\"repo/relative.ts\"],\"facts\":[\"specific verified fact\"]}.",
  "Use repository-relative paths and put each independently checkable claim in facts.",
].join(" ");

export type RunSelection = {
  tasks: readonly NavigationTask[];
  orders: readonly SearchOrder[];
};

export type PlanRow = {
  taskId: string;
  order: SearchOrder;
};

export type SnapshotManifest = {
  snapshotId: string;
  sourceProject: string;
  policy: string;
  files: Array<{ path: string; sha256: string }>;
};

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

type UsageTotals = Usage & { reports: number };

type TranscriptTurn = {
  turn: number;
  assistant: {
    content: unknown;
    usage?: Usage;
    stopReason?: string;
    errorMessage?: string;
  };
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    content: unknown;
    details: unknown;
    usage?: Usage;
    isError: boolean;
  }>;
};

export type SearchObservation = {
  turn: number;
  toolCallId: string;
  args?: unknown;
  details: unknown;
  isError: boolean;
};

export type ComparisonGate = {
  passed: boolean;
  structuredAnswerValid: boolean;
  qualifyingCalls: number;
  exposedPools: number;
  exposedPoolSizeSum: number;
  modelRerankCalls: number;
  fallbackObserved: boolean;
  orderChangedObserved: boolean;
  reasons: string[];
};

export type RunOutcome = {
  taskId: string;
  order: SearchOrder;
  status: "ok" | "timeout" | "turn_limit" | "error";
  elapsedMs: number;
  turns: number;
  maxTurns: number;
  wallTimeoutMs: number;
  ffgrepUsed: boolean;
  contrastEligible: boolean;
  comparisonGate: ComparisonGate;
  toolCounts: Record<string, number>;
  searchObservations: SearchObservation[];
  /** Main-model assistant usage; every assistant report is summed. */
  usage: UsageTotals;
  /** Tool-reported usage, including Jev reranking. */
  toolUsage: UsageTotals;
  /** Assistant plus tool usage/cost. */
  totalUsage: UsageTotals;
  finalAnswer: string;
  grade: Grade;
  error?: { name: string; message: string };
  diagnostics: {
    extensionLoadErrors: Array<{ path: string; error: string }>;
    resourceDiagnostics: unknown[];
    extensionRuntimeErrors: Array<{ extensionPath: string; error: string }>;
    activeTools: string[];
  };
};

export function buildPlan(selection: RunSelection): PlanRow[] {
  return selection.tasks.flatMap((task) => selection.orders.map((order) => ({ taskId: task.id, order })));
}

export function defaultSelection(): RunSelection {
  return { tasks: TASKS, orders: SEARCH_ORDERS };
}

export async function loadSnapshotManifest(): Promise<SnapshotManifest> {
  return JSON.parse(await readFile(SNAPSHOT_MANIFEST_PATH, "utf8")) as SnapshotManifest;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function verifySnapshot(root = FIXTURE_DIR): Promise<SnapshotManifest> {
  const manifest = await loadSnapshotManifest();
  for (const file of manifest.files) {
    if (!file.path.endsWith(".ts") || file.path.includes("..")) {
      throw new Error(`Unsafe snapshot manifest path: ${file.path}`);
    }
    const actual = await sha256(join(root, file.path));
    if (actual !== file.sha256) {
      throw new Error(`Snapshot hash mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`);
    }
  }
  return manifest;
}

function timestampId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    reports: 0,
  };
}

function addUsage(total: UsageTotals, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0);
  total.totalTokens += usage.totalTokens ?? 0;
  total.cost.input += usage.cost?.input ?? 0;
  total.cost.output += usage.cost?.output ?? 0;
  total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
  total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
  total.cost.total += usage.cost?.total ?? 0;
  total.reports += 1;
}

function combinedUsage(...groups: UsageTotals[]): UsageTotals {
  const total = emptyUsage();
  for (const group of groups) {
    total.input += group.input;
    total.output += group.output;
    total.cacheRead += group.cacheRead;
    total.cacheWrite += group.cacheWrite;
    total.reasoning = (total.reasoning ?? 0) + (group.reasoning ?? 0);
    total.totalTokens += group.totalTokens;
    total.cost.input += group.cost.input;
    total.cost.output += group.cost.output;
    total.cost.cacheRead += group.cost.cacheRead;
    total.cost.cacheWrite += group.cost.cacheWrite;
    total.cost.total += group.cost.total;
    total.reports += group.reports;
  }
  return total;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function rerankRecord(details: unknown): Record<string, unknown> | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const rerank = (details as { rerank?: unknown }).rerank;
  return typeof rerank === "object" && rerank !== null
    ? rerank as Record<string, unknown>
    : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function structuredAnswerIsValid(grade: Grade): boolean {
  return grade.parsed && grade.missingPaths.length === 0 && (grade.answer?.facts.length ?? 0) > 0;
}

/** Evaluate whether one run supplies usable within-run arm evidence. */
export function evaluateComparisonGate(input: {
  order: SearchOrder;
  status: RunOutcome["status"];
  grade: Grade;
  observations: Array<Pick<SearchObservation, "details" | "isError">>;
}): ComparisonGate {
  const successful = input.observations.filter((observation) =>
    !observation.isError && rerankRecord(observation.details) !== undefined);
  const qualifying = successful.filter((observation) =>
    numeric(rerankRecord(observation.details)?.poolSize) > 1);
  const poolStarts = qualifying.filter((observation, index) => {
    const rerank = rerankRecord(observation.details);
    return numeric(rerank?.scanCalls) > 0 || numeric(rerank?.calls) > 0 || index === 0;
  });
  const modelRerankCalls = successful.reduce((sum, observation) =>
    sum + numeric(rerankRecord(observation.details)?.calls), 0);
  const fallbackObserved = successful.some((observation) => {
    const fallback = rerankRecord(observation.details)?.fallback;
    return typeof fallback === "string" ? fallback.trim().length > 0 : fallback !== undefined && fallback !== false;
  });
  const orderChangedObserved = successful.some(
    (observation) => rerankRecord(observation.details)?.orderChanged === true,
  );
  const structuredAnswerValid = structuredAnswerIsValid(input.grade);
  const reasons: string[] = [];
  if (input.status !== "ok") reasons.push(`run status is ${input.status}`);
  if (!structuredAnswerValid) reasons.push("final answer is not valid structured paths/facts output with required paths");
  if (qualifying.length === 0) reasons.push("no successful ffgrep candidate pool larger than one");
  if (input.order === "jev") {
    if (modelRerankCalls <= 0) reasons.push("Jev made no ranking API calls");
    if (fallbackObserved) reasons.push("Jev fallback was observed");
    if (!orderChangedObserved) reasons.push("Jev did not change candidate order in any exposed pool");
  } else if (modelRerankCalls > 0) {
    reasons.push(`${input.order} unexpectedly made ranking API calls`);
  }
  return {
    passed: reasons.length === 0,
    structuredAnswerValid,
    qualifyingCalls: qualifying.length,
    exposedPools: poolStarts.length,
    exposedPoolSizeSum: poolStarts.reduce(
      (sum, observation) => sum + numeric(rerankRecord(observation.details)?.poolSize), 0),
    modelRerankCalls,
    fallbackObserved,
    orderChangedObserved,
    reasons,
  };
}

function toolArgs(content: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (!Array.isArray(content)) return result;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const call = part as { type?: unknown; id?: unknown; arguments?: unknown };
    if (call.type === "toolCall" && typeof call.id === "string") result.set(call.id, call.arguments);
  }
  return result;
}

function promptFor(task: NavigationTask): string {
  return [
    `Navigation task (${task.id}): ${task.prompt}`,
    "Work only in the supplied snapshot. This is navigation correctness, not feature implementation.",
    "Use ffgrep to locate relevant content, but choose the search terms and sequence yourself.",
    "Return JSON only in the required paths/facts shape.",
  ].join("\n\n");
}

function resourceDiagnostics(loader: DefaultResourceLoader): unknown[] {
  return [
    ...loader.getSkills().diagnostics,
    ...loader.getPrompts().diagnostics,
    ...loader.getThemes().diagnostics,
  ];
}

function pathIsConfined(workspace: string, value: string): boolean {
  if (value.startsWith("~") || /(^|[\\/,{])\.\.([\\/,}]|$)/.test(value)) return false;
  const root = resolve(workspace);
  const target = resolve(root, value);
  return target === root || target.startsWith(`${root}/`);
}

/** Default vendored FFF factory plus a harness-only workspace boundary. */
export function confinedFffExtension(workspace: string): InlineExtension {
  return {
    name: "fff-eval",
    factory: (pi: ExtensionAPI) => {
      fffExtension(pi);
      pi.on("tool_call", (event) => {
        if (event.toolName !== "read" && event.toolName !== "ffgrep" && event.toolName !== "fffind") return undefined;
        const path = event.input.path;
        if (typeof path !== "string" || pathIsConfined(workspace, path)) return undefined;
        return { block: true, reason: "Evaluation tools are confined to the disposable source snapshot." };
      });
    },
  };
}

function setControlledEnvironment(order: SearchOrder, runtimeDir: string): () => void {
  const changes: Record<string, string> = {
    JEV_SEARCH_ORDER: order,
    PI_FFF_MODE: "tools-only",
    FFF_ENABLE_HOME_SCAN: "0",
    FFF_WARN_HOME_SCAN: "0",
    FFF_FRECENCY_DB: join(runtimeDir, "fff-frecency.sqlite"),
    FFF_HISTORY_DB: join(runtimeDir, "fff-history.sqlite"),
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

async function runOne(
  task: NavigationTask,
  order: SearchOrder,
  runDir: string,
  modelRuntime: ModelRuntime,
): Promise<RunOutcome> {
  const started = Date.now();
  const workspace = join(runDir, "workspace");
  const runtimeDir = join(runDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await cp(FIXTURE_DIR, workspace, { recursive: true, errorOnExist: true });
  await verifySnapshot(workspace);

  const restoreEnvironment = setControlledEnvironment(order, runtimeDir);
  const transcript: TranscriptTurn[] = [];
  const extensionRuntimeErrors: Array<{ extensionPath: string; error: string }> = [];
  const toolCounts: Record<string, number> = {};
  const searchObservations: SearchObservation[] = [];
  const usage = emptyUsage();
  const toolUsage = emptyUsage();
  let finalAnswer = "";
  let turns = 0;
  let timedOut = false;
  let turnLimited = false;
  let runError: { name: string; message: string } | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let diagnostics: RunOutcome["diagnostics"] = {
    extensionLoadErrors: [],
    resourceDiagnostics: [],
    extensionRuntimeErrors,
    activeTools: [],
  };

  try {
    const model = modelRuntime.getModel(MODEL.provider, MODEL.id);
    if (!model) throw new Error(`Configured model not found: ${MODEL.provider}/${MODEL.id}`);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: WALL_TIMEOUT_MS } },
      defaultTools: [...TOOLS],
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    const inlineFFF = confinedFffExtension(workspace);
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: join(runtimeDir, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [inlineFFF],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const extensionLoadErrors = loader.getExtensions().errors.map((error) => ({
      path: error.path,
      error: error.error,
    }));
    const discoveredDiagnostics = resourceDiagnostics(loader);
    diagnostics = {
      extensionLoadErrors,
      resourceDiagnostics: discoveredDiagnostics,
      extensionRuntimeErrors,
      activeTools: [],
    };
    if (extensionLoadErrors.length || discoveredDiagnostics.length) {
      throw new Error("Resource loader diagnostics were not clean");
    }
    if (loader.getAgentsFiles().agentsFiles.length !== 0) {
      throw new Error("Context-file isolation failed: agents files were loaded");
    }

    const created = await createAgentSession({
      cwd: workspace,
      agentDir: join(runtimeDir, "agent"),
      modelRuntime,
      model,
      thinkingLevel: MODEL.thinking,
      tools: [...TOOLS],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace),
      settingsManager,
    });
    session = created.session;

    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        extensionRuntimeErrors.push({ extensionPath: error.extensionPath, error: error.error });
      },
      abortHandler: () => undefined,
      shutdownHandler: () => undefined,
    });
    diagnostics.activeTools = session.extensionRunner.getActiveTools();
    if (extensionRuntimeErrors.length) throw new Error("Extension runtime diagnostics were not clean");
    for (const required of TOOLS) {
      if (!diagnostics.activeTools.includes(required)) throw new Error(`Required tool is inactive: ${required}`);
    }

    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "turn_end") return;
      turns += 1;
      const message = event.message as {
        role?: string;
        content?: unknown;
        usage?: Usage;
        stopReason?: string;
        errorMessage?: string;
      };
      if (message.role === "assistant") {
        addUsage(usage, message.usage);
        const text = textFromContent(message.content);
        if (text) finalAnswer = text;
        if (message.stopReason === "error") {
          runError ??= { name: "AssistantError", message: message.errorMessage ?? "assistant response failed" };
        }
      }
      const argsById = toolArgs(message.content);
      const normalizedResults = event.toolResults.map((result) => {
        toolCounts[result.toolName] = (toolCounts[result.toolName] ?? 0) + 1;
        addUsage(toolUsage, result.usage as Usage | undefined);
        if (result.toolName === "ffgrep") {
          searchObservations.push({
            turn: turns,
            toolCallId: result.toolCallId,
            args: argsById.get(result.toolCallId),
            details: result.details,
            isError: result.isError,
          });
        }
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: result.content,
          details: result.details,
          usage: result.usage as Usage | undefined,
          isError: result.isError,
        };
      });
      transcript.push({
        turn: turns,
        assistant: {
          content: message.content,
          usage: message.usage,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
        },
        toolResults: normalizedResults,
      });
      if (turns >= MAX_TURNS && normalizedResults.length > 0) {
        turnLimited = true;
        void session?.abort();
      }
    });

    const remainingMs = WALL_TIMEOUT_MS - (Date.now() - started);
    if (remainingMs <= 0) {
      timedOut = true;
      throw new Error("Run setup exhausted the wall-clock bound");
    }
    timer = setTimeout(() => {
      timedOut = true;
      void session?.abort();
    }, remainingMs);
    timer.unref?.();
    await session.prompt(promptFor(task), { expandPromptTemplates: false, source: "rpc" });
    if (extensionRuntimeErrors.length) throw new Error("Extension runtime diagnostics were not clean");
  } catch (error) {
    runError = safeError(error);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    if (session) {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } catch (error) {
        runError ??= safeError(error);
      }
      session.dispose();
    }
    restoreEnvironment();
  }

  const ffgrepUsed = (toolCounts.ffgrep ?? 0) > 0;
  const status: RunOutcome["status"] = timedOut
    ? "timeout"
    : turnLimited
      ? "turn_limit"
      : runError
        ? "error"
        : "ok";
  const grade = gradeAnswer(task, finalAnswer);
  const comparisonGate = evaluateComparisonGate({
    order,
    status,
    grade,
    observations: searchObservations,
  });
  const outcome: RunOutcome = {
    taskId: task.id,
    order,
    status,
    elapsedMs: Date.now() - started,
    turns,
    maxTurns: MAX_TURNS,
    wallTimeoutMs: WALL_TIMEOUT_MS,
    ffgrepUsed,
    contrastEligible: comparisonGate.passed,
    comparisonGate,
    toolCounts,
    searchObservations,
    usage,
    toolUsage,
    totalUsage: combinedUsage(usage, toolUsage),
    finalAnswer,
    grade,
    ...(runError ? { error: runError } : {}),
    diagnostics,
  };
  await writeJson(join(runDir, "transcript.json"), {
    taskId: task.id,
    order,
    prompt: promptFor(task),
    turns: transcript,
  });
  await writeJson(join(runDir, "outcome.json"), outcome);
  return outcome;
}

function sumOutcomes(outcomes: RunOutcome[]) {
  const usage = emptyUsage();
  for (const outcome of outcomes) {
    usage.input += outcome.totalUsage.input;
    usage.output += outcome.totalUsage.output;
    usage.cacheRead += outcome.totalUsage.cacheRead;
    usage.cacheWrite += outcome.totalUsage.cacheWrite;
    usage.reasoning = (usage.reasoning ?? 0) + (outcome.totalUsage.reasoning ?? 0);
    usage.totalTokens += outcome.totalUsage.totalTokens;
    usage.cost.input += outcome.totalUsage.cost.input;
    usage.cost.output += outcome.totalUsage.cost.output;
    usage.cost.cacheRead += outcome.totalUsage.cost.cacheRead;
    usage.cost.cacheWrite += outcome.totalUsage.cost.cacheWrite;
    usage.cost.total += outcome.totalUsage.cost.total;
    usage.reports += outcome.totalUsage.reports;
  }
  return usage;
}

export async function runLive(selection: RunSelection): Promise<{ resultDir: string; outcomes: RunOutcome[] }> {
  const plan = buildPlan(selection);
  if (plan.length < 1 || plan.length > 9) throw new Error(`Live plan must contain 1..9 runs; got ${plan.length}`);
  const snapshot = await verifySnapshot();
  const resultDir = join(RESULTS_DIR, timestampId());
  await mkdir(resultDir, { recursive: false });
  await writeJson(join(resultDir, "manifest.json"), {
    mode: "live",
    createdAt: new Date().toISOString(),
    model: MODEL,
    bounds: { runs: plan.length, maxRuns: 9, maxTurnsPerRun: MAX_TURNS, wallTimeoutMsPerRun: WALL_TIMEOUT_MS },
    tools: TOOLS,
    writableScope: "ignored results directory only; agents receive read/ffgrep/fffind and disposable snapshots",
    sourceSnapshot: snapshot,
    plan,
  });

  const modelRuntime = await ModelRuntime.create();
  const configuredModel = modelRuntime.getModel(MODEL.provider, MODEL.id);
  if (!configuredModel) throw new Error(`Configured model not found: ${MODEL.provider}/${MODEL.id}`);
  if (!modelRuntime.hasConfiguredAuth(MODEL.provider)) {
    throw new Error(`No configured authentication for provider: ${MODEL.provider}`);
  }
  const outcomes: RunOutcome[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const row = plan[index];
    const task = selection.tasks.find((candidate) => candidate.id === row.taskId);
    if (!task) throw new Error(`Plan references unknown task: ${row.taskId}`);
    const runDir = join(resultDir, `run-${String(index + 1).padStart(2, "0")}-${row.taskId}-${row.order}`);
    await mkdir(runDir, { recursive: false });
    outcomes.push(await runOne(task, row.order, runDir, modelRuntime));
  }

  const unused = outcomes.filter((outcome) => !outcome.ffgrepUsed).length;
  const failedGate = outcomes.filter((outcome) => !outcome.comparisonGate.passed).length;
  const hasJevRun = outcomes.some((outcome) => outcome.order === "jev");
  const summary = {
    sampleSize: outcomes.length,
    note: "This small navigation-only sample is insufficient to choose coding efficacy or justify daily rollout.",
    contrast: unused > 0
      ? `${unused} run(s) did not use ffgrep and provide no search-order contrast.`
      : failedGate > 0
        ? `${failedGate} run(s) failed one or more comparison gates; inspect each row's reasons.`
        : "All runs passed status, structured-answer, search-exposure, and arm-specific telemetry gates; results still cover navigation correctness only.",
    comparisonValid: hasJevRun && failedGate === 0,
    comparisonInvalidReason: !hasJevRun
      ? "No Jev run was evaluated."
      : failedGate > 0
        ? `${failedGate} run(s) failed status, structured-answer, search-exposure, API-isolation, fallback, or changed-order gates.`
        : undefined,
    usage: sumOutcomes(outcomes),
    rows: outcomes.map((outcome) => ({
      taskId: outcome.taskId,
      order: outcome.order,
      status: outcome.status,
      score: outcome.grade.score,
      maxScore: outcome.grade.maxScore,
      turns: outcome.turns,
      ffgrepUsed: outcome.ffgrepUsed,
      comparisonEligible: outcome.comparisonGate.passed,
      comparisonGateReasons: outcome.comparisonGate.reasons,
      structuredAnswerValid: outcome.comparisonGate.structuredAnswerValid,
      qualifyingFfgrepCalls: outcome.comparisonGate.qualifyingCalls,
      exposedPools: outcome.comparisonGate.exposedPools,
      exposedPoolSizeSum: outcome.comparisonGate.exposedPoolSizeSum,
      modelRerankCalls: outcome.comparisonGate.modelRerankCalls,
      fallbackObserved: outcome.comparisonGate.fallbackObserved,
      orderChangedObserved: outcome.comparisonGate.orderChangedObserved,
      assistantInputTokens: outcome.usage.input,
      assistantOutputTokens: outcome.usage.output,
      toolInputTokens: outcome.toolUsage.input,
      toolOutputTokens: outcome.toolUsage.output,
      totalTokens: outcome.totalUsage.totalTokens,
      cost: outcome.totalUsage.cost.total,
      elapsedMs: outcome.elapsedMs,
    })),
  };
  await writeJson(join(resultDir, "summary.json"), summary);
  return { resultDir, outcomes };
}
