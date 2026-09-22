import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { hashTree, sha256File } from "../coding/manifest.ts";
import { WorkspaceGuard } from "../coding/path-guard.ts";
import { buildPlan, validatePlan } from "./plan.ts";
import {
  blindAndCapContent,
  contentText,
  createFirstCallState,
  createGuardedRead,
  effortExtension,
  expectedFirstArgs,
  neutralizeOrderFooter,
  OUTPUT_CAP_BYTES,
  TOOL_NAMES,
  type FirstCallState,
} from "./tools.ts";
import type { Arm, FrozenCandidate, FrozenDataset, FrozenPool, PlanRow, RunOutcome, RunStatus, Usage, UsageTotals } from "./types.ts";

export const MODEL = { provider: "openai-codex", id: "gpt-6-astra", thinking: "high" } as const;
export const MAX_TURNS = 12;
export const WALL_TIMEOUT_MS = 120_000;
export const RUN_COST_LIMIT_USD = 1;
export const CAMPAIGN_COST_LIMIT_USD = 12;
export const TRIPLE_RESERVE_USD = 3;
export const RETRIES = 0;

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const EFFORT_DIR = join(ROOT, "eval/effort");
const DATASET_PATH = join(ROOT, "eval/retrieval/frozen.json");
const QUERIES_PATH = join(ROOT, "eval/retrieval/queries.json");
const RETRIEVAL_PROTOCOL_PATH = join(ROOT, "eval/retrieval/README.md");
const PROTOCOL_PATH = join(EFFORT_DIR, "README.md");
const RUBRIC_PATH = join(EFFORT_DIR, "rubric.json");
const RESULTS_DIR = join(ROOT, "results/effort");

export const SYSTEM_PROMPT = [
  "You are a read-only source-navigation agent working in one pinned repository snapshot.",
  "Use only read, ffgrep and fffind. Never modify files and do not claim facts you did not verify in source or supplied search snippets.",
  "Do not mention search ordering, experiment arms, or harness mechanics.",
  "Answer plainly and concisely. Cite concrete claims with repo-relative path:line references. Do not return JSON and do not grade your own answer.",
].join(" ");

export const HARNESS_CONFIG = {
  model: MODEL,
  maxTurns: MAX_TURNS,
  wallTimeoutMs: WALL_TIMEOUT_MS,
  runCostLimitUsd: RUN_COST_LIMIT_USD,
  campaignCostLimitUsd: CAMPAIGN_COST_LIMIT_USD,
  tripleReserveUsd: TRIPLE_RESERVE_USD,
  retries: RETRIES,
  compaction: false,
  tools: TOOL_NAMES,
  searchDefaults: { limit: 20, context: 3 },
  outputCapUtf8Bytes: OUTPUT_CAP_BYTES,
  scans: { home: false, root: false, followSymlinks: false },
} as const;

function sha(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { return JSON.stringify(value); }
function timestampId(): string { return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`; }
function safeError(error: unknown): { name: string; message: string } { return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }; }
async function json(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, reports: 0 };
}
function addUsage(total: UsageTotals, value: Usage | undefined): void {
  if (!value) return;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += value[field] ?? 0;
  total.reasoning = (total.reasoning ?? 0) + (value.reasoning ?? 0);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += value.cost?.[field] ?? 0;
  total.reports += 1;
}
function combine(...groups: UsageTotals[]): UsageTotals {
  const result = emptyUsage();
  for (const group of groups) {
    result.input += group.input; result.output += group.output; result.cacheRead += group.cacheRead; result.cacheWrite += group.cacheWrite;
    result.reasoning = (result.reasoning ?? 0) + (group.reasoning ?? 0); result.totalTokens += group.totalTokens;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) result.cost[field] += group.cost[field];
    result.reports += group.reports;
  }
  return result;
}
function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

export function extractRerankMetrics(details: unknown): { calls: number; inputTokens: number; outputTokens: number; latencyMs: number; fallbackCount: number } {
  const rerank = record(record(details)?.rerank);
  return {
    calls: numeric(rerank?.calls), inputTokens: numeric(rerank?.inputTokens), outputTokens: numeric(rerank?.outputTokens), latencyMs: numeric(rerank?.latencyMs),
    fallbackCount: rerank?.fallback !== undefined && rerank.fallback !== false && String(rerank.fallback).trim() ? 1 : 0,
  };
}

export function shouldStartTriple(campaignCostUsd: number): boolean {
  return campaignCostUsd + TRIPLE_RESERVE_USD <= CAMPAIGN_COST_LIMIT_USD;
}

export async function loadDataset(): Promise<FrozenDataset> {
  const dataset = JSON.parse(await readFile(DATASET_PATH, "utf8")) as FrozenDataset;
  if (!Array.isArray(dataset.pools) || dataset.pools.length !== 10) throw new Error("frozen effort dataset must contain ten pools");
  if (dataset.queriesSha256 !== await sha256File(QUERIES_PATH)) throw new Error("frozen queries hash mismatch");
  if (dataset.protocolSha256 !== await sha256File(RETRIEVAL_PROTOCOL_PATH)) throw new Error("frozen retrieval protocol hash mismatch");
  const ids = dataset.pools.map((pool) => pool.query.id);
  if (new Set(ids).size !== 10) throw new Error("frozen effort query ids are not unique");
  return dataset;
}

async function validateRubric(dataset: FrozenDataset): Promise<void> {
  const rubric = JSON.parse(await readFile(RUBRIC_PATH, "utf8")) as { schemaVersion?: unknown; queries?: Array<{ queryId?: unknown; acceptableEvidence?: Array<{ path?: unknown; start?: unknown; end?: unknown }> }> };
  if (rubric.schemaVersion !== 1 || !Array.isArray(rubric.queries) || rubric.queries.length !== 10) throw new Error("effort rubric schema/query count mismatch");
  const expected = new Set(dataset.pools.map((pool) => pool.query.id));
  for (const row of rubric.queries) {
    if (typeof row.queryId !== "string" || !expected.delete(row.queryId)) throw new Error(`unexpected or duplicate rubric query: ${String(row.queryId)}`);
    if (!Array.isArray(row.acceptableEvidence) || row.acceptableEvidence.some((item) => typeof item.path !== "string" || !Number.isInteger(item.start) || !Number.isInteger(item.end) || Number(item.start) < 1 || Number(item.end) < Number(item.start))) throw new Error(`invalid rubric evidence ranges: ${row.queryId}`);
  }
  if (expected.size) throw new Error(`rubric is missing queries: ${[...expected].join(", ")}`);
}

function sourceRoots(dataset: FrozenDataset): Map<string, string> {
  const roots = new Map<string, string>();
  for (const pool of dataset.pools) {
    const previous = roots.get(pool.sourceRoot);
    if (previous && previous !== pool.sourceSha256) throw new Error(`conflicting source hashes for ${pool.sourceRoot}`);
    roots.set(pool.sourceRoot, pool.sourceSha256);
  }
  return roots;
}

export async function verifySources(dataset: FrozenDataset): Promise<Array<{ root: string; expected: string; actual: string }>> {
  const allowed = resolve(ROOT, "results/retrieval/pools-v2");
  const proof: Array<{ root: string; expected: string; actual: string }> = [];
  for (const [root, expected] of sourceRoots(dataset)) {
    const absolute = resolve(root);
    const rel = relative(allowed, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "" || rel.startsWith(sep)) throw new Error(`frozen source root is outside the pool directory: ${root}`);
    const actual = await hashTree(absolute);
    proof.push({ root: absolute, expected, actual });
    if (actual !== expected) throw new Error(`source hash mismatch for ${root}: expected ${expected}, got ${actual}`);
  }
  return proof;
}

export function promptFor(pool: FrozenPool): string {
  const first = expectedFirstArgs(pool.query);
  return [
    pool.query.intent,
    "First, call ffgrep with exactly these arguments (the mode is inferred by the tool and is not an argument):",
    JSON.stringify(first),
    "Until that exact search succeeds, no other tool call or different search is allowed. After it succeeds, investigate autonomously with read, ffgrep and fffind as needed.",
    "Give a concise plain-text answer with repo-relative path:line citations for concrete claims. Do not return JSON or discuss grading.",
  ].join("\n\n");
}

function setEnvironment(arm: Arm, runtimeDir: string): () => void {
  const changes: Record<string, string> = {
    JEV_SEARCH_ORDER: arm,
    PI_FFF_MODE: "tools-only",
    PI_FFF_MULTIGREP: "0",
    FFF_ENABLE_HOME_SCAN: "0",
    FFF_ENABLE_ROOT_SCAN: "0",
    FFF_WARN_HOME_SCAN: "0",
    FFF_FOLLOW_SYMLINKS: "0",
    FFF_FRECENCY_DB: join(runtimeDir, "frecency.sqlite"),
    FFF_HISTORY_DB: join(runtimeDir, "history.sqlite"),
    PI_CODING_AGENT_DIR: join(runtimeDir, "agent"),
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(changes)) { previous.set(name, process.env[name]); process.env[name] = value; }
  return () => { for (const [name, value] of previous) value === undefined ? delete process.env[name] : process.env[name] = value; };
}

async function openSession(input: { pool: FrozenPool; arm: Arm; runtimeDir: string; runtime: ModelRuntime; state: FirstCallState }) {
  await mkdir(input.runtimeDir, { recursive: true });
  const restore = setEnvironment(input.arm, input.runtimeDir);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const guard = await WorkspaceGuard.create(input.pool.sourceRoot);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: WALL_TIMEOUT_MS } },
      defaultTools: [...TOOL_NAMES], enableAnalytics: false, enableInstallTelemetry: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: guard.root, agentDir: join(input.runtimeDir, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [effortExtension(input.arm, input.state)],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const loadErrors = loader.getExtensions().errors;
    const diagnostics = [...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics, ...loader.getThemes().diagnostics];
    if (loadErrors.length || diagnostics.length || loader.getAgentsFiles().agentsFiles.length) throw new Error(`resource isolation failed: ${loadErrors.map((item) => item.error).join("; ")}`);
    const model = input.runtime.getModel(MODEL.provider, MODEL.id);
    if (!model) throw new Error(`model unavailable: ${MODEL.provider}/${MODEL.id}`);
    const created = await createAgentSession({
      cwd: guard.root, agentDir: join(input.runtimeDir, "agent"), modelRuntime: input.runtime, model,
      thinkingLevel: MODEL.thinking, tools: [...TOOL_NAMES], customTools: [createGuardedRead(guard)],
      resourceLoader: loader, sessionManager: SessionManager.inMemory(guard.root), settingsManager: settings,
    });
    session = created.session;
    const extensionErrors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (item) => extensionErrors.push(`${item.extensionPath}: ${item.error}`), abortHandler: () => undefined, shutdownHandler: () => undefined });
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    if (extensionErrors.length) throw new Error(`extension runtime failed: ${extensionErrors.join("; ")}`);
    const activeTools = [...session.extensionRunner.getActiveTools()].sort();
    const expectedTools = [...TOOL_NAMES].sort();
    if (canonical(activeTools) !== canonical(expectedTools)) throw new Error(`active tools must be exactly ${expectedTools.join(", ")}; got ${activeTools.join(", ")}`);
    return {
      session, activeTools,
      close: async () => {
        try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        finally { session?.dispose(); restore(); }
      },
    };
  } catch (error) {
    session?.dispose(); restore(); throw error;
  }
}

function parseCandidates(output: string): Array<Pick<FrozenCandidate, "path" | "line" | "text">> {
  const footer = output.lastIndexOf("\n\n[Order: search.");
  const body = footer >= 0 ? output.slice(0, footer) : output;
  if (body === "No matches in this collected pool.") return [];
  return body.split("\n\n").map((text) => {
    const match = text.match(/^(.+):(\d+)\n/);
    if (!match) throw new Error(`cannot parse candidate block: ${text.slice(0, 120)}`);
    return { path: match[1]!, line: Number(match[2]), text };
  });
}

async function isolationProbe(outputDir: string): Promise<Record<string, unknown>> {
  const workspace = join(outputDir, "guard-workspace");
  await mkdir(workspace, { recursive: false });
  await writeFile(join(workspace, "inside.txt"), "inside\n", "utf8");
  await symlink("/etc/passwd", join(workspace, "escape-file"));
  const guard = await WorkspaceGuard.create(workspace);
  const read = createGuardedRead(guard);
  const blocked: string[] = [];
  for (const [label, path] of [["outside-read", "/etc/passwd"], ["symlink-read", "escape-file"]] as const) {
    try { await read.execute(`probe-${label}`, { path }, undefined, undefined, { cwd: guard.root } as never); }
    catch { blocked.push(label); }
  }
  if (blocked.length !== 2) throw new Error(`read confinement probe failed; blocked=${blocked.join(",")}`);
  return { passed: true, blocked };
}

export type PreflightResult = {
  passed: boolean;
  sourceProof: Array<{ root: string; expected: string; actual: string }>;
  isolation: unknown;
  footerNeutralization: boolean;
  pools: Array<{ queryId: string; expectedCount: number; actualCount: number; expectedSequenceHash: string; actualSequenceHash: string; firstPageHash: string; nativeJevCalls: number; activeTools: string[]; matched: boolean }>;
};

/** Model-free actual-session replay of all ten frozen native first pools. */
export async function runPreflight(dataset: FrozenDataset, outputDir: string, suppliedRuntime?: ModelRuntime): Promise<PreflightResult> {
  await mkdir(outputDir, { recursive: true });
  await validateRubric(dataset);
  const sourceProof = await verifySources(dataset);
  const isolation = await isolationProbe(outputDir);
  const sample = "x\n\n[Order: jev. Collected pool: 2. Shown: 1. Jev unavailable: visible fallback. No candidates were removed.]";
  const blinded = neutralizeOrderFooter(sample);
  const footerNeutralization = blinded === "x\n\n[Order: search. Collected pool: 2. Shown: 1. Jev unavailable: visible fallback. No candidates were removed.]";
  const cappedProbe = contentText(blindAndCapContent([{ type: "text", text: "x".repeat(13_000) }]));
  if (!footerNeutralization || Buffer.byteLength(cappedProbe) > OUTPUT_CAP_BYTES || !cappedProbe.includes("truncated by effort harness")) throw new Error("footer/output presentation preflight failed");
  const runtime = suppliedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false });
  const pools: PreflightResult["pools"] = [];
  for (let index = 0; index < dataset.pools.length; index += 1) {
    const pool = dataset.pools[index]!;
    const runtimeDir = join(outputDir, `runtime-${String(index + 1).padStart(2, "0")}`);
    const state = createFirstCallState(pool.query);
    const opened = await openSession({ pool, arm: "native", runtimeDir, runtime, state });
    try {
      const tool = opened.session.extensionRunner.getToolDefinition("ffgrep");
      if (!tool) throw new Error("registered ffgrep definition unavailable in preflight");
      const actual: Array<Pick<FrozenCandidate, "path" | "line" | "text">> = [];
      let args: Record<string, unknown> = expectedFirstArgs(pool.query);
      let firstPageHash = "";
      let nativeJevCalls = 0;
      for (;;) {
        const result = await tool.execute(`preflight-${index}-${actual.length}`, args as never, undefined, undefined, opened.session.extensionRunner.createContext() as never);
        const output = contentText(result.content);
        if (!firstPageHash) firstPageHash = sha(output);
        actual.push(...parseCandidates(output));
        const rerank = record(record(result.details)?.rerank);
        nativeJevCalls += numeric(rerank?.calls);
        const remaining = numeric(rerank?.remainingInPool);
        if (remaining <= 0) break;
        const cursor = rerank?.cursor;
        if (typeof cursor !== "string" || !cursor) throw new Error(`missing first-pool cursor for ${pool.query.id}`);
        args = { ...expectedFirstArgs(pool.query), cursor };
        if (actual.length >= 80) throw new Error(`first pool did not drain by 80 candidates: ${pool.query.id}`);
      }
      const expected = pool.candidates.map(({ path, line, text }) => ({ path, line, text }));
      const expectedSequenceHash = sha(canonical(expected));
      const actualSequenceHash = sha(canonical(actual));
      const matched = canonical(actual) === canonical(expected);
      const proof = { queryId: pool.query.id, expectedCount: expected.length, actualCount: actual.length, expectedSequenceHash, actualSequenceHash, firstPageHash, nativeJevCalls, activeTools: opened.activeTools, matched };
      pools.push(proof);
      await json(join(outputDir, `pool-${String(index + 1).padStart(2, "0")}-${pool.query.id}.json`), proof);
      if (!matched) throw new Error(`native first-pool sequence mismatch for ${pool.query.id}`);
      if (nativeJevCalls !== 0) throw new Error(`native preflight made ${nativeJevCalls} Jev calls for ${pool.query.id}`);
    } finally {
      await opened.close();
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
  const result = { passed: pools.length === 10 && pools.every((pool) => pool.matched && pool.nativeJevCalls === 0), sourceProof, isolation, footerNeutralization, pools };
  await json(join(outputDir, "preflight.json"), result);
  return result;
}

function toolArgs(content: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (!Array.isArray(content)) return result;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const call = part as { type?: unknown; id?: unknown; arguments?: unknown };
    if (call.type === "toolCall" && typeof call.id === "string") result.set(call.id, call.arguments);
  }
  return result;
}

async function runOne(input: { pool: FrozenPool; row: PlanRow; runDir: string; runtime: ModelRuntime; campaignCostBefore: number }): Promise<RunOutcome> {
  const started = Date.now();
  const runtimeDir = join(input.runDir, "runtime");
  const state = createFirstCallState(input.pool.query);
  const transcript: unknown[] = [];
  const usage = emptyUsage();
  const toolUsage = emptyUsage();
  const toolCounts: Record<string, number> = {};
  const distinctReads = new Set<string>();
  let outputBytes = 0;
  let firstPageHash: string | undefined;
  let finalAnswer = "";
  let turns = 0;
  let stop: RunStatus | undefined;
  let error: { name: string; message: string } | undefined;
  let activeTools: string[] = [];
  let opened: Awaited<ReturnType<typeof openSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let jevCalls = 0, jevInput = 0, jevOutput = 0, jevLatency = 0, fallbackCount = 0;
  const halt = (reason: RunStatus) => { stop ??= reason; void opened?.session.abort(); };
  try {
    opened = await openSession({ pool: input.pool, arm: input.row.arm, runtimeDir, runtime: input.runtime, state });
    activeTools = opened.activeTools;
    unsubscribe = opened.session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "turn_end") return;
      turns += 1;
      const message = event.message as { role?: string; content?: unknown; usage?: Usage; stopReason?: string; errorMessage?: string };
      if (message.role === "assistant") {
        addUsage(usage, message.usage);
        const answer = contentText(message.content).trim();
        if (answer) finalAnswer = answer;
        if (message.stopReason === "error") { error ??= { name: "AssistantError", message: message.errorMessage ?? "assistant response failed" }; halt("error"); }
      }
      const args = toolArgs(message.content);
      const results = event.toolResults.map((result) => {
        toolCounts[result.toolName] = (toolCounts[result.toolName] ?? 0) + 1;
        addUsage(toolUsage, result.usage as Usage | undefined);
        const callArgs = args.get(result.toolCallId);
        const delivered = contentText(result.content);
        outputBytes += Buffer.byteLength(delivered);
        if (result.toolName === "read" && typeof record(callArgs)?.path === "string") distinctReads.add(record(callArgs)!.path as string);
        // Before success every non-matching call is blocked, so the first successful
        // ffgrep result is necessarily the mandatory frozen page (argument key order is irrelevant).
        if (!firstPageHash && result.toolName === "ffgrep" && !result.isError && state.succeeded) firstPageHash = sha(delivered);
        if (result.toolName === "ffgrep") {
          const metrics = extractRerankMetrics(result.details);
          jevCalls += metrics.calls; jevInput += metrics.inputTokens; jevOutput += metrics.outputTokens; jevLatency += metrics.latencyMs; fallbackCount += metrics.fallbackCount;
        }
        return { toolCallId: result.toolCallId, toolName: result.toolName, args: callArgs, content: result.content, details: result.details, usage: result.usage, isError: result.isError };
      });
      transcript.push({ turn: turns, assistant: message, toolResults: results });
      const current = usage.cost.total + toolUsage.cost.total;
      if (turns >= MAX_TURNS && results.length > 0) halt("turn_limit");
      else if (current >= RUN_COST_LIMIT_USD || input.campaignCostBefore + current >= CAMPAIGN_COST_LIMIT_USD) halt("cost_limit");
    });
    const remaining = WALL_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error("run setup exhausted wall timeout");
    timer = setTimeout(() => halt("timeout"), remaining); timer.unref?.();
    await opened.session.prompt(promptFor(input.pool), { expandPromptTemplates: false, source: "rpc" });
  } catch (caught) {
    if (!stop) {
      error ??= safeError(caught);
      stop = /model unavailable|resource isolation|active tools|extension runtime|failed to create FFF|picker|setup/i.test(error.message) ? "infra_error" : "error";
    }
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    if (opened) {
      try { await opened.close(); } catch (caught) { error ??= safeError(caught); stop ??= "infra_error"; }
    }
  }
  if (!state.succeeded && !stop) {
    stop = "error";
    error ??= { name: "MandatorySearchError", message: "mandatory frozen first search did not succeed" };
  }
  if (input.row.arm !== "jev" && jevCalls > 0) {
    stop = "infra_error";
    error ??= { name: "ArmIsolationError", message: `${input.row.arm} unexpectedly made ${jevCalls} Jev ranking calls` };
  }
  const totalUsage = combine(usage, toolUsage);
  const status = stop ?? "ok";
  const outcome: RunOutcome = {
    row: input.row, opaqueId: `answer-${randomUUID()}`, status, ...(stop ? { terminationReason: stop } : {}), elapsedMs: Date.now() - started, turns,
    toolCounts, totalToolAttempts: state.totalAttempts, followupToolCalls: state.followupAttempts,
    searchAttempts: (state.attemptedByTool.ffgrep ?? 0) + (state.attemptedByTool.fffind ?? 0), readAttempts: state.attemptedByTool.read ?? 0,
    distinctReadFiles: [...distinctReads].sort(), outputBytes, usage, toolUsage, totalUsage,
    jev: { calls: jevCalls, inputTokens: jevInput, outputTokens: jevOutput, costUsd: input.row.arm === "jev" ? toolUsage.cost.total : 0, latencyMs: jevLatency, fallbackCount },
    ...(firstPageHash ? { firstPageHash } : {}), firstSearchSucceeded: state.succeeded, blockedInitialCalls: state.blocked, finalAnswer, activeTools, ...(error ? { error } : {}),
  };
  await json(join(input.runDir, "transcript.json"), { row: input.row, opaqueId: outcome.opaqueId, prompt: promptFor(input.pool), turns: transcript });
  await json(join(input.runDir, "outcome.json"), outcome);
  await rm(runtimeDir, { recursive: true, force: true });
  return outcome;
}

async function inputHashes(dataset: FrozenDataset, plan: PlanRow[]): Promise<Record<string, unknown>> {
  const sdkPackage = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
  return {
    effortProtocolSha256: await sha256File(PROTOCOL_PATH), rubricSha256: await sha256File(RUBRIC_PATH), frozenDatasetSha256: await sha256File(DATASET_PATH),
    sourceTrees: await verifySources(dataset), rankingCoreSha256: await hashTree(join(ROOT, "src")), currentVendorSha256: await hashTree(join(ROOT, "vendor/pi-fff")),
    harnessSha256: await hashTree(EFFORT_DIR), promptSha256: sha(SYSTEM_PROMPT), configSha256: sha(canonical(HARNESS_CONFIG)), planSha256: sha(canonical(plan)),
    sdk: { package: "@earendil-works/pi-coding-agent", packageJsonSha256: await sha256File(sdkPackage) },
  };
}

export async function planOnly(dataset: FrozenDataset): Promise<Record<string, unknown>> {
  await validateRubric(dataset);
  const plan = buildPlan(dataset.pools); validatePlan(plan);
  return { mode: "plan", live: false, runs: plan.length, blocks: 20, model: MODEL, bounds: HARNESS_CONFIG, plan, hashes: await inputHashes(dataset, plan) };
}

function sumCost(outcomes: RunOutcome[]): number { return outcomes.reduce((sum, outcome) => sum + outcome.totalUsage.cost.total, 0); }
function isFailFast(outcome: RunOutcome): boolean { return outcome.status === "infra_error" || (outcome.status === "error" && /auth|credential|unauthor|forbidden|rate limit|network|provider/i.test(outcome.error?.message ?? "")); }

async function saveSummary(resultDir: string, plan: PlanRow[], outcomes: RunOutcome[], campaignStatus: "running" | "complete" | "budget_stop" | "failed", error?: unknown): Promise<void> {
  await json(join(resultDir, "summary.json"), {
    campaignStatus, planned: plan.length, completed: outcomes.length, completeTriples: Math.floor(outcomes.length / 3), incompleteTripleRuns: outcomes.length % 3,
    campaignEstimatedCostUsd: sumCost(outcomes), budgetStop: campaignStatus === "budget_stop", outcomes,
    ...(error ? { error: safeError(error) } : {}),
  });
}

export async function runLive(dataset: FrozenDataset): Promise<{ resultDir: string; outcomes: RunOutcome[]; campaignStatus: string }> {
  await validateRubric(dataset);
  const plan = buildPlan(dataset.pools); validatePlan(plan);
  const resultDir = join(RESULTS_DIR, timestampId());
  await mkdir(RESULTS_DIR, { recursive: true }); await mkdir(resultDir, { recursive: false });
  const hashes = await inputHashes(dataset, plan);
  await json(join(resultDir, "frozen-inputs.json"), { mode: "live", frozenAt: new Date().toISOString(), model: MODEL, config: HARNESS_CONFIG, systemPrompt: SYSTEM_PROMPT, plan, hashes });
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  if (!runtime.getModel(MODEL.provider, MODEL.id)) throw new Error(`configured model not found: ${MODEL.provider}/${MODEL.id}`);
  if (!runtime.hasConfiguredAuth(MODEL.provider)) throw new Error(`authentication unavailable for ${MODEL.provider}; no paid runs started`);
  const preflight = await runPreflight(dataset, join(resultDir, "preflight"), runtime);
  if (!preflight.passed) throw new Error("model-free preflight failed; no paid runs started");
  const outcomes: RunOutcome[] = [];
  let campaignStatus: "running" | "complete" | "budget_stop" | "failed" = "running";
  let campaignError: unknown;
  try {
    for (let offset = 0; offset < plan.length; offset += 3) {
      const spent = sumCost(outcomes);
      if (!shouldStartTriple(spent)) { campaignStatus = "budget_stop"; break; }
      const triple = plan.slice(offset, offset + 3);
      for (const row of triple) {
        const pool = dataset.pools.find((candidate) => candidate.query.id === row.queryId);
        if (!pool) throw new Error(`plan references missing query: ${row.queryId}`);
        const runDir = join(resultDir, `run-${String(row.index).padStart(2, "0")}-${row.queryId}-r${row.repeat}-${row.position}`);
        await mkdir(runDir, { recursive: false });
        console.error(`[effort] ${row.index}/${plan.length} ${row.queryId} repeat=${row.repeat} arm=${row.arm} spent=$${sumCost(outcomes).toFixed(4)}`);
        const outcome = await runOne({ pool, row, runDir, runtime, campaignCostBefore: sumCost(outcomes) });
        outcomes.push(outcome);
        await saveSummary(resultDir, plan, outcomes, "running");
        if (isFailFast(outcome)) throw new Error(`campaign fail-fast at run ${row.index}: ${outcome.error?.message ?? outcome.status}`);
      }
    }
    if (campaignStatus === "running") campaignStatus = outcomes.length === plan.length ? "complete" : "budget_stop";
  } catch (error) {
    campaignStatus = "failed"; campaignError = error;
  } finally {
    try { await json(join(resultDir, "source-hashes-after.json"), { checkedAt: new Date().toISOString(), sourceTrees: await verifySources(dataset) }); }
    catch (error) { campaignStatus = "failed"; campaignError ??= error; }
    await saveSummary(resultDir, plan, outcomes, campaignStatus, campaignError);
  }
  if (campaignError) throw campaignError;
  return { resultDir, outcomes, campaignStatus };
}
