export const ARMS = ["stock", "deterministic", "jev"] as const;
export type Arm = (typeof ARMS)[number];

export type CommandSpec = {
  /** argv executed directly inside the task image; never a host executable. */
  argv: string[];
  timeoutMs?: number;
};

export type CodingTask = {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  baseCommit: string;
  /** Verifier-only path relative to the project root. */
  baseArchive: string;
  baseSha256: string;
  workspacePrefix: string;
  image: { ref: string; id: string; platform: string; python: string };
  goldPatch: string;
  goldPatchSha256: string;
  withheldTestPatch: string;
  withheldTestPatchSha256: string;
  protectedTestPaths?: string[];
  test: {
    /** Shell command from fixture metadata, executed by bash inside the image. */
    command: string;
    kind: "pytest" | "sympy";
    timeoutMs?: number;
    failToPass: string[];
    passToPass: string[];
  };
};

export type CodingManifest = {
  schemaVersion: 1;
  campaignId: string;
  fixtureVersion: string;
  provenance: unknown;
  tasks: CodingTask[];
};

export type PlanRow = { index: number; taskId: string; repeat: 1 | 2; position: 1 | 2 | 3; arm: Arm };

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

export type TestCaseResult = { id: string; status: "passed" | "failed" | "error" | "skipped"; message?: string };
export type GradeResult = {
  passed: boolean;
  exitCode: number | null;
  expected: Array<{ id: string; group: "FAIL_TO_PASS" | "PASS_TO_PASS"; status: TestCaseResult["status"] | "missing" }>;
  unexpectedFailures: string[];
  reasons: string[];
  junitPath: string;
  rawOutputPath: string;
};
export type RunStatus = "solved" | "unsolved" | "turn_limit" | "timeout" | "cost_limit" | "error" | "infra_error";
