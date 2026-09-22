import { test } from "node:test";
import assert from "node:assert/strict";
import type { GrepCursor, GrepMatch, GrepResult } from "@ff-labs/fff-node";
import { batches, JEV_MODEL, makeRequest, rankCandidates, type Candidate } from "../src/rank.ts";
import { candidateFromMatch, GrepPilot, OUTPUT_BYTES } from "../src/grep-pilot.ts";

const candidates: Candidate[] = [0, 1, 2].map((i) => ({ id: `c${i}`, path: "a.ts", line: i + 1, text: `code ${i}`, definition: false }));
function response(scores: number[]) {
  return Response.json({ model: JEV_MODEL, answers: Object.fromEntries(scores.map((noul, i) => [`c${i}`, { type: "noul", noul }])), usage: { input_tokens: 100, output_tokens: 3 } });
}
function match(i: number): GrepMatch {
  return { relativePath: `file-${i}.ts`, fileName: `file-${i}.ts`, gitStatus: "", size: 10, modified: 0, isBinary: false,
    totalFrecencyScore: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0,
    lineNumber: i + 1, col: 0, byteOffset: 0, lineContent: `  code ${i}`, matchRanges: [[0, 4]] };
}
function result(items: GrepMatch[], nextCursor: GrepCursor | null = null): GrepResult {
  return { items, totalMatched: items.length, totalFilesSearched: 1, totalFiles: 100, filteredFileCount: 100, nextCursor };
}
const input = { signature: "query", intent: "find implementation", order: "native" as const };

test("Jev stable descending scores keeps low-scored matches and accounts usage", async () => {
  const ranked = await rankCandidates("intent", candidates, { order: "jev", apiKey: "test", fetch: async () => response([0, .9, .9]) });
  assert.deepEqual(ranked.candidates.map((c) => c.id), ["c1", "c2", "c0"]);
  assert.equal(ranked.metrics.calls, 1);
  assert.equal(ranked.metrics.inputTokens, 100);
});

test("native/deterministic never call network; deterministic favors definitions and file diversity", async () => {
  const items = [...candidates, { ...candidates[0]!, id: "c3", path: "b.ts", definition: true }];
  const network = async () => { throw new Error("must not call"); };
  const native = await rankCandidates("intent", items, { order: "native", fetch: network });
  assert.deepEqual(native.candidates, items);
  const ranked = await rankCandidates("intent", items, { order: "deterministic", fetch: network });
  assert.equal(ranked.candidates[0]!.id, "c3");
  assert.equal(ranked.metrics.calls, 0);
});

test("invalid scores fall back to original order, preserve billed usage, never expose arbitrary errors", async () => {
  const bad = await rankCandidates("intent", candidates, { order: "jev", apiKey: "test", fetch: async () => response([0, 2, 1]) });
  assert.deepEqual(bad.candidates, candidates);
  assert.equal(bad.metrics.inputTokens, 100);
  assert.match(bad.metrics.fallback!, /invalid candidate score/);
  const secret = await rankCandidates("intent", candidates, { order: "jev", apiKey: "test", fetch: async () => { throw new Error("secret-api-key"); } });
  assert.equal(secret.metrics.fallback, "Jev request failed or timed out");
});

test("abort propagates rather than disguising cancellation as fallback", async () => {
  const controller = new AbortController();
  await assert.rejects(rankCandidates("intent", candidates, { order: "jev", apiKey: "test", signal: controller.signal, fetch: async () => {
    controller.abort(); controller.signal.throwIfAborted(); return response([1, 0, 0]);
  } }), { name: "AbortError" });
});

test("packing bounds full request bytes, candidate counts, and preserves every ID", () => {
  const items = Array.from({ length: 80 }, (_, i) => ({ ...candidates[0]!, id: `c${i}`, text: "字".repeat(1100) }));
  const groups = batches("intent", items, 8);
  assert.equal(groups.flat().length, 80);
  for (const group of groups) {
    assert.ok(group.length <= 8);
    assert.ok(Buffer.byteLength(JSON.stringify(makeRequest("intent", group))) <= 24_000);
  }
  assert.throws(() => batches("intent", items, 0));
});

test("snippets preserve indentation and line identity, and explicitly truncate oversized Unicode", () => {
  const c = candidateFromMatch({ ...match(2), contextBefore: ["  before"], contextAfter: ["\tafter"] }, 0);
  assert.match(c.text, /2:   before\n3:   code 2\n4: \tafter/);
  const long = candidateFromMatch({ ...match(0), lineContent: "字".repeat(5000) }, 0);
  assert.ok(Buffer.byteLength(long.text) <= 3500);
  assert.ok(long.text.endsWith("[snippet truncated]"));
  assert.ok(!long.text.includes("�"));
});

test("pagination drains ranked leftovers before native scan and preserves soft-cap overflow", async () => {
  let scans = 0, ranks = 0;
  const cursor = { _offset: 1 } as GrepCursor;
  const pilot = new GrepPilot(async (_intent, items, { order }) => {
    ranks++;
    return { candidates: [...items].reverse(), metrics: { order, calls: 1, inputTokens: 100, outputTokens: 0, latencyMs: 1 } };
  });
  const scan = async () => ({ result: ++scans === 1 ? result(Array.from({ length: 200 }, (_, i) => match(i)), cursor) : result([match(200)]) });
  let page = await pilot.search({ ...input, scan, limit: 20 });
  assert.equal(scans, 1);
  assert.equal(page.details.rerank.poolSize, 80);
  assert.equal(page.details.rerank.orderChanged, true);
  assert.match(page.content[0]!.text, /^file-79.ts/);
  const all = [...page.content[0]!.text.matchAll(/^file-(\d+)\.ts:/gm)].map((m) => Number(m[1]));
  for (let i = 0; page.details.rerank.cursor; i++) {
    assert.ok(i < 20);
    page = await pilot.search({ ...input, intent: undefined, cursor: page.details.rerank.cursor, scan, limit: 20 });
    if (i < 3) { assert.equal(scans, 1); assert.equal(ranks, 1); assert.equal(page.usage.totalTokens, 0); assert.equal(page.details.rerank.orderChanged, true); }
    assert.ok(Buffer.byteLength(page.content[0]!.text) <= OUTPUT_BYTES);
    all.push(...[...page.content[0]!.text.matchAll(/^file-(\d+)\.ts:/gm)].map((m) => Number(m[1])));
  }
  assert.equal(scans, 2);
  assert.equal(ranks, 3);
  assert.equal(all.length, 201);
  assert.equal(new Set(all).size, 201);
});

test("output-byte truncation keeps all unshown matches reachable", async () => {
  const pilot = new GrepPilot();
  const scan = async () => ({ result: result(Array.from({ length: 10 }, (_, i) => ({ ...match(i), lineContent: "x".repeat(4000) }))) });
  let page = await pilot.search({ ...input, scan, limit: 80 });
  let shown = page.details.rerank.shown;
  assert.equal(page.details.rerank.orderChanged, false);
  assert.ok(shown < 10);
  while (page.details.rerank.cursor) {
    assert.ok(Buffer.byteLength(page.content[0]!.text) <= OUTPUT_BYTES);
    page = await pilot.search({ ...input, scan, cursor: page.details.rerank.cursor });
    shown += page.details.rerank.shown;
  }
  assert.equal(shown, 10);
});

test("cursor errors never silently restart; intent is required only on fresh calls", async () => {
  const pilot = new GrepPilot();
  const scan = async () => ({ result: result([match(0), match(1)]) });
  await assert.rejects(pilot.search({ ...input, scan, intent: undefined }), /requires intent/);
  await assert.rejects(pilot.search({ ...input, scan, cursor: "missing" }), /unknown/);
  const page = await pilot.search({ ...input, scan, limit: 1 });
  const cursor = page.details.rerank.cursor!;
  await assert.rejects(pilot.search({ ...input, scan, signature: "different", cursor }), /different search arguments/);
  await pilot.search({ ...input, scan, cursor, intent: undefined });
  await assert.rejects(pilot.search({ ...input, scan, cursor }), /already consumed/);
});

test("bounded scans preserve a continuation even when no candidates were found", async () => {
  const pilot = new GrepPilot();
  let scans = 0;
  const scan = async () => ({ result: result([], { _offset: ++scans } as GrepCursor) });
  const page = await pilot.search({ ...input, scan });
  assert.equal(scans, 3);
  assert.equal(page.details.rerank.hasUnranked, true);
  assert.ok(page.details.rerank.cursor);
  assert.match(page.content[0]!.text, /unsearched files remain/);
});
