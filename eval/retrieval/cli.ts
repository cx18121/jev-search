import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { FileFinder } from "@ff-labs/fff-node";
import { GrepPilot } from "../../src/grep-pilot.ts";
import { rankCandidates, INPUT_USD_PER_MILLION, type Candidate } from "../../src/rank.ts";
import { buildQuery } from "../../vendor/pi-fff/src/query.ts";
import { loadManifest, fixturePath, hashTree, sha256Buffer, sha256File } from "../coding/manifest.ts";
import { decision, measure, validateLabels, type Labels, type MeasuredRow, type Pool, type Query } from "./metrics.ts";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const DIRECTORY = join(ROOT, "eval/retrieval");
const QUERIES = join(DIRECTORY, "queries.json");
const DATASET = join(DIRECTORY, "frozen.json");
const LABELS = join(DIRECTORY, "labels.json");
const PROTOCOL = join(DIRECTORY, "README.md");
const WORK = join(ROOT, "results/retrieval/pools-v2");

type Dataset = { queriesSha256: string; protocolSha256: string; pools: Pool[] };
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function collect() {
  const { queries } = JSON.parse(await readFile(QUERIES, "utf8")) as { queries: Query[] };
  assert.equal(queries.length, 10);
  assert.equal(new Set(queries.map((query) => query.id)).size, 10);
  assert.equal(queries.filter((query) => query.kind === "exploratory").length, 8);
  assert.equal(queries.filter((query) => query.kind === "control").length, 2);
  const loaded = await loadManifest(join(ROOT, "eval/coding/tasks/manifest.json"));
  await mkdir(dirname(WORK), { recursive: true });
  await mkdir(WORK, { recursive: false });
  const pools: Pool[] = [];
  const sources = new Map<string, { root: string; hash: string }>();
  for (const query of queries) {
    const fixture = loaded.manifest.tasks.find((task) => task.id === query.fixtureTaskId);
    assert.ok(fixture, `missing fixture ${query.fixtureTaskId}`);
    let source = sources.get(fixture.id);
    if (!source) {
      const archive = fixturePath(loaded, fixture.baseArchive);
      assert.equal(await sha256File(archive), fixture.baseSha256);
      const root = join(WORK, fixture.id);
      await mkdir(root);
      execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", root]);
      source = { root, hash: await hashTree(root) };
      sources.set(fixture.id, source);
    }
    const picker = FileFinder.create({ basePath: source.root, disableWatch: true, followSymlinks: false, enableHomeDirScanning: false, enableFsRootScanning: false });
    assert.ok(picker.ok, picker.ok ? "" : picker.error);
    const finder = picker.value;
    try {
      const ready = await finder.waitForScan(30_000);
      assert.ok(ready.ok && ready.value, "index must finish before collection");
      let captured: Candidate[] = [];
      const pilot = new GrepPilot(async (_intent, candidates) => {
        captured = candidates.map((candidate) => ({ ...candidate, id: `c_${sha256Buffer(JSON.stringify([candidate.path, candidate.line, candidate.text])).slice(0, 16)}` }));
        return { candidates: [...captured], metrics: { order: "native", calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 } };
      });
      const output = await pilot.search({ signature: query.id, intent: query.intent, order: "native", limit: 20, scan: async (cursor) => {
        const page = finder.grep(buildQuery(query.path, query.pattern, undefined, source.root), {
          mode: query.mode, smartCase: true, maxMatchesPerFile: 200, pageSize: 50, cursor,
          beforeContext: 3, afterContext: 3, classifyDefinitions: true, timeBudgetMs: 10_000,
        });
        assert.ok(page.ok, page.ok ? "" : page.error);
        assert.ok(!page.value.regexFallbackError, "invalid frozen query must not silently change retrieval");
        return { result: page.value };
      }});
      assert.equal(new Set(captured.map((candidate) => candidate.id)).size, captured.length);
      pools.push({ query, candidates: captured, sourceRoot: source.root, sourceSha256: source.hash, collection: output.details });
      console.log(`[collect] ${query.id}: ${captured.length} candidates`);
    } finally { finder.destroy(); }
  }
  const dataset: Dataset = { queriesSha256: await sha256File(QUERIES), protocolSha256: await sha256File(PROTOCOL), pools };
  await save(DATASET, dataset);
  const datasetSha256 = await sha256File(DATASET);
  await save(join(WORK, "label-packets.json"), { datasetSha256, queries: pools.map((pool) => ({
    id: pool.query.id, intent: pool.query.intent, referenceAnswer: pool.query.referenceAnswer,
    evidence: pool.query.evidence, sourceRoot: pool.sourceRoot,
    candidates: [...pool.candidates].sort((a, b) => a.id.localeCompare(b.id)).map(({ definition, ...candidate }) => candidate),
  })) });
  console.log(`Frozen dataset ${datasetSha256}; no ranking API calls made.`);
}

async function score(live: boolean) {
  const dataset = JSON.parse(await readFile(DATASET, "utf8")) as Dataset;
  const datasetSha256 = await sha256File(DATASET);
  const labels = JSON.parse(await readFile(LABELS, "utf8")) as Labels;
  assert.equal(labels.datasetSha256, datasetSha256, "labels must match the exact frozen dataset");
  assert.equal(dataset.queriesSha256, await sha256File(QUERIES));
  assert.equal(dataset.protocolSha256, await sha256File(PROTOCOL));
  validateLabels(dataset.pools, labels);
  const sources = new Map(dataset.pools.map((pool) => [pool.sourceRoot, pool.sourceSha256]));
  for (const [root, hash] of sources) assert.equal(await hashTree(root), hash, "source changed after collection");
  if (!live) { console.log(JSON.stringify({ validatedQueries: dataset.pools.length, candidates: dataset.pools.reduce((sum, pool) => sum + pool.candidates.length, 0), datasetSha256, apiCalls: 0 })); return; }
  assert.ok(process.env.TYPESAFE_API_KEY, "TYPESAFE_API_KEY required before live ranking");
  const output = join(ROOT, "results/retrieval", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(output, { recursive: false });
  await save(join(output, "frozen-inputs.json"), { datasetSha256, labelsSha256: await sha256File(LABELS), protocolSha256: dataset.protocolSha256, rankingCoreSha256: await hashTree(join(ROOT, "src")), harnessSha256: await sha256File(new URL(import.meta.url).pathname), metricsSha256: await sha256File(join(DIRECTORY, "metrics.ts")), dataset, labels });
  const measured: MeasuredRow[] = [];
  let cost = 0;
  let fallbacks = 0;
  for (const pool of dataset.pools) {
    for (const order of ["native", "deterministic", "jev-1", "jev-2"] as const) {
      if (cost >= 1) throw new Error("$1 ranking budget exhausted; preserve partial results");
      const ranked = await rankCandidates(pool.query.intent, pool.candidates, { order: order.startsWith("jev") ? "jev" : order as "native" | "deterministic", batchSize: 8 });
      cost += ranked.metrics.inputTokens * INPUT_USD_PER_MILLION / 1e6;
      if (ranked.metrics.fallback) fallbacks++;
      const row: MeasuredRow = { queryId: pool.query.id, kind: pool.query.kind, order,
        certain: measure(ranked.candidates, pool.candidates, labels.byQuery[pool.query.id]),
        inclusive: measure(ranked.candidates, pool.candidates, labels.byQuery[pool.query.id], true) };
      measured.push(row);
      await save(join(output, `${pool.query.id}-${order}.json`), { ...row, metrics: ranked.metrics, scores: ranked.scores, candidateOrder: ranked.candidates.map((candidate) => candidate.id) });
      console.log(`[rank] ${pool.query.id} ${order}: first=${row.certain.firstUsefulRank ?? "absent"} fallback=${ranked.metrics.fallback ?? "none"}`);
    }
  }
  const certain = decision(measured, "certain");
  const inclusive = decision(measured, "inclusive");
  await save(join(output, "summary.json"), { measured, estimatedRankingCostUsd: cost, fallbacks, certain, inclusive,
    qualifiesForAgentEffortGate: !fallbacks && certain.qualifies && inclusive.qualifies });
  console.log(JSON.stringify({ resultDir: output, estimatedRankingCostUsd: cost, fallbacks, certain, inclusive }, null, 2));
}

const mode = process.argv[2];
if (mode === "collect") await collect();
else if (mode === "check" || mode === "live") await score(mode === "live");
else throw new Error("usage: node --import tsx eval/retrieval/cli.ts collect|check|live");
