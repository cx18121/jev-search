import { ARMS, type CodingTask, type PlanRow } from "./types.ts";

/**
 * Frozen six-order Williams-style rotation. Adjacent and first-position effects
 * are spread across the ten task/repeat blocks; every block still runs all arms.
 */
const ORDERS = [
  ["stock", "deterministic", "jev"],
  ["deterministic", "jev", "stock"],
  ["jev", "stock", "deterministic"],
  ["jev", "deterministic", "stock"],
  ["deterministic", "stock", "jev"],
  ["stock", "jev", "deterministic"],
] as const;

export function buildPlan(tasks: readonly CodingTask[]): PlanRow[] {
  if (tasks.length !== 5) throw new Error(`coding campaign requires exactly 5 tasks; got ${tasks.length}`);
  const rows: PlanRow[] = [];
  let index = 0;
  for (let repeat = 1 as 1 | 2; repeat <= 2; repeat = (repeat + 1) as 1 | 2) {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const block = (repeat - 1) * tasks.length + taskIndex;
      const order = ORDERS[block % ORDERS.length];
      for (let position = 0; position < order.length; position += 1) {
        rows.push({ index: ++index, taskId: tasks[taskIndex].id, repeat, position: (position + 1) as 1 | 2 | 3, arm: order[position] });
      }
    }
  }
  if (rows.length !== 30 || rows.some((row) => !ARMS.includes(row.arm))) throw new Error("internal campaign plan invariant failed");
  return rows;
}
