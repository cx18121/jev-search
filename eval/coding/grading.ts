import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DockerWorkspace } from "./docker.ts";
import type { CodingTask, GradeResult, TestCaseResult } from "./types.ts";

function xmlDecode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function attribute(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`));
  return match ? xmlDecode(match[1] ?? match[2] ?? "") : undefined;
}

export function parseJUnit(xml: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const regex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(regex)) {
    const attrs = match[1];
    const body = match[2] ?? "";
    const name = attribute(attrs, "name") ?? "";
    const classname = attribute(attrs, "classname");
    const file = attribute(attrs, "file")?.replaceAll("\\", "/");
    const id = classname ? `${classname}::${name}` : file ? `${file}::${name}` : name;
    const failure = body.match(/<(failure|error|skipped)\b([^>]*)>/);
    cases.push({
      id,
      status: failure?.[1] === "failure" ? "failed" : failure?.[1] === "error" ? "error" : failure?.[1] === "skipped" ? "skipped" : "passed",
      ...(failure ? { message: attribute(failure[2], "message") } : {}),
    });
  }
  return cases;
}

function expectedAliases(expected: string): string[] {
  const parts = expected.split("::");
  const path = parts.shift();
  if (!path || parts.length === 0) return [expected];
  const dotted = path.replace(/\.py$/, "").replaceAll("/", ".");
  return [expected, `${dotted}${parts.length > 1 ? `.${parts.slice(0, -1).join(".")}` : ""}::${parts.at(-1)}`];
}

function matchExpected(cases: TestCaseResult[], expected: string): TestCaseResult[] {
  const aliases = expectedAliases(expected);
  return cases.filter((testCase) => aliases.some((alias) => testCase.id === alias || testCase.id.endsWith(`::${alias}`)));
}

export function evaluateJUnit(input: {
  cases: TestCaseResult[];
  exitCode: number | null;
  failToPass: string[];
  passToPass: string[];
  mode: "baseline" | "candidate";
  junitPath: string;
  rawOutputPath: string;
}): GradeResult {
  const reasons: string[] = [];
  const expected: GradeResult["expected"] = [];
  const wanted = [
    ...input.failToPass.map((id) => ({ id, group: "FAIL_TO_PASS" as const })),
    ...input.passToPass.map((id) => ({ id, group: "PASS_TO_PASS" as const })),
  ];
  for (const row of wanted) {
    const matches = matchExpected(input.cases, row.id);
    if (matches.length !== 1) {
      expected.push({ ...row, status: "missing" });
      reasons.push(`${row.group} ${row.id} matched ${matches.length} JUnit cases (expected exactly 1)`);
      continue;
    }
    const status = matches[0].status;
    expected.push({ ...row, status });
    const correct = row.group === "FAIL_TO_PASS" && input.mode === "baseline"
      ? status === "failed" || status === "error"
      : status === "passed";
    if (!correct) reasons.push(`${row.group} ${row.id} was ${status}`);
  }
  if (input.mode === "candidate" && input.exitCode !== 0) reasons.push(`official test command exited ${input.exitCode}; exit 0 alone is never sufficient, but is still required`);
  if (input.mode === "baseline" && input.exitCode === 0) reasons.push("baseline command unexpectedly exited 0 despite required FAIL_TO_PASS failures");
  const expectedIds = new Set(wanted.flatMap((row) => expectedAliases(row.id)));
  const unexpectedFailures = input.cases
    .filter((item) => (item.status === "failed" || item.status === "error") && ![...expectedIds].some((id) => item.id === id || item.id.endsWith(`::${id}`)))
    .map((item) => item.id);
  if (unexpectedFailures.length > 0) reasons.push(`${unexpectedFailures.length} additional test failure(s)`);
  return { passed: reasons.length === 0, exitCode: input.exitCode, expected, unexpectedFailures, reasons, junitPath: input.junitPath, rawOutputPath: input.rawOutputPath };
}

export async function applyPatch(workspace: string, patchPath: string): Promise<void> {
  const result = await host("patch", ["--batch", "--forward", "-p1", "-i", patchPath], workspace);
  if (result.code !== 0) throw new Error(`patch apply failed for ${patchPath}: ${result.stderr || result.stdout}`);
}

export async function gradeWorkspace(input: {
  container: DockerWorkspace;
  task: CodingTask;
  mode: "baseline" | "candidate";
  evidenceDir: string;
  label: string;
}): Promise<GradeResult> {
  const junitName = `.harness/${input.label}-junit.xml`;
  const junitHost = join(input.container.workspace, junitName);
  const rawPath = join(input.evidenceDir, `${input.label}-raw.txt`);
  await rm(junitHost, { force: true });
  const command = input.task.test.kind === "pytest"
    ? `${input.task.test.command} --junitxml=/workspace/${junitName}`
    : input.task.test.command.replace(/^python bin\/test\s+/, "python bin/test -v ");
  const result = await input.container.exec(["bash", "-lc", command], { timeoutMs: input.task.test.timeoutMs ?? 600_000 });
  await mkdir(input.evidenceDir, { recursive: true });
  const raw = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  await writeFile(rawPath, raw, "utf8");
  if (input.task.test.kind === "sympy") {
    const parsed = [...raw.matchAll(/^\s*(test[A-Za-z0-9_]+)\s+(ok|F|E|f|s)\s*$/gm)].map((match) => ({
      id: match[1],
      status: match[2] === "ok" ? "passed" : match[2] === "F" ? "failed" : match[2] === "E" ? "error" : "skipped",
    } satisfies TestCaseResult));
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const body = parsed.map((item) => `<testcase name="${escape(item.id)}">${item.status === "passed" ? "" : item.status === "skipped" ? "<skipped/>" : `<${item.status === "failed" ? "failure" : "error"}/>`}</testcase>`).join("");
    await writeFile(junitHost, `<testsuite tests="${parsed.length}">${body}</testsuite>\n`, "utf8");
  }
  let cases: TestCaseResult[] = [];
  try {
    cases = parseJUnit(await readFile(junitHost, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      exitCode: result.exitCode,
      expected: [
        ...input.task.test.failToPass.map((id) => ({ id, group: "FAIL_TO_PASS" as const, status: "missing" as const })),
        ...input.task.test.passToPass.map((id) => ({ id, group: "PASS_TO_PASS" as const, status: "missing" as const })),
      ],
      unexpectedFailures: [],
      reasons: [`JUnit output missing or unreadable: ${reason}`],
      junitPath: junitHost,
      rawOutputPath: rawPath,
    };
  }
  const persistedJunit = join(input.evidenceDir, `${input.label}-junit.xml`);
  await cp(junitHost, persistedJunit);
  return evaluateJUnit({
    cases,
    exitCode: result.exitCode,
    failToPass: input.task.test.failToPass,
    passToPass: input.task.test.passToPass,
    mode: input.mode,
    junitPath: persistedJunit,
    rawOutputPath: rawPath,
  });
}

function isProtected(path: string, task: CodingTask): boolean {
  const posix = path.split(sep).join("/");
  const parts = posix.split("/");
  const name = basename(posix);
  if (parts.some((part) => part === "test" || part === "tests" || part === "testing")) return true;
  if (name === "conftest.py" || /^test_.*\.py$/.test(name) || /_test\.py$/.test(name)) return true;
  return (task.protectedTestPaths ?? []).some((prefix) => posix === prefix || posix.startsWith(`${prefix}/`));
}

async function files(root: string): Promise<Map<string, "file" | "directory">> {
  const result = new Map<string, "file" | "directory">();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".harness") continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (entry.isSymbolicLink()) throw new Error(`candidate contains forbidden symlink: ${rel}`);
      if (entry.isDirectory()) { result.set(rel, "directory"); await visit(path); }
      else if (entry.isFile()) result.set(rel, "file");
      else throw new Error(`candidate contains unsupported entry: ${rel}`);
    }
  }
  await visit(root);
  return result;
}

function host(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

/** Build the only candidate artifact used for grading; test/conftest changes never enter it. */
export async function buildSourcePatch(input: {
  base: string;
  candidate: string;
  staging: string;
  patchPath: string;
  task: CodingTask;
}): Promise<{ changedPaths: string[]; excludedTestPaths: string[] }> {
  await rm(input.staging, { recursive: true, force: true });
  await cp(input.base, input.staging, { recursive: true, verbatimSymlinks: true });
  const [baseFiles, candidateFiles] = await Promise.all([files(input.base), files(input.candidate)]);
  const all = new Set([...baseFiles.keys(), ...candidateFiles.keys()]);
  const changedPaths: string[] = [];
  const excludedTestPaths: string[] = [];
  for (const path of [...all].sort()) {
    const baseKind = baseFiles.get(path);
    const candidateKind = candidateFiles.get(path);
    if (isProtected(path, input.task)) {
      if (baseKind !== candidateKind || (baseKind === "file" && candidateKind === "file" && !((await readFile(join(input.base, path))).equals(await readFile(join(input.candidate, path)))))) excludedTestPaths.push(path.split(sep).join("/"));
      continue;
    }
    if (baseKind === "directory" || candidateKind === "directory") continue;
    const same = baseKind === "file" && candidateKind === "file" && (await readFile(join(input.base, path))).equals(await readFile(join(input.candidate, path)));
    if (same) continue;
    changedPaths.push(path.split(sep).join("/"));
  }
  await rm(join(input.staging, ".git"), { recursive: true, force: true });
  const init = await host("git", ["init", "--quiet"], input.staging);
  if (init.code !== 0) throw new Error(`git init for source diff failed: ${init.stderr}`);
  for (const args of [["add", "-A"], ["-c", "user.name=harness", "-c", "user.email=harness@invalid", "commit", "--quiet", "-m", "base"]]) {
    const result = await host("git", args, input.staging);
    if (result.code !== 0) throw new Error(`git ${args[0]} for source diff failed: ${result.stderr}`);
  }
  // Reset the synthetic worktree to base, then overlay only accepted candidate changes.
  for (const path of changedPaths) {
    const source = join(input.candidate, path);
    const target = join(input.staging, path);
    try {
      const stat = await lstat(source);
      if (stat.isFile()) { await mkdir(dirname(target), { recursive: true }); await cp(source, target); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await rm(target, { force: true });
      else throw error;
    }
  }
  await host("git", ["add", "-N", "."], input.staging);
  const diff = await host("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."], input.staging);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  await mkdir(dirname(input.patchPath), { recursive: true });
  await writeFile(input.patchPath, diff.stdout);
  await rm(join(input.staging, ".git"), { recursive: true, force: true });
  return { changedPaths, excludedTestPaths };
}
