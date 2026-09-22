import assert from "node:assert/strict";
import test from "node:test";
import { DockerWorkspace } from "../eval/coding/docker.ts";
import { outcomeStatus } from "../eval/coding/runner.ts";
import type { GradeResult } from "../eval/coding/types.ts";

const passed = { passed: true } as GradeResult;

test("missing grading always means infrastructure failure, even after a budget stop", () => {
  for (const stop of [undefined, "timeout", "turn_limit", "cost_limit", "error"] as const) {
    assert.equal(outcomeStatus(undefined, stop), "infra_error");
    assert.equal(outcomeStatus(passed, stop), "solved");
  }
  assert.equal(outcomeStatus({ ...passed, passed: false }, "timeout"), "timeout");
});

test("Bash timeout stays in seconds and does not use the container lifetime timer", async () => {
  const workspace = new DockerWorkspace({ workspace: "/unused", image: "unused", name: "unit" });
  const calls: string[][] = [];
  workspace.exec = async (argv, options) => {
    calls.push(argv);
    assert.equal(options?.timeoutMs, undefined);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  await workspace.bashOperations().exec("sleep 2; echo alive", "/unused", { timeout: 120, onData() {} });
  assert.deepEqual(calls, [["timeout", "--kill-after=1s", "120s", "bash", "-lc", "sleep 2; echo alive"]]);
});

test("timed out and missing-exit-code commands cannot report Bash success", async () => {
  const workspace = new DockerWorkspace({ workspace: "/unused", image: "unused", name: "unit" });
  for (const exitCode of [124, 137, null]) {
    workspace.exec = async () => ({ exitCode, stdout: "", stderr: "", timedOut: false });
    await assert.rejects(workspace.bashOperations().exec("echo alive", "/unused", { timeout: 1, onData() {} }));
  }
});
