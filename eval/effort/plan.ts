import { ARMS, type Arm, type FrozenPool, type PlanRow } from "./types.ts";

/** All six arm permutations, rotated once across each query/repeat block. */
export const PERMUTATIONS: readonly (readonly Arm[])[] = [
  ["native", "deterministic", "jev"],
  ["native", "jev", "deterministic"],
  ["deterministic", "native", "jev"],
  ["deterministic", "jev", "native"],
  ["jev", "native", "deterministic"],
  ["jev", "deterministic", "native"],
] as const;

export function buildPlan(pools: readonly Pick<FrozenPool, "query">[]): PlanRow[] {
  if (pools.length !== 10) throw new Error(`effort dataset must contain exactly 10 pools; got ${pools.length}`);
  if (new Set(pools.map((pool) => pool.query.id)).size !== pools.length) throw new Error("effort query ids must be unique");
  const rows: PlanRow[] = [];
  let block = 0;
  for (const pool of pools) {
    for (const repeat of [1, 2] as const) {
      const permutation = PERMUTATIONS[block % PERMUTATIONS.length]!;
      for (let position = 0; position < ARMS.length; position += 1) {
        rows.push({ index: rows.length + 1, block: block + 1, queryId: pool.query.id, repeat, position: (position + 1) as 1 | 2 | 3, arm: permutation[position]! });
      }
      block += 1;
    }
  }
  return rows;
}

export function validatePlan(rows: readonly PlanRow[]): void {
  if (rows.length !== 60) throw new Error(`effort plan must contain 60 runs; got ${rows.length}`);
  for (let offset = 0; offset < rows.length; offset += 3) {
    const triple = rows.slice(offset, offset + 3);
    if (triple.length !== 3 || new Set(triple.map((row) => row.arm)).size !== 3 ||
        new Set(triple.map((row) => `${row.queryId}:${row.repeat}:${row.block}`)).size !== 1) {
      throw new Error(`invalid paired triple at rows ${offset + 1}-${offset + 3}`);
    }
  }
}
