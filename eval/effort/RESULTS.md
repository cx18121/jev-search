# Agent search-effort result

Jev reduced follow-up tool calls modestly on this sample, with no loss of answer quality. It did not make the agent faster than native ordering and did not meet the predeclared threshold against both alternatives. Keep the prototype and daily search unchanged.

This narrows the conclusion rather than reversing the retrieval result. Jev brought useful evidence forward. The agent could often answer from the full first page regardless of ordering.

## Same questions, correct answers

All ten frozen code questions ran under native, deterministic and Jev ordering, twice each. Every run used the same model, source snapshot, mandatory first query, tool interface and budgets. After that first search, the agent chose its own searches and reads.

A fresh judge graded all 60 final answers without arm, repetition, timing or tool counts. All 60 were factually complete and supported by source citations under the frozen rubric. The parent accepted the grades after checking the flagged cases. Two answers had minor line-number imprecisions on supporting context, recorded in the adjudication. A correct implementation span counted even when the answer omitted the private function name.

The eight exploratory questions are the main comparison. The two exact-symbol controls all succeeded without follow-up calls and are excluded from the table below.

## Effort and cost

Totals across eight exploratory questions and two repetitions per arm.

| Measure | Native | Deterministic | Jev |
| --- | ---: | ---: | ---: |
| Grounded-complete answers | 16/16 | 16/16 | 16/16 |
| Follow-up tool calls | 35 | 40 | 31 |
| All tool calls, including the fixed first search | 51 | 56 | 47 |
| Searches, including the fixed first search | 32 | 29 | 28 |
| File reads | 19 | 27 | 19 |
| Assistant turns | 63 | 69 | 63 |
| Tool output bytes delivered | 213,213 | 215,975 | 193,976 |
| Total elapsed seconds | 297.74 | 316.29 | 299.86 |
| Estimated model plus ranking cost | $1.474 | $1.585 | $1.429 |

Jev used **11.4 percent fewer follow-up calls than native** and **22.5 percent fewer than deterministic**. It used the same number of reads and assistant turns as native. Its elapsed time was essentially tied with native, about two seconds longer across sixteen runs. Estimated cost was about three percent lower.

All answers were grounded-complete, so restricting the comparison to pairs where both answers were correct leaves the numbers unchanged. There were no fast wrong answers to remove.

## Repetition and the frozen threshold

| Comparison | First repetition | Second repetition |
| --- | ---: | ---: |
| Jev follow-ups versus native | 15 versus 16 | 16 versus 19 |
| Reduction versus native | 6.3% | 15.8% |
| Questions using fewer calls versus native | 2/8 | 2/8 |
| Jev follow-ups versus deterministic | 15 versus 19 | 16 versus 21 |
| Reduction versus deterministic | 21.1% | 23.8% |
| Questions using fewer calls versus deterministic | 3/8 | 3/8 |

The frozen practical threshold required at least 20 percent fewer follow-up calls and improvements on at least three questions against both alternatives in each repetition, without a quality loss. Jev met that threshold against deterministic ordering but not native. The overall gate did not pass. This is a pilot decision rule, not a significance test.

The clearest saving came from the SymPy simplification question. Jev answered directly from the first page in both repetitions. Native and deterministic each needed one follow-up in the first repetition and three in the second. Those four saved calls account for the entire net reduction versus native. Other improvements and regressions canceled out.

Against native, Jev used fewer calls on two questions, more on one, and the same number on five in each repetition. The benefit was not broad across the sample.

## Integrity and spending

All 60 runs finished with status `ok`. Every mandatory first search succeeded. There were no blocked initial calls, Jev fallbacks, infrastructure failures or budget stops. The five source trees were unchanged after inference. Core, vendored extension, harness, protocol and rubric hashes also matched their frozen values.

The actual registered search tool reproduced all ten frozen native candidate pools before inference. Runtime checks reconciled 166 tool results with the recorded attempt counts and output bytes. The largest delivered tool result was 11,865 bytes, below the 12,000-byte cap. The model-visible ordering labels were removed while host telemetry retained them.

The full campaign, including controls, cost an estimated **$4.8425**. Jev ranking accounted for **$0.00787**, across 87 calls, and about 24.48 seconds of ranking time. Ranking time is already included in the elapsed figures, not an extra amount to add. Estimates use returned usage and configured prices, not verified billing.

## What this establishes

There are now two distinct observations.

1. Jev substantially improved early-result relevance in the matched retrieval test.
2. With the current full-page output budget, that translated into a small reduction in agent searching, concentrated in one question, rather than a reliable speed improvement over native ordering.

Do not describe this as Jev failing at bug fixing or as ranking having no value. Also do not claim a general productivity gain from four saved calls on a curated sample.

No additional campaign or daily activation follows automatically. If we pursue another experiment, the specific remaining question is whether better ordering can support a smaller search-output budget without reducing answer quality. That would test context reduction explicitly instead of hoping ordering alone changes behavior when all arms already show useful evidence on the first page.

## Limits and evidence

The sample contains eight exploratory questions across three repository families, not sixteen independent questions. Versions are pinned and old. The first query was prescribed, so the test isolates ordering rather than natural query choice. Fresh indexing excludes personal frecency history. A model supplied the independent grades. Provider latency and caching can affect small time and cost differences.

- Frozen protocol and rubric are `eval/effort/README.md` and `rubric.json`.
- All run artifacts are under `results/effort/2026-09-22T03-23-50-257Z-38138-f779d7ae/`.
- `frozen-inputs.json`, `preflight/`, `source-hashes-after.json` and `runtime-integrity.json` record the setup and integrity checks.
- Each run retains its transcript, final answer, tool arguments/results and usage.
- `judge-packet.json`, `blind-grades.json`, `blind-grade-notes.md` and `parent-adjudication.md` record grading before joining arm identities.
- `analysis.json` contains the validated grades, aggregates, per-question counts and frozen gate calculations.

No daily configuration changes, commits or publication were made.
