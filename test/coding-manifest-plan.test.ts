import assert from "node:assert/strict";
import test from "node:test";
import { loadManifest, parseManifest } from "../eval/coding/manifest.ts";
import { buildPlan } from "../eval/coding/plan.ts";

const manifestPath = new URL("../eval/coding/tasks/manifest.json", import.meta.url).pathname;

test("actual fixture manifest normalizes five bounded tasks", async () => {
  const loaded = await loadManifest(manifestPath);
  assert.equal(loaded.manifest.tasks.length, 5);
  assert.equal(loaded.manifest.tasks[0].test.kind, "sympy");
  assert.equal(loaded.manifest.tasks[2].test.kind, "pytest");
  assert.match(loaded.manifest.tasks[2].test.command, /^PYTHONPATH=\/workspace\/src python /);
  assert.equal(buildPlan(loaded.manifest.tasks).length, 30);
});

test("plan counterbalances every task/repeat block without randomization", async () => {
  const { manifest } = await loadManifest(manifestPath);
  const first = buildPlan(manifest.tasks);
  const second = buildPlan(manifest.tasks);
  assert.deepEqual(first, second);
  for (const task of manifest.tasks) {
    for (const repeat of [1, 2]) {
      const block = first.filter((row) => row.taskId === task.id && row.repeat === repeat);
      assert.deepEqual(new Set(block.map((row) => row.arm)), new Set(["stock", "deterministic", "jev"]));
      assert.deepEqual(block.map((row) => row.position), [1, 2, 3]);
    }
  }
});

test("manifest rejects a host virtualenv command", async () => {
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8"));
  raw.tasks[0].test_command = "/host/.venv/bin/python -m pytest";
  assert.throws(() => parseManifest(raw), /image's python prefix/);
});
