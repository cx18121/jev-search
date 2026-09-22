import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { DockerWorkspace } from "./docker.ts";
import { applyPatch, buildSourcePatch, gradeWorkspace } from "./grading.ts";
import { fixturePath, hashTree, sha256File, type LoadedManifest, verifyFixture } from "./manifest.ts";
import { buildPlan } from "./plan.ts";
import { WorkspaceGuard } from "./path-guard.ts";
import { codingExtension, createConfinedCodingTools, TOOL_NAMES } from "./tools.ts";
import type { Arm, CodingTask, GradeResult, PlanRow, RunStatus, Usage, UsageTotals } from "./types.ts";

export const MODEL = { provider: "openai-codex", id: "gpt-6-astra", thinking: "high" } as const;
export const MAX_TURNS = 40;
export const WALL_TIMEOUT_MS = 8 * 60_000;
export const RUN_COST_LIMIT_USD = 3;
export const CAMPAIGN_COST_LIMIT_USD = 60;

const PROJECT_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const RESULTS_DIR = join(PROJECT_DIR, "results", "coding");

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, reports: 0 };
}

function addUsage(total: UsageTotals, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0);
  total.totalTokens += usage.totalTokens ?? 0;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost?.[field] ?? 0;
  total.reports += 1;
}

function combined(first: UsageTotals, second: UsageTotals): UsageTotals {
  const result = emptyUsage();
  addUsage(result, first);
  result.reports -= 1;
  addUsage(result, second);
  result.reports = first.reports + second.reports;
  return result;
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeError(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

function timestampId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function setEnvironment(arm: Arm, runtimeDir: string): () => void {
  const values: Record<string, string> = {
    PI_FFF_MODE: "tools-only",
    FFF_ENABLE_HOME_SCAN: "0",
    FFF_ENABLE_ROOT_SCAN: "0",
    FFF_WARN_HOME_SCAN: "0",
    FFF_FOLLOW_SYMLINKS: "0",
    FFF_FRECENCY_DB: join(runtimeDir, "frecency.sqlite"),
    FFF_HISTORY_DB: join(runtimeDir, "history.sqlite"),
    PI_CODING_AGENT_DIR: join(runtimeDir, "agent"),
    JEV_SEARCH_ORDER: arm === "jev" ? "jev" : "deterministic",
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) { previous.set(name, process.env[name]); process.env[name] = value; }
  return () => { for (const [name, value] of previous) value === undefined ? delete process.env[name] : process.env[name] = value; };
}

function prompt(task: CodingTask): string {
  const tests = task.repo === "sympy/sympy"
    ? "This is Python 3.8; source is /workspace; network is off. Run relevant SymPy tests with python bin/test."
    : task.repo === "pytest-dev/pytest"
      ? "This is Python 3.8; source is /workspace; network is off. Run relevant tests with PYTHONPATH=/workspace/src python -m pytest."
      : "This is Python 3.8; source is /workspace; network is off. Run relevant tests with python -m pytest.";
  return [
    `Bug-fix task (${task.id}): ${task.title}`,
    task.prompt,
    "Work only in /workspace. For read/edit/write/ffgrep/fffind use repo-relative paths; /workspace is the Bash working directory. Implement the fix; do not edit tests, conftest files, or configuration that weakens tests.",
    tests,
    "Use ffgrep as the primary content locator and fffind for path discovery. Bash is available in an isolated network-free container for running tests and other repository commands; grep through Bash is allowed but measured as a search bypass.",
    "Do not seek hidden tests, a gold patch, credentials, or repository history. Finish with a concise summary and tests run.",
  ].join("\n\n");
}

function text(content: unknown): string {
  return Array.isArray(content) ? content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n") : "";
}

async function freshTree(base: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await cp(base, destination, { recursive: true, verbatimSymlinks: true });
  await mkdir(join(destination, ".harness"), { recursive: true });
}

function host(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject); child.on("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function extractBase(loaded: LoadedManifest, task: CodingTask, destination: string): Promise<void> {
  const archive = fixturePath(loaded, task.baseArchive);
  const listing = await host("tar", ["-tzf", archive]);
  if (listing.code !== 0) throw new Error(`cannot inspect base archive: ${listing.stderr}`);
  const prefix = task.workspacePrefix.replace(/\/$/, "");
  for (const entry of listing.stdout.split("\n").filter(Boolean)) {
    if (!entry.startsWith(`${prefix}/`) || entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\0")) throw new Error(`unsafe base archive entry: ${entry}`);
  }
  await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
  const extracted = await host("tar", ["-xzf", archive, "--strip-components=1", "-C", destination]);
  if (extracted.code !== 0) throw new Error(`cannot extract base archive: ${extracted.stderr}`);
  await rm(join(destination, ".git"), { recursive: true, force: true });
  await mkdir(join(destination, ".harness"), { recursive: true });
}

async function startTaskContainer(input: { workspace: string; image: string; name: string; task: CodingTask }): Promise<DockerWorkspace> {
  const container = new DockerWorkspace({ workspace: input.workspace, image: input.image, name: input.name });
  await container.start();
  return container;
}

export type PreflightResult = { passed: boolean; isolation: unknown[]; tasks: Array<{ taskId: string; baseline: GradeResult; gold: GradeResult }> };

async function isolationProbe(loaded: LoadedManifest, task: CodingTask, resultDir: string): Promise<Record<string, unknown>> {
  const workspace = join(resultDir, "isolation", task.image.ref.replace(/[^a-zA-Z0-9.-]/g, "-"));
  await extractBase(loaded, task, workspace);
  const guard = await WorkspaceGuard.create(workspace);
  const container = await startTaskContainer({ workspace, image: task.image.ref, name: `jev-probe-${randomUUID().slice(0, 6)}`, task });
  try {
    const tools = createConfinedCodingTools(guard, container);
    const byName = (name: string) => {
      const found = tools.find((tool) => tool.name === name);
      if (!found) throw new Error(`probe tool missing: ${name}`);
      return found;
    };
    const bash = await byName("bash").execute("probe-bash", { command: "pwd; env" }, undefined, undefined, {} as never);
    const output = text(bash.content);
    if (!output.includes("/workspace") || /TYPESAFE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|PI_CODING_AGENT_DIR/.test(output)) throw new Error(`container environment isolation probe failed: ${output}`);
    const failures: string[] = [];
    for (const [label, tool, params] of [
      ["outside-read", byName("read"), { path: "/etc/passwd" }],
      ["outside-write", byName("write"), { path: "../outside", content: "denied" }],
    ] as const) {
      try { await tool.execute(`probe-${label}`, params as never, undefined, undefined, {} as never); failures.push(label); } catch { /* required rejection */ }
    }
    const linked = await container.exec(["bash", "-lc", "ln -s /etc/passwd escape-file && ln -s /tmp escape-parent"]);
    if (linked.exitCode !== 0) throw new Error(`symlink probe setup failed: ${linked.stderr}`);
    for (const [label, tool, params] of [
      ["symlink-read", byName("read"), { path: "escape-file" }],
      ["symlink-parent-write", byName("write"), { path: "escape-parent/out", content: "denied" }],
    ] as const) {
      try { await tool.execute(`probe-${label}`, params as never, undefined, undefined, {} as never); failures.push(label); } catch { /* required rejection */ }
    }
    if (failures.length) throw new Error(`host tool confinement probes unexpectedly succeeded: ${failures.join(", ")}`);
    return { image: task.image, passed: true, bashOutput: output, blocked: ["outside-read", "outside-write", "symlink-read", "symlink-parent-write"] };
  } finally { await container.stop().catch(() => undefined); }
}

/** Mandatory, model-free isolation, baseline-fail, and gold-pass verification. */
export async function runPreflight(loaded: LoadedManifest, resultDir: string): Promise<PreflightResult> {
  const rows: PreflightResult["tasks"] = [];
  const isolation: unknown[] = [];
  const seenImages = new Set<string>();
  for (const task of loaded.manifest.tasks) {
    if (seenImages.has(task.image.ref)) continue;
    seenImages.add(task.image.ref);
    await verifyFixture(loaded, task);
    await DockerWorkspace.verifyImage(task.image.ref, task.image.id, task.image.platform);
    const probe = await isolationProbe(loaded, task, resultDir);
    isolation.push(probe);
    await json(join(resultDir, "isolation", `${task.image.ref.replace(/[^a-zA-Z0-9.-]/g, "-")}.json`), probe);
  }
  for (let index = 0; index < loaded.manifest.tasks.length; index += 1) {
    const task = loaded.manifest.tasks[index];
    await verifyFixture(loaded, task);
    await DockerWorkspace.verifyImage(task.image.ref, task.image.id, task.image.platform);
    const evidence = join(resultDir, "preflight", task.id);
    const baselineWorkspace = join(evidence, "baseline-workspace");
    await extractBase(loaded, task, baselineWorkspace);
    let baselineContainer: DockerWorkspace | undefined;
    let goldContainer: DockerWorkspace | undefined;
    try {
      baselineContainer = await startTaskContainer({ workspace: baselineWorkspace, image: task.image.ref, name: `jev-pre-base-${index}-${randomUUID().slice(0, 6)}`, task });
      await applyPatch(baselineWorkspace, fixturePath(loaded, task.withheldTestPatch));
      const baseline = await gradeWorkspace({ container: baselineContainer, task, mode: "baseline", evidenceDir: evidence, label: "baseline" });
      await baselineContainer.stop(); baselineContainer = undefined;

      const goldWorkspace = join(evidence, "gold-workspace");
      await extractBase(loaded, task, goldWorkspace);
      goldContainer = await startTaskContainer({ workspace: goldWorkspace, image: task.image.ref, name: `jev-pre-gold-${index}-${randomUUID().slice(0, 6)}`, task });
      await applyPatch(goldWorkspace, fixturePath(loaded, task.goldPatch));
      await applyPatch(goldWorkspace, fixturePath(loaded, task.withheldTestPatch));
      const gold = await gradeWorkspace({ container: goldContainer, task, mode: "candidate", evidenceDir: evidence, label: "gold" });
      await goldContainer.stop(); goldContainer = undefined;
      rows.push({ taskId: task.id, baseline, gold });
      await json(join(evidence, "result.json"), rows.at(-1));
      if (!baseline.passed || !gold.passed) throw new Error(`preflight gate failed for ${task.id}: baseline=${baseline.reasons.join("; ")} gold=${gold.reasons.join("; ")}`);
    } finally {
      await baselineContainer?.stop().catch(() => undefined);
      await goldContainer?.stop().catch(() => undefined);
    }
  }
  return { passed: isolation.length === 3 && rows.length === 5 && rows.every((row) => row.baseline.passed && row.gold.passed), isolation, tasks: rows };
}

export type CodingOutcome = {
  row: PlanRow;
  status: RunStatus;
  terminationReason?: RunStatus;
  elapsedMs: number;
  turns: number;
  usage: UsageTotals;
  toolUsage: UsageTotals;
  totalUsage: UsageTotals;
  actualJevCostUsd: number;
  toolCounts: Record<string, number>;
  bashSearchBypassCalls: number;
  fffMetrics: unknown[];
  finalAnswer: string;
  patch: { path: string; changedPaths: string[]; excludedTestPaths: string[] };
  grade?: GradeResult;
  error?: { name: string; message: string };
  gradingError?: { name: string; message: string };
};

export function outcomeStatus(grade: GradeResult | undefined, stop: RunStatus | undefined): RunStatus {
  if (!grade) return "infra_error";
  return grade.passed ? "solved" : stop ?? "unsolved";
}

async function runOne(input: {
  loaded: LoadedManifest;
  task: CodingTask;
  row: PlanRow;
  runDir: string;
  runtime: ModelRuntime;
  campaignCostBefore: number;
}): Promise<CodingOutcome> {
  const started = Date.now();
  const workspace = join(input.runDir, "agent-workspace");
  const runtimeDir = join(input.runDir, "runtime");
  const base = join(input.runDir, "base-reference");
  await extractBase(input.loaded, input.task, base);
  await freshTree(base, workspace);
  await mkdir(runtimeDir, { recursive: true });
  const guard = await WorkspaceGuard.create(workspace);
  let container: DockerWorkspace | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let restore: () => void = () => {};
  let turns = 0;
  let stop: RunStatus | undefined;
  let error: { name: string; message: string } | undefined;
  let finalAnswer = "";
  const usage = emptyUsage();
  const toolUsage = emptyUsage();
  const toolCounts: Record<string, number> = {};
  const fffMetrics: unknown[] = [];
  const transcript: unknown[] = [];
  let bashSearchBypassCalls = 0;

  const halt = (reason: RunStatus) => {
    stop ??= reason;
    void session?.abort();
    void container?.stop();
  };

  try {
    container = await startTaskContainer({ workspace, image: input.task.image.ref, name: `jev-run-${input.row.index}-${randomUUID().slice(0, 6)}`, task: input.task });
    restore = setEnvironment(input.row.arm, runtimeDir);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: WALL_TIMEOUT_MS } },
      defaultTools: [...TOOL_NAMES], enableAnalytics: false, enableInstallTelemetry: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: workspace, agentDir: join(runtimeDir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [codingExtension(input.row.arm)],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => "You are a coding agent in a disposable, isolated bug-fix workspace. Follow the user's task and tool security boundaries exactly.",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const loadErrors = loader.getExtensions().errors;
    if (loadErrors.length) throw new Error(`extension load failed: ${loadErrors.map((item) => item.error).join("; ")}`);
    const customTools = createConfinedCodingTools(guard, container);
    const model = input.runtime.getModel(MODEL.provider, MODEL.id);
    if (!model) throw new Error(`model unavailable: ${MODEL.provider}/${MODEL.id}`);
    const created = await createAgentSession({
      cwd: workspace, agentDir: join(runtimeDir, "agent"), modelRuntime: input.runtime, model,
      thinkingLevel: MODEL.thinking, tools: [...TOOL_NAMES], customTools, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace), settingsManager: settings,
    });
    session = created.session;
    const extensionErrors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (item) => extensionErrors.push(`${item.extensionPath}: ${item.error}`), abortHandler: () => halt("error"), shutdownHandler: () => undefined });
    if (extensionErrors.length) throw new Error(`extension runtime failed: ${extensionErrors.join("; ")}`);
    const active = session.extensionRunner.getActiveTools();
    for (const name of TOOL_NAMES) if (!active.includes(name)) throw new Error(`required tool inactive: ${name}`);
    if (active.some((name) => name === "grep" || name === "find" || name === "ls")) throw new Error(`unexpected bypass tool active: ${active.join(", ")}`);

    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "turn_end") return;
      turns += 1;
      const message = event.message as { role?: string; content?: unknown; usage?: Usage; stopReason?: string; errorMessage?: string };
      if (message.role === "assistant") {
        addUsage(usage, message.usage);
        const answer = text(message.content);
        if (answer) finalAnswer = answer;
        if (message.stopReason === "error") { error ??= { name: "AssistantError", message: message.errorMessage ?? "assistant response failed" }; halt("error"); }
      }
      const results = event.toolResults.map((result) => {
        toolCounts[result.toolName] = (toolCounts[result.toolName] ?? 0) + 1;
        addUsage(toolUsage, result.usage as Usage | undefined);
        if (result.toolName === "ffgrep") fffMetrics.push(result.details);
        if (result.toolName === "bash") {
          const call = Array.isArray(message.content) ? message.content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall" && (part as { id?: unknown }).id === result.toolCallId) as { arguments?: { command?: unknown } } | undefined : undefined;
          if (typeof call?.arguments?.command === "string" && /(^|[;&|\s])(grep|rg|find)(\s|$)/.test(call.arguments.command)) bashSearchBypassCalls += 1;
        }
        return { toolCallId: result.toolCallId, toolName: result.toolName, content: result.content, details: result.details, usage: result.usage, isError: result.isError };
      });
      transcript.push({ turn: turns, assistant: message, toolResults: results });
      const currentCost = usage.cost.total + toolUsage.cost.total;
      if (turns >= MAX_TURNS && results.length > 0) halt("turn_limit");
      else if (currentCost >= RUN_COST_LIMIT_USD || input.campaignCostBefore + currentCost >= CAMPAIGN_COST_LIMIT_USD) halt("cost_limit");
    });
    timer = setTimeout(() => halt("timeout"), WALL_TIMEOUT_MS);
    timer.unref?.();
    await session.prompt(prompt(input.task), { expandPromptTemplates: false, source: "rpc" });
  } catch (caught) {
    error ??= safeError(caught);
    stop ??= /docker|container|setup|extension load|required tool|model unavailable/i.test(error.message) ? "infra_error" : "error";
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    if (session) {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch (caught) { error ??= safeError(caught); }
      session.dispose();
    }
    await container?.stop().catch((caught) => { error ??= safeError(caught); stop ??= "infra_error"; });
    restore();
  }

  await json(join(input.runDir, "transcript.json"), { row: input.row, prompt: prompt(input.task), turns: transcript });
  const patchPath = join(input.runDir, "candidate-source.patch");
  let patch = { changedPaths: [] as string[], excludedTestPaths: [] as string[] };
  let grade: GradeResult | undefined;
  let gradingError: { name: string; message: string } | undefined;
  try {
    patch = await buildSourcePatch({ base, candidate: workspace, staging: join(input.runDir, "source-staging"), patchPath, task: input.task });
    const graderWorkspace = join(input.runDir, "grader-workspace");
    await freshTree(base, graderWorkspace);
    const grader = await startTaskContainer({ workspace: graderWorkspace, image: input.task.image.ref, name: `jev-grade-${input.row.index}-${randomUUID().slice(0, 6)}`, task: input.task });
    try {
      await applyPatch(graderWorkspace, patchPath);
      await applyPatch(graderWorkspace, fixturePath(input.loaded, input.task.withheldTestPatch));
      grade = await gradeWorkspace({ container: grader, task: input.task, mode: "candidate", evidenceDir: join(input.runDir, "grader-evidence"), label: "candidate" });
    } finally { await grader.stop().catch(() => undefined); }
  } catch (caught) {
    gradingError = safeError(caught);
  }
  const totalUsage = combined(usage, toolUsage);
  // A bounded partial patch is always graded. Passing the exact official IDs is
  // solved even if the session was then stopped at a turn/time/cost boundary.
  const status = outcomeStatus(grade, stop);
  const outcome: CodingOutcome = {
    row: input.row, status, ...(stop ? { terminationReason: stop } : {}), elapsedMs: Date.now() - started, turns, usage, toolUsage, totalUsage,
    actualJevCostUsd: input.row.arm === "jev" ? toolUsage.cost.total : 0,
    toolCounts, bashSearchBypassCalls, fffMetrics, finalAnswer,
    patch: { path: patchPath, ...patch }, ...(grade ? { grade } : {}), ...(error ? { error } : {}), ...(gradingError ? { gradingError } : {}),
  };
  await json(join(input.runDir, "outcome.json"), outcome);
  return outcome;
}

async function sourceMetadata(): Promise<Record<string, unknown>> {
  const packageJson = JSON.parse(await readFile(join(PROJECT_DIR, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string };
  return {
    codingRunnerSha256: await hashTree(join(PROJECT_DIR, "eval/coding")),
    stockFffSha256: await hashTree(join(PROJECT_DIR, "vendor/stock-pi-fff")),
    jevFffSha256: await hashTree(join(PROJECT_DIR, "vendor/pi-fff")),
    rankingCoreSha256: await hashTree(join(PROJECT_DIR, "src")),
    sdk: { package: "@earendil-works/pi-coding-agent", version: packageJson.version, packageJsonSha256: await sha256File(join(PROJECT_DIR, "node_modules/@earendil-works/pi-coding-agent/package.json")) },
  };
}

export async function dryRun(loaded: LoadedManifest): Promise<Record<string, unknown>> {
  const plan = buildPlan(loaded.manifest.tasks);
  return {
    mode: "dry-run", live: false, model: MODEL,
    bounds: { runs: plan.length, turnsPerRun: MAX_TURNS, wallTimeoutMsPerRun: WALL_TIMEOUT_MS, estimatedCostPerRunUsd: RUN_COST_LIMIT_USD, campaignCostUsd: CAMPAIGN_COST_LIMIT_USD, retries: 0, compaction: false },
    isolation: { network: "none", root: "read-only", workspaceMountOnly: true, user: "host uid:gid", capDrop: "ALL", noNewPrivileges: true },
    search: { fffMode: "tools-only", freshDatabasesEveryRun: true, followSymlinks: false, defaultLimit: 20, defaultContext: 3, outputCapUtf8Bytes: 12_000 },
    manifest: { path: loaded.path, sha256: loaded.sha256, campaignId: loaded.manifest.campaignId, fixtureVersion: loaded.manifest.fixtureVersion, images: [...new Map(loaded.manifest.tasks.map((task) => [task.image.ref, task.image])).values()] },
    sources: await sourceMetadata(), plan,
  };
}

export async function runLive(loaded: LoadedManifest): Promise<{ resultDir: string; outcomes: CodingOutcome[] }> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  if (!runtime.getModel(MODEL.provider, MODEL.id)) throw new Error(`configured strong model not found: ${MODEL.provider}/${MODEL.id}`);
  if (!runtime.hasConfiguredAuth(MODEL.provider)) throw new Error(`authentication unavailable for ${MODEL.provider}; campaign aborted before paid runs`);
  const resultDir = join(RESULTS_DIR, timestampId());
  await mkdir(RESULTS_DIR, { recursive: true });
  await mkdir(resultDir, { recursive: false });
  const frozen = await dryRun(loaded);
  await json(join(resultDir, "frozen-plan.json"), { ...frozen, mode: "live", live: true, frozenAt: new Date().toISOString() });
  const preflight = await runPreflight(loaded, resultDir);
  if (!preflight.passed) throw new Error("all five baseline-fail/gold-pass gates must pass before live runs");

  const plan = buildPlan(loaded.manifest.tasks);
  const outcomes: CodingOutcome[] = [];
  let campaignCost = 0;
  for (const row of plan) {
    if (campaignCost >= CAMPAIGN_COST_LIMIT_USD) break;
    console.error(`[coding] starting ${row.index}/${plan.length} ${row.taskId} repeat=${row.repeat} arm=${row.arm} spent=$${campaignCost.toFixed(4)}`);
    const task = loaded.manifest.tasks.find((item) => item.id === row.taskId);
    if (!task) throw new Error(`frozen plan references missing task: ${row.taskId}`);
    const runDir = join(resultDir, `run-${String(row.index).padStart(2, "0")}-${row.taskId}-r${row.repeat}-${row.arm}`);
    await mkdir(runDir, { recursive: false });
    const outcome = await runOne({ loaded, task, row, runDir, runtime, campaignCostBefore: campaignCost });
    outcomes.push(outcome);
    campaignCost += outcome.totalUsage.cost.total;
    console.error(`[coding] finished ${row.index}/${plan.length} status=${outcome.status} turns=${outcome.turns} cost=$${outcome.totalUsage.cost.total.toFixed(4)}`);
    await json(join(resultDir, "summary.json"), {
      completed: outcomes.length, planned: plan.length, campaignEstimatedCostUsd: campaignCost,
      actualJevCostUsd: outcomes.reduce((sum, item) => sum + item.actualJevCostUsd, 0), outcomes,
    });
    if (outcome.status === "infra_error" || (outcome.status === "error" && /auth|credential|unauthor|forbidden|rate limit/i.test(outcome.error?.message ?? ""))) {
      throw new Error(`campaign fail-fast after ${row.index}: ${outcome.gradingError?.message ?? outcome.error?.message ?? outcome.status}`);
    }
  }
  return { resultDir, outcomes };
}
