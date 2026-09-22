import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDataset, planOnly, runLive, runPreflight } from "./runner.ts";

function usage(): never {
  throw new Error("usage: node --import tsx eval/effort/cli.ts [--preflight | --live]\nDefault prints the model-free 60-run plan. --preflight performs no inference. Only --live permits model/API calls.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--preflight" && arg !== "--live") || (args.includes("--preflight") && args.includes("--live"))) usage();
  const dataset = await loadDataset();
  if (args.includes("--live")) {
    const result = await runLive(dataset);
    console.log(JSON.stringify({ mode: "live", resultDir: result.resultDir, campaignStatus: result.campaignStatus, completed: result.outcomes.length }, null, 2));
    return;
  }
  if (args.includes("--preflight")) {
    const output = resolve(`results/effort/preflight-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
    await mkdir(output, { recursive: true });
    const result = await runPreflight(dataset, output);
    console.log(JSON.stringify({ mode: "preflight", output, ...result }, null, 2));
    return;
  }
  console.log(JSON.stringify(await planOnly(dataset), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
