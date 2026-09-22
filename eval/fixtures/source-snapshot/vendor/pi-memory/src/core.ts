import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMetadataLine, metadataLine } from "./format.js";
import { searchSources, type SearchResult } from "./search.js";

export const INDEX_MAX_BYTES = 25 * 1024;
const LOCK_WAIT_MS = 1_500;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
const TOPIC_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKBOX_REGEX = /^- \[([ xX])\] (.+)$/;
const PROJECT_ID_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,63})-[0-9a-f]{10}$/;
const PROJECT_ID_CONFIG_KEY = "pi.memory-id";

export type MemoryScope = "global" | "project";
export type AgentRole = "root" | "subagent";
export type MemoryTarget = "memory" | "topic";
export type ChecklistAction = "add" | "done" | "undo" | "clear_done" | "list";
export type PapercutAction = ChecklistAction | "edit" | "resolve";

export type MemoryEnvironment = NodeJS.ProcessEnv;

export interface ProjectIdentity {
  commonRoot: string;
  name: string;
  hash: string;
  id: string;
}

export interface MemoryLocations {
  baseDir: string;
  globalDir: string;
  project: ProjectIdentity | null;
  projectDir: string | null;
}

interface RecoveryRecord {
  version: 1;
  id: string;
  createdAt: string;
  target: MemoryTarget;
  topic?: string;
  removedContent: string[];
  restoredAt?: string;
}

export type { SearchResult } from "./search.js";

export interface ChecklistItem {
  done: boolean;
  text: string;
}

function sleepSync(milliseconds: number) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function realpathIfPossible(filePath: string) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function resolveMemoryDir(env: MemoryEnvironment = process.env) {
  if (env.PI_MEMORY_DIR?.trim()) return path.resolve(env.PI_MEMORY_DIR);
  const home = env.HOME
    ?? env.USERPROFILE
    ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined);
  if (!home) throw new Error("Cannot resolve memory directory because no home directory is configured.");
  return path.join(home, ".pi", "agent", "memory");
}

export function resolveAgentRole(
  env: MemoryEnvironment = process.env,
  currentSessionId?: string,
): AgentRole {
  const forced = env.PI_MEMORY_SUBAGENT_MODE?.trim().toLowerCase();
  if (forced === "root" || forced === "subagent") return forced;
  if (env.PI_SUBAGENT_CHILD?.trim() === "1") return "subagent";
  const parent = env.PI_SUBAGENT_PARENT_SESSION?.trim();
  const session = currentSessionId?.trim() ?? env.PI_SESSION_ID?.trim();
  return parent && parent !== session ? "subagent" : "root";
}

export function autoCaptureEnabled(env: MemoryEnvironment = process.env) {
  const value = env.PI_MEMORY_AUTO_CAPTURE?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value ?? "");
}

export function sanitizeProjectName(name: string) {
  const sanitized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized || "project";
}

function gitCommonDir(cwd: string) {
  try {
    const commonGitDir = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return commonGitDir ? realpathIfPossible(commonGitDir) : null;
  } catch {
    return null;
  }
}

class InvalidProjectIdentityError extends Error {}
class ProjectIdentityInitializationTimeoutError extends Error {}
class ProjectIdentityUnavailableError extends Error {}

function readConfiguredProjectId(cwd: string) {
  try {
    const values = execFileSync(
      "git",
      ["-C", cwd, "config", "--local", "--get-all", PROJECT_ID_CONFIG_KEY],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim().split("\n").filter(Boolean);
    if (values.length !== 1 || !PROJECT_ID_REGEX.test(values[0])) {
      throw new InvalidProjectIdentityError(
        `Git config ${PROJECT_ID_CONFIG_KEY} must contain one valid project ID.`,
      );
    }
    return values[0];
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}

function withRepositoryIdentityLock<T>(commonGitDir: string, operation: () => T) {
  const lockDir = path.join(commonGitDir, "pi-memory-id.lock");
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryAcquireLock(lockDir, owner)) {
    const staleToken = staleLockToken(lockDir);
    if (staleToken !== undefined) removeLockIfTokenMatches(lockDir, staleToken);
    if (Date.now() >= deadline) {
      throw new ProjectIdentityInitializationTimeoutError(
        `Timed out initializing project memory identity: ${commonGitDir}`,
      );
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return operation();
  } finally {
    removeLockIfTokenMatches(lockDir, owner.token);
  }
}

function configuredProjectId(cwd: string, commonGitDir: string, name: string) {
  const configured = readConfiguredProjectId(cwd);
  if (configured) return configured;
  try {
    return withRepositoryIdentityLock(commonGitDir, () => {
      const initialized = readConfiguredProjectId(cwd);
      if (initialized) return initialized;
      const id = `${name}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      execFileSync(
        "git",
        ["-C", cwd, "config", "--local", "--replace-all", PROJECT_ID_CONFIG_KEY, id],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      return id;
    });
  } catch (error) {
    if (
      error instanceof InvalidProjectIdentityError
      || error instanceof ProjectIdentityInitializationTimeoutError
    ) {
      throw error;
    }
    throw new ProjectIdentityUnavailableError("Git metadata is not writable.", { cause: error });
  }
}

export function legacyProjectId(commonRoot: string) {
  const canonicalRoot = realpathIfPossible(commonRoot);
  const name = sanitizeProjectName(path.basename(canonicalRoot));
  const hash = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 10);
  return `${name}-${hash}`;
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity | null {
  const commonGitDir = gitCommonDir(cwd);
  if (!commonGitDir) return null;
  const commonRoot = commonGitDir.endsWith(`${path.sep}.git`)
    ? path.dirname(commonGitDir)
    : commonGitDir;
  const canonicalRoot = realpathIfPossible(commonRoot);
  const currentName = sanitizeProjectName(path.basename(canonicalRoot));
  let id: string;
  try {
    id = configuredProjectId(cwd, commonGitDir, currentName);
  } catch (error) {
    if (!(error instanceof ProjectIdentityUnavailableError)) throw error;
    id = legacyProjectId(canonicalRoot);
  }
  const hash = id.slice(-10);
  const name = id.slice(0, -11);
  return { commonRoot: canonicalRoot, name, hash, id };
}

function migrateLegacyProjectDir(baseDir: string, project: ProjectIdentity) {
  const projectDir = path.join(baseDir, "projects", project.id);
  const legacyDir = path.join(baseDir, "projects", legacyProjectId(project.commonRoot));
  if (legacyDir === projectDir || !fs.existsSync(legacyDir)) return projectDir;
  if (fs.existsSync(projectDir)) {
    throw new Error(
      `Both stable and legacy project memory exist; refusing to hide or merge data: ${projectDir}, ${legacyDir}`,
    );
  }
  ensurePrivateDir(path.dirname(projectDir));
  try {
    fs.renameSync(legacyDir, projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return projectDir;
}

export function resolveLocations(
  cwd: string,
  env: MemoryEnvironment = process.env,
): MemoryLocations {
  const baseDir = resolveMemoryDir(env);
  const project = resolveProjectIdentity(cwd);
  return {
    baseDir,
    globalDir: path.join(baseDir, "global"),
    project,
    projectDir: project ? migrateLegacyProjectDir(baseDir, project) : null,
  };
}

export function resolveScope(
  locations: MemoryLocations,
  requested?: MemoryScope,
): { scope: MemoryScope; dir: string } {
  const scope = requested ?? (locations.projectDir ? "project" : "global");
  if (scope === "project" && !locations.projectDir) {
    throw new Error("Project memory is unavailable outside a Git repository.");
  }
  return { scope, dir: scope === "project" ? locations.projectDir! : locations.globalDir };
}

export function safeTopicSlug(topic: string) {
  const normalized = topic.trim().toLowerCase();
  if (!TOPIC_REGEX.test(normalized) || normalized !== topic.trim()) {
    throw new Error("Topic must be a lowercase slug using only letters, numbers, and single hyphens.");
  }
  return normalized;
}

export function ensurePrivateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (
      !Number.isInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.token !== "string" ||
      !owner.token
    ) {
      return null;
    }
    return owner as LockOwner;
  } catch {
    return null;
  }
}

function staleLockToken(lockDir: string): string | null | undefined {
  const owner = readLockOwner(lockDir);
  if (owner) return isPidAlive(owner.pid) ? undefined : owner.token;
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS ? null : undefined;
  } catch {
    return undefined;
  }
}

function removeLockIfTokenMatches(lockDir: string, expectedToken: string | null) {
  const currentToken = readLockOwner(lockDir)?.token ?? null;
  if (currentToken !== expectedToken) return false;
  const quarantineDir = `${lockDir}.remove-${randomUUID()}`;
  try {
    fs.renameSync(lockDir, quarantineDir);
  } catch {
    return false;
  }
  fs.rmSync(quarantineDir, { recursive: true, force: true });
  return true;
}

function tryAcquireLock(lockDir: string, owner: LockOwner) {
  const candidateDir = `${lockDir}.candidate-${owner.token}`;
  fs.mkdirSync(candidateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(candidateDir, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(candidateDir, lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    return false;
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
}

function gateParticipants(queueDir: string, ownTicket: string) {
  const participants: string[] = [];
  for (const name of fs.readdirSync(queueDir)) {
    if (name === ownTicket) continue;
    const pid = Number(name.split("-", 1)[0]);
    const participant = path.join(queueDir, name);
    if (Number.isInteger(pid) && pid > 0) {
      if (isPidAlive(pid)) participants.push(name);
      else fs.rmSync(participant, { recursive: true, force: true });
      continue;
    }
    try {
      if (Date.now() - fs.statSync(participant).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(participant, { recursive: true, force: true });
      } else {
        participants.push(name);
      }
    } catch {
      // The participant was removed concurrently.
    }
  }
  return participants;
}

function gateNumber(queueDir: string, ticket: string) {
  try {
    const number = Number(fs.readFileSync(path.join(queueDir, ticket, "number"), "utf8"));
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function withLockGate<T>(lockDir: string, deadline: number, retryMs: number, operation: () => T) {
  const queueDir = `${lockDir}.queue`;
  ensurePrivateDir(queueDir);
  const ticket = `${process.pid}-${randomUUID()}`;
  const ticketDir = path.join(queueDir, ticket);
  fs.mkdirSync(ticketDir, { mode: 0o700 });

  try {
    const previousNumbers = gateParticipants(queueDir, ticket)
      .map((name) => gateNumber(queueDir, name))
      .filter((number): number is number => number !== null);
    const number = Math.max(0, ...previousNumbers) + 1;
    fs.writeFileSync(path.join(ticketDir, "number"), `${number}\n`, { flag: "wx", mode: 0o600 });

    while (true) {
      const waiting = gateParticipants(queueDir, ticket).some((name) => {
        const otherNumber = gateNumber(queueDir, name);
        return otherNumber === null
          || otherNumber < number
          || (otherNumber === number && name.localeCompare(ticket) < 0);
      });
      if (!waiting) return operation();
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for memory lock gate: ${lockDir}`);
      sleepSync(retryMs);
    }
  } finally {
    fs.rmSync(ticketDir, { recursive: true, force: true });
  }
}

export function withFileLock<T>(
  filePath: string,
  operation: () => T,
  options: { waitMs?: number; retryMs?: number } = {},
): T {
  ensurePrivateDir(path.dirname(filePath));
  const lockDir = `${filePath}.lock`;
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  while (true) {
    const acquired = withLockGate(lockDir, deadline, retryMs, () => {
      if (tryAcquireLock(lockDir, owner)) return true;
      const staleToken = staleLockToken(lockDir);
      if (staleToken !== undefined) removeLockIfTokenMatches(lockDir, staleToken);
      return false;
    });
    if (acquired) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for memory lock: ${filePath}`);
    sleepSync(retryMs);
  }

  try {
    return operation();
  } finally {
    withLockGate(lockDir, Date.now() + waitMs, retryMs, () => removeLockIfTokenMatches(lockDir, owner.token));
  }
}

export function atomicWriteFile(filePath: string, content: string) {
  ensurePrivateDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function mutateText(
  filePath: string,
  mutate: (existing: string) => string,
  lockOptions?: { waitMs?: number; retryMs?: number },
) {
  return withFileLock(
    filePath,
    () => {
      const next = mutate(readText(filePath));
      atomicWriteFile(filePath, next);
      return next;
    },
    lockOptions,
  );
}

export function memoryFilePath(dir: string, target: MemoryTarget, topic?: string) {
  if (target === "memory") return path.join(dir, "MEMORY.md");
  if (!topic) throw new Error("A topic slug is required for topic memory.");
  return path.join(dir, "topics", `${safeTopicSlug(topic)}.md`);
}

export function checklistFilePath(dir: string, kind: "scratchpad" | "papercuts") {
  return path.join(dir, kind === "scratchpad" ? "SCRATCHPAD.md" : "PAPERCUTS.md");
}

export function normalizeForDuplicate(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function logicalBlockBody(block: LogicalMemoryBlock) {
  return block.stamped ? block.content.split("\n").slice(1).join("\n").trim() : block.content;
}

function memoryEntryBodies(content: string) {
  return logicalMemoryBlocks(content).map(logicalBlockBody);
}

export function writeMemory(options: {
  dir: string;
  target?: MemoryTarget;
  topic?: string;
  content: string;
  sessionId?: string;
}) {
  const target = options.target ?? "memory";
  const filePath = memoryFilePath(options.dir, target, options.topic);
  const wanted = normalizeForDuplicate(options.content);
  if (!wanted) throw new Error("Memory content must not be empty.");
  if (options.content.replace(/\r\n?/g, "\n").split("\n").some(isMetadataLine)) {
    throw new Error("Memory content contains a reserved pi-memory metadata line.");
  }
  mutateText(filePath, (existing) => {
    if (memoryEntryBodies(existing).some((body) => normalizeForDuplicate(body) === wanted)) {
      throw new Error("An exact normalized duplicate is already stored.");
    }
    const stamped = `${metadataLine(options.sessionId)}\n${options.content.trim()}\n`;
    const next = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${stamped}`;
    if (target === "memory" && Buffer.byteLength(next, "utf8") > INDEX_MAX_BYTES) {
      throw new Error("MEMORY.md would exceed 25KB. Curate the index or move detail into a topic file.");
    }
    return next;
  });
  return filePath;
}

export function parseChecklist(content: string): ChecklistItem[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(CHECKBOX_REGEX))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ done: match[1].toLowerCase() === "x", text: match[2] }));
}

function appendChecklistItem(content: string, text: string, sessionId: string | undefined, filePath: string) {
  const defaultHeading = path.basename(filePath) === "PAPERCUTS.md" ? "# Papercuts" : "# Scratchpad";
  const heading = content.trim() ? content.trimEnd() : defaultHeading;
  return `${heading}\n${metadataLine(sessionId)}\n- [ ] ${text.trim()}\n`;
}

function matchingChecklistIndex(
  lines: string[],
  needle: string,
  eligible: (match: RegExpMatchArray) => boolean,
  label: string,
) {
  const wanted = normalizeForDuplicate(needle);
  const candidates = lines.flatMap((line, index) => {
    const match = line.match(CHECKBOX_REGEX);
    return match && eligible(match) ? [{ index, text: normalizeForDuplicate(match[2]) }] : [];
  });
  const exact = candidates.filter((candidate) => candidate.text === wanted);
  const matches = exact.length > 0 ? exact : candidates.filter((candidate) => candidate.text.includes(wanted));
  const description = label ? `${label} ` : "";
  if (matches.length === 0) throw new Error(`No matching ${description}item found.`);
  if (matches.length > 1) throw new Error(`Multiple matching ${description}items found. Use the exact unique item text.`);
  return matches[0].index;
}

function toggleChecklist(content: string, needle: string, done: boolean) {
  const lines = content.split("\n");
  const label = done ? "open" : "done";
  const index = matchingChecklistIndex(
    lines,
    needle,
    (match) => (match[1].toLowerCase() === "x") !== done,
    label,
  );
  const match = lines[index].match(CHECKBOX_REGEX)!;
  lines[index] = `- [${done ? "x" : " "}] ${match[2]}`;
  return lines.join("\n");
}

function clearDoneChecklist(content: string) {
  const lines = content.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const match = line.match(CHECKBOX_REGEX);
    if (match?.[1].toLowerCase() === "x") {
      if (isMetadataLine(output.at(-1) ?? "")) output.pop();
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

function editChecklist(content: string, needle: string, replacement: string) {
  const lines = content.split("\n");
  const index = matchingChecklistIndex(lines, needle, () => true, "");
  const match = lines[index].match(CHECKBOX_REGEX)!;
  lines[index] = `- [${match[1].toLowerCase() === "x" ? "x" : " "}] ${replacement.trim()}`;
  return lines.join("\n");
}

export function mutateChecklist(options: {
  filePath: string;
  action: PapercutAction;
  text?: string;
  replacement?: string;
  sessionId?: string;
}) {
  if (options.action === "list") return readText(options.filePath);
  if (options.action === "add") {
    if (!options.text?.trim()) throw new Error("Text is required for add.");
    return mutateText(options.filePath, (existing) =>
      appendChecklistItem(existing, options.text!, options.sessionId, options.filePath),
    );
  }
  if (options.action === "clear_done") {
    return mutateText(options.filePath, clearDoneChecklist);
  }
  if (!options.text?.trim()) throw new Error(`Text is required for ${options.action}.`);
  if (options.action === "edit") {
    if (!options.replacement?.trim()) throw new Error("Replacement is required for edit.");
    return mutateText(options.filePath, (existing) => editChecklist(existing, options.text!, options.replacement!));
  }
  return mutateText(options.filePath, (existing) =>
    toggleChecklist(existing, options.text!, options.action === "done" || options.action === "resolve"),
  );
}

export function assertScratchpadPermission(role: AgentRole, action: ChecklistAction) {
  if (role === "subagent" && action !== "list") {
    throw new Error("Subagents may read scratchpads but cannot mutate them.");
  }
}

export function assertPapercutPermission(role: AgentRole, action: PapercutAction) {
  if (role === "subagent" && !["add", "list"].includes(action)) {
    throw new Error("Subagents may append and list papercuts but cannot edit or resolve them.");
  }
}

export function assertMemoryMutationPermission(role: AgentRole) {
  if (role === "subagent") throw new Error("Subagents cannot mutate durable memory.");
}

interface LogicalMemoryBlock {
  content: string;
  stamped: boolean;
}

function logicalBlockKey(content: string) {
  return content.replace(/\r\n?/g, "\n").trim();
}

function logicalMemoryBlocks(content: string): LogicalMemoryBlock[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const blocks: LogicalMemoryBlock[] = [];
  let current: string[] = [];
  let stamped = false;
  const flush = () => {
    const block = current.join("\n").trim();
    if (!block) return;
    if (stamped) {
      blocks.push({ content: block, stamped: true });
    } else {
      blocks.push(
        ...block
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
          .map((paragraph) => ({ content: paragraph, stamped: false })),
      );
    }
  };
  for (const line of normalized.split("\n")) {
    if (isMetadataLine(line)) {
      flush();
      current = [line];
      stamped = true;
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function serializeLogicalMemoryBlocks(blocks: LogicalMemoryBlock[]) {
  const unstamped = blocks.filter((block) => !block.stamped);
  const stamped = blocks.filter((block) => block.stamped);
  const ordered = [...unstamped, ...stamped];
  return ordered.length ? `${ordered.map((block) => block.content).join("\n\n")}\n` : "";
}

function recoveredLogicalBlock(content: string): LogicalMemoryBlock {
  const normalized = logicalBlockKey(content);
  return { content: normalized, stamped: isMetadataLine(normalized.split("\n", 1)[0]) };
}

function recoveryPath(scopeDir: string, id: string) {
  if (!RECOVERY_ID_REGEX.test(id)) throw new Error("Invalid recovery ID.");
  return path.join(scopeDir, "recovery", `${id}.json`);
}

export function forgetMemory(options: {
  dir: string;
  target?: MemoryTarget;
  topic?: string;
  match: string;
}) {
  const needle = options.match.trim().toLocaleLowerCase();
  if (!needle) throw new Error("Match must not be empty.");
  const target = options.target ?? "memory";
  const sourcePath = memoryFilePath(options.dir, target, options.topic);
  return withFileLock(sourcePath, () => {
    const existing = readText(sourcePath);
    const blocks = logicalMemoryBlocks(existing);
    const matches = (block: LogicalMemoryBlock) => logicalBlockBody(block).toLocaleLowerCase().includes(needle);
    const removed = blocks.filter(matches);
    if (!removed.length) throw new Error("No matching memory entries found.");
    const kept = blocks.filter((block) => !matches(block));
    const record: RecoveryRecord = {
      version: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      target,
      ...(options.topic ? { topic: safeTopicSlug(options.topic) } : {}),
      removedContent: removed.map((block) => block.content),
    };
    const recordPath = recoveryPath(options.dir, record.id);
    atomicWriteFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    atomicWriteFile(sourcePath, serializeLogicalMemoryBlocks(kept));
    return { recoveryId: record.id, removed: removed.length, path: sourcePath };
  });
}

function parseRecovery(scopeDir: string, id: string) {
  const filePath = recoveryPath(scopeDir, id);
  const record = JSON.parse(readText(filePath)) as RecoveryRecord;
  if (
    record.version !== 1 ||
    record.id !== id ||
    !Array.isArray(record.removedContent) ||
    !record.removedContent.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Invalid recovery record.");
  }
  return { record, filePath };
}

export function restoreMemory(scopeDir: string, recoveryId: string) {
  const { record, filePath: recordPath } = parseRecovery(scopeDir, recoveryId);
  if (record.restoredAt) return { restored: 0, alreadyRestored: true };
  const targetPath = memoryFilePath(scopeDir, record.target, record.topic);
  const restored = withFileLock(targetPath, () => {
    const existing = readText(targetPath);
    const existingBlocks = logicalMemoryBlocks(existing);
    const existingBodies = new Set(existingBlocks.map((block) => normalizeForDuplicate(logicalBlockBody(block))));
    const missing = record.removedContent
      .map(recoveredLogicalBlock)
      .filter((entry) => !existingBodies.has(normalizeForDuplicate(logicalBlockBody(entry))));
    const next = missing.length
      ? serializeLogicalMemoryBlocks([...existingBlocks, ...missing])
      : existing;
    if (record.target === "memory" && Buffer.byteLength(next, "utf8") > INDEX_MAX_BYTES) {
      throw new Error("Restoring would make MEMORY.md exceed 25KB. Curate the index before restoring.");
    }
    if (missing.length) atomicWriteFile(targetPath, next);
    record.restoredAt = new Date().toISOString();
    atomicWriteFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return missing.length;
  });
  return { restored, alreadyRestored: false, path: targetPath };
}

export function findRecoveryScope(locations: MemoryLocations, recoveryId: string) {
  const scopes: Array<{ scope: MemoryScope; dir: string }> = [
    { scope: "global", dir: locations.globalDir },
    ...(locations.projectDir ? [{ scope: "project" as const, dir: locations.projectDir }] : []),
  ];
  for (const candidate of scopes) {
    try {
      if (fs.statSync(recoveryPath(candidate.dir, recoveryId)).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Recovery record was not found in global or active project memory.");
}

function readDirectoryIfPresent(dir: string) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function scopeMarkdownFiles(scopeDir: string) {
  const files = ["MEMORY.md", "SCRATCHPAD.md", "PAPERCUTS.md"].map((name) => path.join(scopeDir, name));
  files.push(...listTopics(scopeDir).map((topic) => path.join(scopeDir, "topics", `${topic}.md`)));
  return files;
}

function searchableMarkdownFiles(scopeDir: string) {
  return scopeMarkdownFiles(scopeDir).filter((filePath) => path.basename(filePath) !== "PAPERCUTS.md");
}

export function searchMemory(locations: MemoryLocations, query: string, limit = 5): SearchResult[] {
  const dirs = [locations.globalDir, ...(locations.projectDir ? [locations.projectDir] : [])];
  const sources = dirs.flatMap((dir) =>
    searchableMarkdownFiles(dir).map((filePath) => ({ path: filePath, content: readText(filePath) })),
  );
  return searchSources(sources, query, limit);
}

function indexContext(label: string, filePath: string) {
  const content = readText(filePath);
  if (!content.trim()) return "";
  const size = Buffer.byteLength(content, "utf8");
  if (size > INDEX_MAX_BYTES) {
    return `## ${label}\n\n[Omitted: ${filePath} is ${size} bytes, above the 25KB index limit. Curate it before loading.]`;
  }
  return `## ${label}\n\n${content.trim()}`;
}

export function scratchpadNowSection(content: string) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^## Now[ \t]*$/.test(line));
  if (start < 0) return "";
  const nextHeading = lines.findIndex((line, index) => index > start && /^##[ \t]+/.test(line));
  const end = nextHeading >= 0 ? nextHeading : lines.length;
  const now = lines.slice(start + 1, end).join("\n").trim();
  return /^none\.?$/i.test(now) ? "" : now;
}

export function buildStartupContext(options: {
  locations: MemoryLocations;
  role: AgentRole;
  autoCapture?: boolean;
}) {
  const sections = [indexContext("Global MEMORY.md", path.join(options.locations.globalDir, "MEMORY.md"))];
  if (options.locations.projectDir) {
    sections.push(indexContext("Project MEMORY.md", path.join(options.locations.projectDir, "MEMORY.md")));
    const scratchpad = readText(path.join(options.locations.projectDir, "SCRATCHPAD.md"));
    const now = scratchpadNowSection(scratchpad);
    const nowItems = new Set(parseChecklist(now).map((item) => item.text));
    const open = parseChecklist(scratchpad).filter((item) => !item.done && !nowItems.has(item.text));
    const active = [now, open.map((item) => `- [ ] ${item.text}`).join("\n")].filter(Boolean).join("\n\n");
    if (active) sections.push(`## Active project scratchpad\n\n${active}`);
  }
  const capture =
    options.autoCapture !== false && options.role === "root"
      ? [
          "Use visible memory_write tool calls during work to save only stable preferences, corrections, recurring failures with confirmed fixes, and useful facts not quickly derivable from current code or documentation.",
          "Do not run a separate transcript review or make an invisible capture call.",
        ]
      : [];
  const body = sections.filter(Boolean);
  return [
    "# Local memory",
    "Current code, documentation, explicit instructions, and the latest user correction override memory. Replace or remove stale memory rather than preserving conflicts.",
    "Use a visible papercut add call when a tool, prompt, skill, helper, or repository change could plausibly prevent observed workflow friction, even on a first occurrence. State the activity, friction, and plausible structural improvement. Skip incidental mistakes and never include secrets.",
    ...capture,
    "During an explicit approval-gated review, propose durable memory and papercut writes and wait for the user's selection instead of writing them immediately.",
    ...body,
  ].join("\n\n");
}

export function listTopics(dir: string) {
  return readDirectoryIfPresent(path.join(dir, "topics"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

export function scopeInventory(dir: string) {
  const files = scopeMarkdownFiles(dir).filter((filePath) => fs.existsSync(filePath));
  return {
    dir,
    files: files.length,
    bytes: files.reduce((total, filePath) => total + fs.statSync(filePath).size, 0),
    topics: listTopics(dir).length,
    scratchpadOpen: parseChecklist(readText(path.join(dir, "SCRATCHPAD.md"))).filter((item) => !item.done).length,
    papercutsOpen: parseChecklist(readText(path.join(dir, "PAPERCUTS.md"))).filter((item) => !item.done).length,
  };
}
