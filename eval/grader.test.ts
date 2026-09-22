import assert from "node:assert/strict";
import test from "node:test";
import { gradeAnswer, parseStructuredAnswer } from "./grader.ts";
import { TASKS, type NavigationTask } from "./tasks.ts";

const task: NavigationTask = {
  id: "test",
  title: "test",
  prompt: "test",
  requiredPaths: ["src/a.ts"],
  factCriteria: [{ id: "word", description: "mentions behavior", patterns: [/behavior/i] }],
};

test("parseStructuredAnswer accepts fenced JSON and normalizes paths", () => {
  assert.deepEqual(
    parseStructuredAnswer('```json\n{"paths":["./src\\\\a.ts"],"facts":[" verified "]}\n```'),
    { paths: ["src/a.ts"], facts: ["verified"] },
  );
});

test("gradeAnswer reports deterministic path and fact results", () => {
  const grade = gradeAnswer(task, '{"paths":["src/a.ts"],"facts":["Behavior is verified."]}');
  assert.equal(grade.parsed, true);
  assert.equal(grade.pathScore, 1);
  assert.equal(grade.factScore, 1);
  assert.equal(grade.score, grade.maxScore);
});

test("boundary criterion accepts singular and plural without changing the factual requirement", () => {
  const memoryTask = TASKS.find((task) => task.id === "memory-search-pipeline")!;
  for (const word of ["boundary", "boundaries"]) {
    const grade = gradeAnswer(memoryTask, JSON.stringify({
      paths: memoryTask.requiredPaths,
      facts: [`exactPhrase checks identifier-aware ${word} and punctuation.`],
    }));
    assert.equal(grade.criteria.find((criterion) => criterion.id === "boundaries")?.passed, true);
  }
});

test("gradeAnswer returns a zero structured grade for malformed output", () => {
  const grade = gradeAnswer(task, "not json");
  assert.equal(grade.parsed, false);
  assert.equal(grade.score, 0);
  assert.deepEqual(grade.missingPaths, ["src/a.ts"]);
  assert.match(grade.parseError ?? "", /JSON/);
});
