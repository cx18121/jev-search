import assert from "node:assert/strict";
import test from "node:test";
import { GrepPilot } from "../src/grep-pilot.ts";
import type { Candidate } from "../src/rank.ts";
import { decision, firstPage, measure, validateLabels, type Label, type MeasuredRow, type Pool } from "../eval/retrieval/metrics.ts";

const candidates = Array.from({ length: 25 }, (_, i): Candidate => ({ id: `c${i}`, path: "x.py", line: i + 1, text: `x.py:${i + 1}\n${"é".repeat(600)}`, definition: false }));
const labels: Label[] = candidates.map((candidate, i) => ({ candidateId: candidate.id, label: i === 7 ? "useful" : i === 2 ? "uncertain" : "not_useful", reason: "fixture" }));

test("metrics distinguish coverage, rank, prefixes and uncertain labels", () => {
  const result = measure(candidates, candidates, labels);
  assert.equal(result.firstUsefulRank, 8);
  assert.equal(result.reciprocalRank, 1 / 8);
  assert.equal(result.hit5, false);
  assert.equal(result.hit10, true);
  assert.equal(measure(candidates, candidates, labels, true).firstUsefulRank, 3);
  const zero = measure(candidates, candidates, labels.map((label) => ({ ...label, label: "not_useful" })));
  assert.equal(zero.firstUsefulRank, null);
  assert.equal(zero.reciprocalRank, 0);
  assert.equal(zero.firstPageHit, false);
  assert.throws(() => measure(candidates.slice(1), candidates, labels), /permutation/);
});

test("first-page selection matches the actual production pilot byte boundary", async () => {
  const pilot = new GrepPilot(async () => ({ candidates: [...candidates], metrics: { order: "native", calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 } }));
  const page = await pilot.search({ signature: "test", intent: "test", order: "native", scan: async () => ({ result: { items: [], totalMatched: 0, totalFilesSearched: 0, totalFiles: 0, filteredFileCount: 0, nextCursor: null } }) });
  const selected = firstPage(candidates);
  assert.equal(page.details.rerank.shown, selected.length);
  assert.ok(page.content[0].text.startsWith(selected.map((candidate) => candidate.text).join("\n\n")));
  assert.equal(firstPage(candidates.map((candidate) => ({ ...candidate, text: "short" }))).length, 20);
});

test("labels must account for every candidate exactly once", () => {
  const pool = { query: { id: "query" }, candidates } as Pool;
  validateLabels([pool], { datasetSha256: "test", byQuery: { query: labels } });
  assert.throws(() => validateLabels([pool], { datasetSha256: "test", byQuery: { query: labels.slice(1) } }), /exactly once/);
  assert.throws(() => validateLabels([pool], { datasetSha256: "test", byQuery: { query: [...labels.slice(1), labels[1]] } }), /exactly once/);
});

test("advancement requires adequate coverage, challenge and both repetitions beating both alternatives", () => {
  const rows: MeasuredRow[] = [];
  for (let i = 0; i < 8; i++) {
    for (const order of ["native", "deterministic", "jev-1", "jev-2"]) {
      const moved = order.startsWith("jev") ? [candidates[7], ...candidates.filter((candidate) => candidate.id !== "c7")] : candidates;
      const certain = measure(moved, candidates, labels);
      rows.push({ queryId: `q${i}`, kind: "exploratory", order, certain, inclusive: certain });
    }
  }
  assert.equal(decision(rows, "certain").qualifies, true);
  const tiedRepeat = rows.map((row) => row.order === "jev-2" ? { ...row, certain: measure(candidates, candidates, labels) } : row);
  assert.equal(decision(tiedRepeat, "certain").qualifies, false);
  assert.equal(decision(rows.filter((row) => Number(row.queryId.slice(1)) < 3), "certain").sufficientDataset, false);
});
