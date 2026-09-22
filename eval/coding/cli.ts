import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadManifest, verifyFixture } from "./manifest.ts";
import { dryRun, runLive, runPreflight } from "./runner.ts";

function usage(): never {
  throw new Error("usage: node --import tsx eval/coding/cli.ts --manifest <path> [--live | --preflight | --offline-smoke]\nDefault is dry-run. --live is the only mode that invokes the model API.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifestIndex = args.indexOf("--manifest");
  if (manifestIndex < 0 || !args[manifestIndex + 1]) usage();
  const modes = ["--live", "--preflight", "--offline-smoke"].filter((flag) => args.includes(flag));
  if (modes.length > 1) usage();
  const loaded = await loadManifest(args[manifestIndex + 1]);
  if (modes[0] === "--live") {
    const result = await runLive(loaded);
    console.log(JSON.stringify({ mode: "live", resultDir: result.resultDir, completed: result.outcomes.length }, null, 2));
    return;
  }
  if (modes[0] === "--preflight") {
    const output = resolve(`results/coding/preflight-${Date.now()}`);
    await mkdir(output, { recursive: true });
    const result = await runPreflight(loaded, output);
    console.log(JSON.stringify({ mode: "preflight", output, ...result }, null, 2));
    return;
  }
  if (modes[0] === "--offline-smoke") {
    for (const task of loaded.manifest.tasks) await verifyFixture(loaded, task);
    console.log(JSON.stringify({ ...(await dryRun(loaded)), mode: "offline-smoke", checks: ["manifest schema", "five task count", "fixture and trusted patch hashes", "30-run counterbalanced plan", "versioned runner/SDK/FFF source hashes"], apiCalls: 0, containersStarted: 0 }, null, 2));
    return;
  }
  console.log(JSON.stringify(await dryRun(loaded), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
