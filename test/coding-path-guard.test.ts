import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRelativeSearchPath, truncateUtf8, WorkspaceGuard } from "../eval/coding/path-guard.ts";

test("workspace guard rejects traversal, absolute paths, and escaping symlinks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "coding-guard-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside.txt");
  await mkdir(root);
  await writeFile(outside, "secret");
  await writeFile(join(root, "inside.txt"), "inside");
  await symlink(outside, join(root, "escape-file"));
  await symlink(parent, join(root, "escape-parent"));
  const guard = await WorkspaceGuard.create(root);
  try {
    assert.equal((await guard.read("inside.txt")).toString(), "inside");
    await assert.rejects(guard.read("../outside.txt"), /escapes workspace/);
    await assert.rejects(guard.read(outside), /workspace-relative/);
    await assert.rejects(guard.read("escape-file"), /symlink/);
    await assert.rejects(guard.write("escape-parent/new.txt", "bad"), /symlink/);
    await assert.rejects(guard.write("../new.txt", "bad"), /escapes workspace/);
    assert.equal(await readFile(outside, "utf8"), "secret");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("search path guard permits only relative workspace paths", () => {
  for (const bad of ["../x", "/etc", "~/x", "a/../../b"]) assert.throws(() => assertRelativeSearchPath(bad), /relative/);
  assert.doesNotThrow(() => assertRelativeSearchPath("src/pkg"));
  assert.doesNotThrow(() => assertRelativeSearchPath(undefined));
});

test("UTF-8 output cap stays within 12000 bytes", () => {
  const result = truncateUtf8("🧪".repeat(10_000));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 12_000);
  assert.match(result.text, /output truncated/);
});
