import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceGuard } from "../eval/coding/path-guard.ts";
import { buildPlan, PERMUTATIONS, validatePlan } from "../eval/effort/plan.ts";
import { extractRerankMetrics, shouldStartTriple } from "../eval/effort/runner.ts";
import {
  blindAndCapContent,
  checkInitialCall,
  contentText,
  createFirstCallState,
  createGuardedRead,
  neutralizeOrderFooter,
  normalizeToolArgs,
  OUTPUT_CAP_BYTES,
} from "../eval/effort/tools.ts";
import type { FrozenPool, FrozenQuery } from "../eval/effort/types.ts";

const query: FrozenQuery = {
  id: "q", fixtureTaskId: "fixture", kind: "exploratory", intent: "byte-identical intent", pattern: "needle", path: "src", mode: "plain",
  referenceAnswer: "hidden", evidence: [{ path: "src/a.ts", start: 1, end: 1, reason: "hidden" }],
};

test("effort plan is 20 contiguous triples with six-permutation rotation", () => {
  const pools = Array.from({ length: 10 }, (_, index) => ({ query: { ...query, id: `q${index}` } })) as FrozenPool[];
  const plan = buildPlan(pools);
  validatePlan(plan);
  assert.equal(plan.length, 60);
  for (let block = 0; block < 20; block += 1) {
    assert.deepEqual(plan.slice(block * 3, block * 3 + 3).map((row) => row.arm), PERMUTATIONS[block % 6]);
  }
});

test("effective first-call enforcement normalizes defaults and rejects every deviation", () => {
  const state = createFirstCallState(query);
  assert.match(checkInitialCall(state, "read", { path: "src/a.ts" })!, /mandatory frozen ffgrep/);
  assert.match(checkInitialCall(state, "ffgrep", { pattern: "needle", path: "src", intent: query.intent, limit: 20, context: 3, caseSensitive: false })!, /exactly/);
  assert.equal(checkInitialCall(state, "ffgrep", { pattern: "needle", path: "src", intent: query.intent }, false), undefined);
  assert.deepEqual(normalizeToolArgs("ffgrep", { pattern: "needle" }), { pattern: "needle", limit: 20, context: 3 });
  assert.equal(state.totalAttempts, 2);
  assert.equal(state.blocked.length, 2);
});

test("footer blinding changes only the final order label and keeps fallback facts", () => {
  const input = "quoted [Order: jev. untouched]\n\nsnippet\n\n[Order: native fallback. Collected pool: 4. Jev unavailable: auth. No candidates were removed.]";
  const output = neutralizeOrderFooter(input);
  assert.equal(output, "quoted [Order: jev. untouched]\n\nsnippet\n\n[Order: search. Collected pool: 4. Jev unavailable: auth. No candidates were removed.]");
});

test("tool content has one aggregate UTF-8 byte cap", () => {
  const output = blindAndCapContent([{ type: "text", text: "🙂".repeat(2_000) }, { type: "text", text: "z".repeat(8_000) }]);
  assert.ok(Buffer.byteLength(contentText(output)) <= OUTPUT_CAP_BYTES);
  assert.match(contentText(output), /truncated by effort harness/);
  assert.ok(!contentText(output).includes("�"));
});

test("rerank metrics preserve host-only usage and fallback counts", () => {
  assert.deepEqual(extractRerankMetrics({ rerank: { calls: 2, inputTokens: 30, outputTokens: 4, latencyMs: 99, fallback: "visible" } }), {
    calls: 2, inputTokens: 30, outputTokens: 4, latencyMs: 99, fallbackCount: 1,
  });
  assert.deepEqual(extractRerankMetrics(undefined), { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, fallbackCount: 0 });
});

test("campaign reserves three dollars before starting another paired triple", () => {
  assert.equal(shouldStartTriple(9), true);
  assert.equal(shouldStartTriple(9.000_001), false);
  assert.equal(shouldStartTriple(12), false);
});

test("custom read uses WorkspaceGuard for outside and symlink denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-effort-guard-"));
  try {
    await writeFile(join(root, "inside.txt"), "ok\n");
    await symlink("/etc/passwd", join(root, "escape"));
    const guard = await WorkspaceGuard.create(root);
    const read = createGuardedRead(guard);
    const inside = await read.execute("inside", { path: "inside.txt" }, undefined, undefined, { cwd: guard.root } as never);
    assert.match(contentText(inside.content), /ok/);
    await assert.rejects(() => read.execute("outside", { path: "/etc/passwd" }, undefined, undefined, { cwd: guard.root } as never));
    await assert.rejects(() => read.execute("symlink", { path: "escape" }, undefined, undefined, { cwd: guard.root } as never), /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
