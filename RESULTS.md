# Initial pilot result

The implementation works, but this sample does not establish a reason to enable Jev in daily search. Keep the existing setup unchanged.

## Observations

Nine navigation runs used `openai-codex/gpt-6-astra` with high thinking. Each of three tasks ran once with native, deterministic and Jev ordering against the same frozen 37-file TypeScript snapshot. Agents chose their own searches.

| Ordering | Navigation rubric | Total task time | Estimated combined cost |
| --- | --- | --- | --- |
| Native order, enhanced tool | 24/24 | 133.3 seconds | $0.530 |
| Deterministic order | 24/24 | 141.0 seconds | $0.500 |
| Jev order | 24/24 | 130.3 seconds | $0.573 |

These times and costs are descriptive single observations, not evidence that one arm is faster or cheaper. Main-model costs are estimates from the configured rate table, not verified charges.

Jev changed candidate order in all three task runs, with no fallback. Its 24 API requests reported 47,545 input tokens and 2,856 output tokens. At the published input rate, reranking itself cost about $0.002 and took 6.51 seconds across the three runs. Main-model usage dominated total estimated cost. Jev did not improve the measured navigation scores.

## Grading correction

The original checker gave native and Jev 8/9 on the memory-search task. Both answers accurately described the source's boundary rule, but the regex accepted `boundary` and rejected `boundaries`. The corrected checker accepts both forms. A regression test covers this change.

Only saved answers were regraded. No models were rerun. Original transcripts, scores and summaries remain unchanged. `adjudication.json` records both the original and corrected scores.

The rubric checks paths and expected wording. It is not a semantic proof of every assertion. The two rejected boundary explanations were checked directly against the frozen source.

## What passed

- Stable score ordering without dropping low-scored matches.
- Explicit fallback, cancellation, usage accounting and output bounds.
- Cursor continuation across pools and native soft-limit overflow.
- Real FFF integration retrieving all 227 fixture matches without loss or duplication.
- Real Pi extension lifecycle and direct `fffind`/`ffgrep` calls.
- Pinned Jev API contract, including a small batched versus individual scoring smoke.
- Independent core correctness review and TypeScript checks.

## Limits and next decision

This is a small navigation probe, not a coding-task benchmark. All arms reached the rubric ceiling. Tasks ran once in a fixed arm order, with different agent-selected queries and no statistical replication. The native arm used the same enhanced pool and output format, not pristine stock FFF.

Do not infer a general advantage for Jev or the deterministic order from these results. If the experiment continues, the useful next gate is repeated, harder tasks on larger repositories where choosing the wrong search result can actually prevent completion. That follow-up has now completed. The [30-run coding results](eval/coding/RESULTS.md) also found no fix-quality advantage and no repeatable efficiency gain over stock FFF.

## Evidence

- Run artifacts are under `results/2026-09-21T23-19-12-006Z-69916-bec03486/`.
- `summary.json` contains the original machine grades.
- `adjudication.json` contains the corrected grades and aggregated measurements.
- Each `run-*/` contains its transcript and outcome.
- `results/api-smoke.json` contains the separate synthetic API-contract check.

The whole nine-run sample had an estimated combined cost of $1.602, excluding the separate API smoke, which cost less than $0.001. Result artifacts are ignored by Git. This project is local only, with no commit, publication or daily Pi activation.
