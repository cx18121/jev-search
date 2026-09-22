import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CodingManifest, CodingTask } from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../..");

export function sha256Buffer(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
export async function sha256File(path: string): Promise<string> { return sha256Buffer(await readFile(path)); }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) throw new Error(`${label} must be a non-empty string array`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}
function hash(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256`);
  return result;
}
function safeProjectPath(value: unknown, label: string): string {
  const path = string(value, label).replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("~") || path.split("/").some((part) => part === ".." || part === "")) throw new Error(`${label} must be a safe project-relative path`);
  return path;
}

function parseTask(value: unknown, index: number): CodingTask {
  const row = object(value, `tasks[${index}]`);
  const archive = object(row.base_source_archive, `tasks[${index}].base_source_archive`);
  const environment = object(row.environment, `tasks[${index}].environment`);
  const gold = object(row.official_gold_patch, `tasks[${index}].official_gold_patch`);
  const tests = object(row.official_test_patch, `tasks[${index}].official_test_patch`);
  const id = string(row.instance_id, `tasks[${index}].instance_id`);
  if (!SAFE_ID.test(id)) throw new Error(`unsafe task id: ${id}`);
  const command = string(row.test_command, `tasks[${index}].test_command`);
  if (!/^(?:PYTHONPATH=\/workspace\/src )?python(?: |$)/.test(command)) throw new Error(`${id} test command must use the image's python prefix`);
  return {
    id,
    title: id,
    prompt: string(row.problem_statement, `${id}.problem_statement`),
    repo: string(row.repo, `${id}.repo`),
    baseCommit: string(row.base_commit, `${id}.base_commit`),
    baseArchive: safeProjectPath(archive.path, `${id}.base_source_archive.path`),
    baseSha256: hash(archive.sha256, `${id}.base_source_archive.sha256`),
    workspacePrefix: string(archive.workspace_prefix, `${id}.base_source_archive.workspace_prefix`),
    image: {
      ref: string(environment.docker_image, `${id}.environment.docker_image`),
      id: string(environment.docker_image_id, `${id}.environment.docker_image_id`),
      platform: string(environment.platform, `${id}.environment.platform`),
      python: string(environment.python, `${id}.environment.python`),
    },
    goldPatch: safeProjectPath(gold.path, `${id}.official_gold_patch.path`),
    goldPatchSha256: hash(gold.sha256, `${id}.official_gold_patch.sha256`),
    withheldTestPatch: safeProjectPath(tests.path, `${id}.official_test_patch.path`),
    withheldTestPatchSha256: hash(tests.sha256, `${id}.official_test_patch.sha256`),
    protectedTestPaths: ["setup.py", "setup.cfg", "pytest.ini", "tox.ini", "pyproject.toml", ...(command.includes("bin/test") ? ["bin"] : [])],
    test: {
      command,
      kind: command.includes("bin/test") ? "sympy" : "pytest",
      timeoutMs: 600_000,
      failToPass: strings(row.selected_FAIL_TO_PASS, `${id}.selected_FAIL_TO_PASS`),
      passToPass: strings(row.selected_PASS_TO_PASS, `${id}.selected_PASS_TO_PASS`),
    },
  };
}

export function parseManifest(value: unknown): CodingManifest {
  const row = object(value, "manifest");
  if (row.schema_version !== 1) throw new Error("manifest.schema_version must be 1");
  const dataset = object(row.dataset, "manifest.dataset");
  const tasks = Array.isArray(row.tasks) ? row.tasks.map(parseTask) : [];
  if (tasks.length !== 5) throw new Error(`manifest must contain exactly 5 tasks; got ${tasks.length}`);
  if (new Set(tasks.map((task) => task.id)).size !== 5) throw new Error("task ids must be unique");
  return {
    schemaVersion: 1,
    campaignId: "swe-bench-lite-search-comparison-v1",
    fixtureVersion: `${string(dataset.id, "dataset.id")}@${hash(dataset.sha256, "dataset.sha256")}`,
    provenance: dataset,
    tasks,
  };
}

export type LoadedManifest = { manifest: CodingManifest; path: string; dir: string; projectDir: string; sha256: string };
export async function loadManifest(path: string): Promise<LoadedManifest> {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  return { manifest: parseManifest(JSON.parse(bytes.toString("utf8"))), path: absolute, dir: dirname(absolute), projectDir: PROJECT_DIR, sha256: sha256Buffer(bytes) };
}
export function fixturePath(loaded: LoadedManifest, path: string): string { return resolve(loaded.projectDir, path); }

/** Stable content hash; symlinks are rejected so the hash never follows fixture escapes. */
export async function hashTree(root: string): Promise<string> {
  const actualRoot = await realpath(root);
  const entries: Array<{ path: string; hash: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const rel = relative(actualRoot, path).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`tree contains a symlink: ${rel}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) entries.push({ path: rel, hash: await sha256File(path) });
      else throw new Error(`tree contains unsupported entry: ${rel}`);
    }
  }
  await visit(actualRoot);
  return sha256Buffer(entries.map((entry) => `${entry.hash}  ${entry.path}\n`).join(""));
}

export async function verifyFixture(loaded: LoadedManifest, task: CodingTask): Promise<void> {
  for (const [path, expected, label] of [
    [fixturePath(loaded, task.baseArchive), task.baseSha256, "base archive"],
    [fixturePath(loaded, task.goldPatch), task.goldPatchSha256, "gold patch"],
    [fixturePath(loaded, task.withheldTestPatch), task.withheldTestPatchSha256, "withheld test patch"],
  ] as const) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${path}`);
    const actual = await sha256File(path);
    if (actual !== expected) throw new Error(`${task.id} ${label} hash mismatch: expected ${expected}, got ${actual}`);
  }
}
