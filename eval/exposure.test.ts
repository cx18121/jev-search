import assert from "node:assert/strict";
import test from "node:test";
import { gradeAnswer } from "./grader.ts";
import { evaluateComparisonGate } from "./runner.ts";
import type { NavigationTask, SearchOrder } from "./tasks.ts";

const task: NavigationTask = {
  id: "gate",
  title: "gate",
  prompt: "gate",
  requiredPaths: ["src/a.ts"],
  // Deliberately impossible: fact-pattern scoring must not gate a structurally
  // valid answer with the required path.
  factCriteria: [{ id: "phrasing", description: "alternate phrasing", patterns: [/never-match/] }],
};

const validGrade = gradeAnswer(task, '{"paths":["src/a.ts"],"facts":["A legitimate differently phrased fact."]}');
const invalidGrade = gradeAnswer(task, "not json");

function observation(rerank: Record<string, unknown>, isError = false) {
  return { isError, details: { rerank } };
}

function gate(order: SearchOrder, observations: ReturnType<typeof observation>[], grade = validGrade, status = "ok" as const) {
  return evaluateComparisonGate({ order, observations, grade, status });
}

test("Jev requires API exposure, no fallback, and direct changed-order evidence", () => {
  const result = gate("jev", [
    observation({ poolSize: 8, scanCalls: 1, calls: 1, fallback: undefined, orderChanged: true }),
  ]);
  assert.equal(validGrade.factScore, 0);
  assert.equal(result.passed, true);
  assert.equal(result.modelRerankCalls, 1);
  assert.equal(result.orderChangedObserved, true);
  assert.deepEqual(result.reasons, []);
});

test("Jev rejects fallback, zero API calls, or unchanged ordering", () => {
  const fallback = gate("jev", [
    observation({ poolSize: 8, scanCalls: 1, calls: 1, fallback: "timeout", orderChanged: false }),
  ]);
  assert.equal(fallback.passed, false);
  assert.equal(fallback.fallbackObserved, true);
  assert.ok(fallback.reasons.some((reason) => reason.includes("fallback")));
  assert.ok(fallback.reasons.some((reason) => reason.includes("did not change")));

  const noCalls = gate("jev", [observation({ poolSize: 8, scanCalls: 1, calls: 0, orderChanged: true })]);
  assert.equal(noCalls.passed, false);
  assert.ok(noCalls.reasons.some((reason) => reason.includes("no ranking API calls")));

  const smallFallback = gate("jev", [
    observation({ poolSize: 8, scanCalls: 1, calls: 1, orderChanged: true }),
    observation({ poolSize: 1, scanCalls: 1, calls: 0, fallback: "unavailable", orderChanged: false }),
  ]);
  assert.equal(smallFallback.passed, false);
  assert.equal(smallFallback.fallbackObserved, true);
});

test("native and deterministic require zero ranking API calls", () => {
  for (const order of ["native", "deterministic"] as const) {
    assert.equal(gate(order, [observation({ poolSize: 5, scanCalls: 1, calls: 0, orderChanged: false })]).passed, true);
    const unexpected = gate(order, [
      observation({ poolSize: 5, scanCalls: 1, calls: 0, orderChanged: false }),
      observation({ poolSize: 1, scanCalls: 1, calls: 1, orderChanged: false }),
    ]);
    assert.equal(unexpected.passed, false);
    assert.ok(unexpected.reasons.some((reason) => reason.includes("unexpectedly")));
  }
});

test("cursor continuations do not duplicate exposed pool-size accounting", () => {
  const result = gate("native", [
    observation({ poolSize: 7, scanCalls: 1, calls: 0, orderChanged: false }),
    observation({ poolSize: 7, scanCalls: 0, calls: 0, orderChanged: false }),
    observation({ poolSize: 4, scanCalls: 1, calls: 0, orderChanged: false }),
  ]);
  assert.equal(result.qualifyingCalls, 3);
  assert.equal(result.exposedPools, 2);
  assert.equal(result.exposedPoolSizeSum, 11);
});

test("status and structured answer validity gate comparison independently of fact score", () => {
  const telemetry = [observation({ poolSize: 5, scanCalls: 1, calls: 0, orderChanged: false })];
  const badAnswer = evaluateComparisonGate({ order: "native", status: "ok", grade: invalidGrade, observations: telemetry });
  assert.equal(badAnswer.passed, false);
  assert.equal(badAnswer.structuredAnswerValid, false);

  const badStatus = evaluateComparisonGate({ order: "native", status: "error", grade: validGrade, observations: telemetry });
  assert.equal(badStatus.passed, false);
  assert.ok(badStatus.reasons.some((reason) => reason.includes("status")));
});
