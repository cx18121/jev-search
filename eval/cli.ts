#!/usr/bin/env node
import { resolve } from "node:path";
import { getTask, SEARCH_ORDERS, TASKS, type SearchOrder } from "./tasks.ts";
import {
  buildPlan,
  defaultSelection,
  loadSnapshotManifest,
  MAX_TURNS,
  MODEL,
  runLive,
  TOOLS,
  WALL_TIMEOUT_MS,
  type RunSelection,
} from "./runner.ts";
import { runOfflineSmoke } from "./offline-smoke.ts";

type Options = {
  live: boolean;
  offlineSmoke: boolean;
  task?: string;
  order?: SearchOrder;
  help: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx eval/cli.ts [--live] [--task <id>] [--order native|deterministic|jev]",
    "       node --import tsx eval/cli.ts --offline-smoke",
    "",
    "Without --live, prints the exact bounded plan and makes no API/model calls.",
    "--offline-smoke invokes the real registered fffind/ffgrep tools without prompting a model.",
    "",
    `Tasks: ${TASKS.map((task) => task.id).join(", ")}`,
  ].join("\n");
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { live: false, offlineSmoke: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") options.live = true;
    else if (arg === "--offline-smoke") options.offlineSmoke = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--task") {
      const value = argv[++index];
      if (!value) throw new Error("--task requires an id");
      options.task = value;
    } else if (arg === "--order") {
      const value = argv[++index];
      if (!SEARCH_ORDERS.includes(value as SearchOrder)) {
        throw new Error(`--order must be one of: ${SEARCH_ORDERS.join(", ")}`);
      }
      options.order = value as SearchOrder;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.live && options.offlineSmoke) throw new Error("Choose --live or --offline-smoke, not both");
  if (options.offlineSmoke && (options.task || options.order)) {
    throw new Error("--offline-smoke does not accept --task or --order");
  }
  return options;
}

function selectionFor(options: Options): RunSelection {
  const defaults = defaultSelection();
  const task = options.task ? getTask(options.task) : undefined;
  if (options.task && !task) throw new Error(`Unknown task: ${options.task}`);
  return {
    tasks: task ? [task] : defaults.tasks,
    orders: options.order ? [options.order] : defaults.orders,
  };
}

async function printDryRun(selection: RunSelection): Promise<void> {
  const snapshot = await loadSnapshotManifest();
  const plan = buildPlan(selection);
  console.log("DRY RUN — no API/model calls and no result directory created");
  console.log(`model=${MODEL.provider}/${MODEL.id} thinking=${MODEL.thinking}`);
  console.log(`bounds=runs:${plan.length}/9 turns:${MAX_TURNS}/run wall:${WALL_TIMEOUT_MS}ms/run retries:0 compaction:off`);
  console.log(`tools=${TOOLS.join(",")} (read-only; no bash/edit/write)`);
  console.log(`snapshot=${snapshot.snapshotId} files=${snapshot.files.length} TypeScript-only`);
  console.log("arms=same enhanced ffgrep/fffind interface; JEV_SEARCH_ORDER varies; native is not stock FFF");
  console.log("stock-baseline=pending/not in this pilot");
  for (const [index, row] of plan.entries()) {
    console.log(`${String(index + 1).padStart(2, "0")} task=${row.taskId} order=${row.order}`);
  }
  console.log("live-output=ignored results/<unique-id>/{manifest.json,run-*/outcome.json,run-*/transcript.json,summary.json}");
  console.log("scope=navigation correctness only; sample is insufficient for coding efficacy, productivity, or daily rollout");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.offlineSmoke) {
    const result = await runOfflineSmoke();
    console.log(`OFFLINE SMOKE ok fffind=${result.findCount} ffgrepPages=${result.grepPages} grepCandidates=${result.grepCandidates}`);
    return;
  }

  const selection = selectionFor(options);
  if (!options.live) {
    await printDryRun(selection);
    return;
  }

  const result = await runLive(selection);
  for (const outcome of result.outcomes) {
    console.log([
      outcome.taskId,
      outcome.order,
      outcome.status,
      `score=${outcome.grade.score}/${outcome.grade.maxScore}`,
      `turns=${outcome.turns}`,
      `ffgrep=${outcome.ffgrepUsed ? "yes" : "no"}`,
      `compare=${outcome.comparisonGate.passed ? "eligible" : "invalid"}`,
      `rerankCalls=${outcome.comparisonGate.modelRerankCalls}`,
      `changed=${outcome.comparisonGate.orderChangedObserved ? "yes" : "no"}`,
      `tokens=${outcome.totalUsage.input}+${outcome.totalUsage.output}`,
      `cost=$${outcome.totalUsage.cost.total.toFixed(6)}`,
      `ms=${outcome.elapsedMs}`,
    ].join("\t"));
  }
  console.log(`results=${resolve(result.resultDir)}`);
  console.log("NOTE: This small navigation-only sample is insufficient to choose coding efficacy or justify daily rollout.");
}

main().catch((error) => {
  console.error(`eval: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
