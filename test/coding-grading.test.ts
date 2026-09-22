import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJUnit, parseJUnit } from "../eval/coding/grading.ts";

const paths = { junitPath: "junit.xml", rawOutputPath: "raw.txt" };

test("candidate requires exact FAIL_TO_PASS and PASS_TO_PASS IDs, pass status, and exit zero", () => {
  const cases = parseJUnit(`<testsuite>
    <testcase classname="testing.test_mark.TestFunctional" name="test_fix"/>
    <testcase classname="testing.test_mark.TestFunctional" name="test_old"/>
    <testcase classname="testing.test_mark.TestFunctional" name="preexisting_xfail"><skipped type="pytest.xfail"/></testcase>
  </testsuite>`);
  const grade = evaluateJUnit({ cases, exitCode: 0,
    failToPass: ["testing/test_mark.py::TestFunctional::test_fix"],
    passToPass: ["testing/test_mark.py::TestFunctional::test_old"], mode: "candidate", ...paths });
  assert.equal(grade.passed, true);
});

test("expected skip/xfail and missing IDs fail even when command exits zero", () => {
  const cases = parseJUnit(`<testsuite><testcase classname="pkg.test" name="required"><skipped type="pytest.xfail"/></testcase></testsuite>`);
  const grade = evaluateJUnit({ cases, exitCode: 0, failToPass: ["pkg/test.py::required"], passToPass: ["pkg/test.py::missing"], mode: "candidate", ...paths });
  assert.equal(grade.passed, false);
  assert.deepEqual(grade.expected.map((row) => row.status), ["skipped", "missing"]);
});

test("baseline requires selected regression failures and selected non-regressions passing", () => {
  const cases = parseJUnit(`<testsuite><testcase name="new_regression"><failure/></testcase><testcase name="old_behavior"/></testsuite>`);
  const good = evaluateJUnit({ cases, exitCode: 1, failToPass: ["new_regression"], passToPass: ["old_behavior"], mode: "baseline", ...paths });
  assert.equal(good.passed, true);
  const bad = evaluateJUnit({ cases, exitCode: 0, failToPass: ["new_regression"], passToPass: ["old_behavior"], mode: "baseline", ...paths });
  assert.equal(bad.passed, false);
});

test("unexpected failures are regressions", () => {
  const cases = parseJUnit(`<testsuite><testcase name="required"/><testcase name="old"><failure/></testcase></testsuite>`);
  const grade = evaluateJUnit({ cases, exitCode: 1, failToPass: ["required"], passToPass: [], mode: "candidate", ...paths });
  assert.equal(grade.passed, false);
  assert.deepEqual(grade.unexpectedFailures, ["old"]);
});
