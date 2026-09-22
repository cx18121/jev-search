export const ARMS = ["native", "deterministic", "jev"] as const;
export type Arm = (typeof ARMS)[number];

export type FrozenQuery = {
  id: string;
  fixtureTaskId: string;
  kind: "exploratory" | "control";
  intent: string;
  pattern: string;
  path?: string;
  mode: string;
  referenceAnswer: string;
  evidence: Array<{ path: string; start: number; end: number; reason: string }>;
};

export type FrozenCandidate = {
  id: string;
  path: string;
  line: number;
  text: string;
  definition: boolean;
};

export type FrozenPool = {
  query: FrozenQuery;
  candidates: FrozenCandidate[];
  sourceRoot: string;
  sourceSha256: string;
  collection: unknown;
};

export type FrozenDataset = {
  queriesSha256: string;
  protocolSha256: string;
  pools: FrozenPool[];
};

export type PlanRow = {
  index: number;
  block: number;
  queryId: string;
  repeat: 1 | 2;
  position: 1 | 2 | 3;
  arm: Arm;
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type UsageTotals = Usage & { reports: number };

export type RunStatus = "ok" | "timeout" | "turn_limit" | "cost_limit" | "error" | "infra_error";

export type RunOutcome = {
  row: PlanRow;
  opaqueId: string;
  status: RunStatus;
  terminationReason?: RunStatus;
  elapsedMs: number;
  turns: number;
  toolCounts: Record<string, number>;
  totalToolAttempts: number;
  followupToolCalls: number;
  searchAttempts: number;
  readAttempts: number;
  distinctReadFiles: string[];
  outputBytes: number;
  usage: UsageTotals;
  toolUsage: UsageTotals;
  totalUsage: UsageTotals;
  jev: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; fallbackCount: number };
  firstPageHash?: string;
  firstSearchSucceeded: boolean;
  blockedInitialCalls: Array<{ toolName: string; args: unknown; effectiveArgs?: unknown; reason: string }>;
  finalAnswer: string;
  activeTools: string[];
  error?: { name: string; message: string };
};
