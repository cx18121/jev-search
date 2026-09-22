import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileFinder, type GrepCursor } from "@ff-labs/fff-node";
import { GrepPilot } from "../src/grep-pilot.ts";

test("real FFF soft pages remain reachable through pilot cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-search-native-"));
  let picker: ReturnType<typeof FileFinder.create> | undefined;
  try {
    for (const [name, count] of [["a.ts", 150], ["b.ts", 75], ["c.ts", 2]] as const) {
      await writeFile(join(root, name), Array.from({ length: count }, (_, i) => `  const needle${i} = ${i};`).join("\n"));
    }
    picker = FileFinder.create({ basePath: root, disableWatch: true });
    assert.ok(picker.ok, picker.ok ? "" : picker.error);
    const finder = picker.value;
    const ready = await finder.waitForScan(10_000);
    assert.ok(ready.ok && ready.value, "native indexing completed");
    const pilot = new GrepPilot();
    let scans = 0;
    const scan = async (cursor: GrepCursor | null) => {
      scans++;
      const page = finder.grep("needle", { mode: "plain", pageSize: 50, maxMatchesPerFile: 200, cursor, beforeContext: 0, afterContext: 0 });
      assert.ok(page.ok, page.ok ? "" : page.error);
      return { result: page.value };
    };
    const args = { signature: "needle", intent: "find all declarations", order: "native" as const, scan, limit: 20 };
    let page = await pilot.search(args);
    const identities = new Set<string>();
    let shown = 0;
    for (let i = 0; ; i++) {
      assert.ok(i < 30, "cursor chain terminates");
      shown += page.details.rerank.shown;
      for (const m of page.content[0]!.text.matchAll(/^([abc]\.ts:\d+)$/gm)) identities.add(m[1]!);
      if (!page.details.rerank.cursor) break;
      page = await pilot.search({ ...args, cursor: page.details.rerank.cursor });
    }
    assert.equal(shown, 227);
    assert.equal(identities.size, 227);
    assert.ok(scans >= 2);
  } finally {
    if (picker?.ok) picker.value.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
