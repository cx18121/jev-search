import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function normalizeArgument(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function assertRelativeSearchPath(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) throw new Error("search path must be a non-empty relative path");
  const path = normalizeArgument(value).replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("~") || path.split("/").some((part) => part === "..")) {
    throw new Error("search paths are confined to the workspace and must be relative");
  }
}

export class WorkspaceGuard {
  readonly root: string;
  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<WorkspaceGuard> {
    return new WorkspaceGuard(await realpath(root));
  }

  private lexical(input: string, operationAbsolute = false): string {
    const value = normalizeArgument(input);
    if (!value || value.startsWith("~") || (isAbsolute(value) && !operationAbsolute)) throw new Error("path must be workspace-relative");
    const target = isAbsolute(value) ? resolve(value) : resolve(this.root, value);
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes workspace");
    return target;
  }

  private async checkAncestors(target: string, includeTarget: boolean): Promise<void> {
    const rel = relative(this.root, target);
    const parts = rel === "" ? [] : rel.split(sep);
    const count = includeTarget ? parts.length : Math.max(0, parts.length - 1);
    let cursor = this.root;
    for (let index = 0; index < count; index += 1) {
      cursor = resolve(cursor, parts[index]);
      let stat;
      try {
        stat = await lstat(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`symlink paths are denied: ${relative(this.root, cursor)}`);
      const actual = await realpath(cursor);
      const escaped = relative(this.root, actual);
      if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error("resolved path escapes workspace");
    }
  }

  async existing(input: string, operationAbsolute = false): Promise<string> {
    const target = this.lexical(input, operationAbsolute);
    await this.checkAncestors(target, true);
    const actual = await realpath(target);
    const rel = relative(this.root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("resolved path escapes workspace");
    return actual;
  }

  async writable(input: string, operationAbsolute = false): Promise<string> {
    const target = this.lexical(input, operationAbsolute);
    await this.checkAncestors(target, true);
    await this.checkAncestors(dirname(target), true);
    return target;
  }

  async read(input: string, operationAbsolute = false): Promise<Buffer> {
    return readFile(await this.existing(input, operationAbsolute));
  }

  async write(input: string, content: string, operationAbsolute = false): Promise<void> {
    const target = await this.writable(input, operationAbsolute);
    await this.checkAncestors(target, true);
    await writeFile(target, content, "utf8");
  }

  async makeDirectory(input: string, operationAbsolute = false): Promise<void> {
    const target = await this.writable(input, operationAbsolute);
    await mkdir(target, { recursive: true });
    await this.checkAncestors(target, true);
  }
}

export function truncateUtf8(value: string, maxBytes = 12_000): { text: string; truncated: boolean; originalBytes: number } {
  const original = Buffer.from(value, "utf8");
  if (original.length <= maxBytes) return { text: value, truncated: false, originalBytes: original.length };
  let end = maxBytes;
  while (end > 0 && (original[end] & 0xc0) === 0x80) end -= 1;
  const marker = `\n[output truncated by coding harness at ${maxBytes} UTF-8 bytes; original ${original.length} bytes]`;
  const markerBytes = Buffer.byteLength(marker);
  const contentBytes = Math.max(0, end - markerBytes);
  let safeEnd = contentBytes;
  while (safeEnd > 0 && (original[safeEnd] & 0xc0) === 0x80) safeEnd -= 1;
  return { text: original.subarray(0, safeEnd).toString("utf8") + marker, truncated: true, originalBytes: original.length };
}
