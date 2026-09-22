import { randomUUID } from "node:crypto";
import type { GrepCursor, GrepMatch, GrepResult } from "@ff-labs/fff-node";
import { INPUT_USD_PER_MILLION, rankCandidates, type Candidate, type Ordering, type RankMetrics } from "./rank.ts";

export const POOL_SIZE = 80;
export const OUTPUT_BYTES = 12_000;
const MAX_SCANS = 3;
const MAX_CURSORS = 200;

type Scan = (cursor: GrepCursor | null) => Promise<{ result: GrepResult; notice?: string }>;
interface State {
  signature: string;
  intent: string;
  order: Ordering;
  scan: Scan;
  remaining: Candidate[];
  pending: GrepMatch[];
  next: GrepCursor | null;
  started: boolean;
  poolSize: number;
  orderChanged: boolean;
  totalFiles: number;
  notice?: string;
  fallback?: string;
}

function boundedText(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const marker = "\n[snippet truncated]";
  let size = 0;
  const chars: string[] = [];
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > bytes - Buffer.byteLength(marker)) break;
    chars.push(char);
  }
  return chars.join("") + marker;
}

export function candidateFromMatch(match: GrepMatch, index: number): Candidate {
  const before = match.contextBefore ?? [];
  const lines = [
    ...before.map((line, i) => `${match.lineNumber - before.length + i}: ${line}`),
    `${match.lineNumber}: ${match.lineContent}`,
    ...(match.contextAfter ?? []).map((line, i) => `${match.lineNumber + i + 1}: ${line}`),
  ];
  return {
    id: `c${index}`, path: match.relativePath, line: match.lineNumber,
    text: boundedText(`${match.relativePath}:${match.lineNumber}\n${lines.join("\n")}`, 3_500),
    definition: match.isDefinition === true,
  };
}

export class GrepPilot {
  private cursors = new Map<string, State>();
  constructor(private rank: typeof rankCandidates = rankCandidates) {}
  clear() { this.cursors.clear(); }

  async search(input: {
    signature: string; intent?: string; order: Ordering; cursor?: string; limit?: number;
    signal?: AbortSignal; scan: Scan;
  }) {
    input.signal?.throwIfAborted();
    let state: State;
    if (input.cursor) {
      const saved = this.cursors.get(input.cursor);
      if (!saved) throw new Error("Search cursor is unknown, expired, or already consumed. Start a new search.");
      if (saved.signature !== input.signature || (input.intent !== undefined && input.intent !== saved.intent) || input.order !== saved.order) {
        throw new Error("Search cursor belongs to different search arguments. Keep pattern, path, exclude, context, case and intent unchanged.");
      }
      state = { ...saved, remaining: [...saved.remaining], pending: [...saved.pending] };
    } else {
      if (!input.intent?.trim()) throw new Error("A fresh search requires intent describing the code or evidence you need.");
      if (Buffer.byteLength(input.intent) > 2_000) throw new Error("Search intent must fit in 2000 UTF-8 bytes.");
      state = {
        signature: input.signature, intent: input.intent, order: input.order, scan: input.scan,
        remaining: [], pending: [], next: null, started: false, poolSize: 0, orderChanged: false, totalFiles: 0,
      };
    }
    let metrics: RankMetrics = { order: state.order, calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    let scanCalls = 0;
    let filesSearched = 0;
    if (!state.remaining.length) {
      while (state.pending.length < POOL_SIZE && (!state.started || state.next) && scanCalls < MAX_SCANS) {
        input.signal?.throwIfAborted();
        const { result, notice } = await state.scan(state.next);
        input.signal?.throwIfAborted();
        scanCalls++;
        filesSearched += result.totalFilesSearched;
        state.started = true;
        state.next = result.nextCursor ?? null;
        state.totalFiles = result.totalFiles;
        state.pending.push(...result.items);
        if (notice) state.notice = notice;
        if (result.regexFallbackError) state.notice = `Invalid regex. Used literal matching. ${notice ?? ""}`;
      }
      const candidates = state.pending.splice(0, POOL_SIZE).map(candidateFromMatch);
      const ranked = await this.rank(state.intent, candidates, { order: state.order, signal: input.signal });
      input.signal?.throwIfAborted();
      state.remaining = ranked.candidates;
      state.poolSize = candidates.length;
      state.orderChanged = ranked.candidates.some((candidate, index) => candidate.id !== candidates[index]?.id);
      state.fallback = ranked.metrics.fallback;
      metrics = ranked.metrics;
    }

    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(80, Math.floor(input.limit!))) : 20;
    const blocks: string[] = [];
    let bytes = 0;
    while (state.remaining.length && blocks.length < limit) {
      const text = state.remaining[0]!.text;
      // Reserve room for the bounded metadata footer.
      if (bytes + Buffer.byteLength(text) + 2 > OUTPUT_BYTES - 1_200) break;
      blocks.push(text);
      bytes += Buffer.byteLength(text) + 2;
      state.remaining.shift();
    }
    const hasUnranked = state.pending.length > 0 || state.next !== null;
    let cursor: string | undefined;
    if (state.remaining.length || hasUnranked) {
      cursor = `jev_c_${randomUUID()}`;
      this.cursors.set(cursor, state);
      if (this.cursors.size > MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value!);
    }
    if (input.cursor) this.cursors.delete(input.cursor);
    const notices = [
      `Order: ${state.fallback ? "native fallback" : state.order}. Collected pool: ${state.poolSize}. Shown: ${blocks.length}. Still in this pool: ${state.remaining.length}.`,
      "Order applies only to this collected pool, not all repository matches. Native limits: 200 matches/file; native lines may be truncated.",
      hasUnranked ? "Additional unranked matches or unsearched files remain." : "No further native pages remain (subject to native limits).",
    ];
    if (state.notice) notices.push(boundedText(state.notice, 250));
    if (state.fallback) notices.push(`Jev unavailable: ${state.fallback}. No candidates were removed.`);
    if (cursor) notices.push(`Continue with cursor="${cursor}" and the same search arguments. Intent may be omitted on continuation.`);
    const text = `${blocks.join("\n\n") || "No matches in this collected pool."}\n\n[${notices.join(" ")}]`;
    return {
      content: [{ type: "text" as const, text }],
      details: {
        totalMatched: blocks.length, totalFiles: state.totalFiles,
        rerank: { ...metrics, fallback: state.fallback, poolSize: state.poolSize, orderChanged: state.orderChanged, shown: blocks.length,
          remainingInPool: state.remaining.length, hasUnranked, scanCalls, filesSearched, cursor },
      },
      usage: {
        input: metrics.inputTokens, output: metrics.outputTokens, cacheRead: 0, cacheWrite: 0,
        totalTokens: metrics.inputTokens + metrics.outputTokens,
        cost: { input: metrics.inputTokens * INPUT_USD_PER_MILLION / 1e6, output: 0, cacheRead: 0, cacheWrite: 0,
          total: metrics.inputTokens * INPUT_USD_PER_MILLION / 1e6 },
      },
    };
  }
}
