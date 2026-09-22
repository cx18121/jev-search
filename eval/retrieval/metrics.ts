import { OUTPUT_BYTES } from "../../src/grep-pilot.ts";
import type { Candidate } from "../../src/rank.ts";

export type Label = { candidateId: string; label: "useful" | "not_useful" | "uncertain"; reason: string };
export type Query = {
  id: string; fixtureTaskId: string; kind: "exploratory" | "control";
  intent: string; pattern: string; path?: string; mode: "plain" | "regex";
  referenceAnswer: string; evidence: Array<{ path: string; start: number; end: number; reason: string }>;
};
export type Pool = { query: Query; candidates: Candidate[]; sourceRoot: string; sourceSha256: string; collection: unknown };
export type Labels = { datasetSha256: string; byQuery: Record<string, Label[]> };

export function validateLabels(pools: Pool[], labels: Labels): void {
  const queryIds = pools.map((pool) => pool.query.id).sort();
  if (JSON.stringify(Object.keys(labels.byQuery).sort()) !== JSON.stringify(queryIds)) throw new Error("labels must cover exactly the frozen queries");
  for (const pool of pools) {
    const rows = labels.byQuery[pool.query.id];
    const ids = pool.candidates.map((candidate) => candidate.id).sort();
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate candidate ID in ${pool.query.id}`);
    if (JSON.stringify(rows.map((row) => row.candidateId).sort()) !== JSON.stringify(ids)) throw new Error(`labels must cover each candidate exactly once: ${pool.query.id}`);
    if (rows.some((row) => !["useful", "not_useful", "uncertain"].includes(row.label) || !row.reason?.trim())) throw new Error(`invalid label in ${pool.query.id}`);
  }
}

export function firstPage(candidates: Candidate[]): Candidate[] {
  const page: Candidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const size = Buffer.byteLength(candidate.text) + 2;
    if (page.length >= 20 || bytes + size > OUTPUT_BYTES - 1_200) break;
    page.push(candidate);
    bytes += size;
  }
  return page;
}

export function measure(order: Candidate[], original: Candidate[], labels: Label[], includeUncertain = false) {
  if (JSON.stringify(order.map((row) => row.id).sort()) !== JSON.stringify(original.map((row) => row.id).sort())) throw new Error("ranking must be a permutation of the original pool");
  const useful = new Set(labels.filter((row) => row.label === "useful" || (includeUncertain && row.label === "uncertain")).map((row) => row.candidateId));
  const first = order.findIndex((candidate) => useful.has(candidate.id));
  const count = (rows: Candidate[]) => rows.filter((candidate) => useful.has(candidate.id)).length;
  const page = firstPage(order);
  return {
    poolSize: order.length, usefulInPool: useful.size,
    firstUsefulRank: first < 0 ? null : first + 1, reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    hit5: count(order.slice(0, 5)) > 0, hit10: count(order.slice(0, 10)) > 0,
    useful5: count(order.slice(0, 5)), useful10: count(order.slice(0, 10)),
    firstPageHit: count(page) > 0, firstPageUseful: count(page), firstPageSize: page.length,
  };
}
export type Measurement = ReturnType<typeof measure>;
export type MeasuredRow = { queryId: string; kind: Query["kind"]; order: string; certain: Measurement; inclusive: Measurement };

export function decision(rows: MeasuredRow[], sensitivity: "certain" | "inclusive") {
  const baseline = rows.filter((row) => row.order === "native");
  const covered = baseline.filter((row) => row.kind === "exploratory" && row[sensitivity].usefulInPool > 0);
  const challenging = covered.filter((row) => row[sensitivity].firstUsefulRank! > 5);
  const find = (id: string, arm: string) => {
    const row = rows.find((row) => row.queryId === id && row.order === arm);
    if (!row) throw new Error(`missing ${arm} result for ${id}`);
    return row[sensitivity];
  };
  const comparisons = ["jev-1", "jev-2"].flatMap((jev) => ["native", "deterministic"].map((other) => {
    const deltas = covered.map((row) => ({ jev: find(row.queryId, jev), other: find(row.queryId, other) }));
    const meanReciprocalRankGain = deltas.length ? deltas.reduce((sum, pair) => sum + pair.jev.reciprocalRank - pair.other.reciprocalRank, 0) / deltas.length : 0;
    const additionalTopFiveHits = deltas.reduce((sum, pair) => sum + Number(pair.jev.hit5) - Number(pair.other.hit5), 0);
    const exploratoryPageLosses = baseline.filter((row) => row.kind === "exploratory" && find(row.queryId, other).firstPageHit && !find(row.queryId, jev).firstPageHit).length;
    const controlPageLosses = baseline.filter((row) => row.kind === "control" && find(row.queryId, other).firstPageHit && !find(row.queryId, jev).firstPageHit).length;
    return { jev, other, meanReciprocalRankGain, additionalTopFiveHits, exploratoryPageLosses, controlPageLosses,
      passes: meanReciprocalRankGain >= 0.10 && additionalTopFiveHits >= 2 && exploratoryPageLosses <= 1 && controlPageLosses === 0 };
  }));
  return { sensitivity, coveredExploratory: covered.length, challengingExploratory: challenging.length,
    sufficientDataset: covered.length >= 6 && challenging.length >= 4, comparisons,
    qualifies: covered.length >= 6 && challenging.length >= 4 && comparisons.every((comparison) => comparison.passes) };
}
