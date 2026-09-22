# Matched retrieval result

Jev improved ordering on this frozen sample and passed the predeclared gate for an agent search-effort experiment. This does not yet establish faster coding or justify daily activation.

## Useful evidence came earlier

Eight exploratory code questions used identical queries, candidate pools and snippets for all orderings. Two exact-symbol controls were evaluated separately. An independent reviewer labeled all 256 candidates before scoring, without seeing native positions or arm results. Labels identified 77 useful snippets, 179 not useful and none uncertain.

| Ordering | Useful evidence in top five | Mean reciprocal rank | Useful evidence on full first page |
| --- | --- | --- | --- |
| Native pool order | 4/8 | 0.466 | 8/8 |
| Deterministic rule | 5/8 | 0.496 | 8/8 |
| Jev, first run | 8/8 | 0.917 | 8/8 |
| Jev, second run | 8/8 | 0.938 | 8/8 |

Reciprocal rank is 1 for a first useful result at position one, 0.5 at position two, and so on. Higher means useful evidence appears earlier. It does not measure whether the complete answer is present.

| Code question | Native first useful position | Deterministic | Jev first run | Jev second run |
| --- | --- | --- | --- | --- |
| Remove authorization on cross-host redirect | 6 | 3 | 1 | 1 |
| Requests redirect limit | 1 | 1 | 1 | 1 |
| pytest test-file collection patterns | 1 | 1 | 1 | 1 |
| pytest stop after failures | 1 | 1 | 1 | 1 |
| pytest persistence of last failed tests | 4 | 7 | 1 | 1 |
| pytest choice of modules for assertion rewriting | 10 | 12 | 1 | 1 |
| SymPy simplification complexity measure | 14 | 3 | 1 | 1 |
| SymPy generic free-symbol computation | 7 | 14 | 3 | 2 |

Both Jev runs kept useful evidence on the first page for every exploratory question and control. For the parse-expression control, Jev moved the canonical definition from position two to one. The encoding-property control had only one candidate.

## What changed on the actual first page

All approaches already exposed at least some useful evidence within the production first-page budget, so this test found no first-page coverage gain.

Jev often made that page more focused. For the assertion-rewriting question, native ordering exposed one useful snippet among the first twenty, deterministic exposed six, and both Jev runs exposed twenty. These include overlapping snippets, not twenty independent facts.

Across the eight exploratory questions, the total number of labeled useful snippets in the first five was 14 for native, 14 for deterministic, and 31 and 30 for Jev. That is descriptive evidence density, not an independent-observation count.

## Frozen gate passed

All eight exploratory pools contained useful evidence. Four had their first useful native result after position five, meeting the dataset sufficiency bar.

Both Jev repetitions exceeded both alternatives by at least 0.10 mean reciprocal rank and at least two additional top-five hits. Neither lost first-page useful evidence. There were no fallbacks. With no uncertain labels, the inclusive and strict sensitivity calculations coincide rather than supplying an independent robustness check.

The [protocol](README.md), questions, pools and labels were frozen before API calls. Queries and labels were not adjusted after seeing rankings. An independent method review found no blocking correctness defects.

## Cost and latency

The two Jev runs made 70 API calls in total, reporting 169,584 input tokens and 16,028 output tokens. Estimated ranking cost was **$0.00712**, less than one cent at the configured rate. This is not verified billing.

Total ranking time was 7.37 seconds for the first repetition and 6.80 seconds for the second. Median per-query ranking time, including the one-candidate no-call control, was 0.537 and 0.302 seconds. The slowest query took 2.00 and 1.88 seconds respectively. No coding-agent inference ran in this experiment.

## Interpretation

This answers the ranking question more directly than the earlier bug-fix comparison. Jev can bring labeled useful evidence forward in these real code-search pools. It is not just adding latency without changing ordering quality.

It remains possible that an agent reads the whole first page and gains little from the improved ordering. The next justified experiment is a small, repeated code-question comparison measuring correct answers, searches, file reads, latency and model usage. Do not rerun bug-fix completion as the primary metric, and do not enable the wrapper yet.

The sample has only eight exploratory questions across three repository families. Queries were curated, not sampled from daily use. A model supplied the independent labels and saw source-verified reference answers, which can anchor judgments. Labels credit useful partial evidence rather than requiring a complete answer. In particular, the free-symbol pool lacks the Symbol base-case implementation, and some other questions also require facts outside their collected snippets. Missing evidence cannot be repaired by reranking.

Native here means original order inside the same enhanced pool, not the entire stock FFF interface. Fresh indexing lacks personal frecency history. These limits constrain generalization without erasing the observed ordering improvement.

## Evidence

- Queries, frozen pools and labels are in `eval/retrieval/{queries,frozen,labels}.json`.
- Run artifacts are under `results/retrieval/2026-09-22T02-34-29-878Z/`.
- `frozen-inputs.json` binds dataset, labels, protocol, ranking core and harness hashes.
- Per-query files preserve scores, candidate order, metrics and usage.
- `summary.json` contains every comparison and the predeclared gate result.
- `results/retrieval/pools-v2/label-notes.md` records labeling conventions and coverage limits.

Before labeling, two exact-symbol controls returned zero matches only with their redundant filename filters. Those filters were removed, with the original collection and rationale preserved in `results/retrieval/pools-v1/`. The eight exploratory pools were unchanged. No query changed after scoring.

The collection metadata's `orderChanged` field is not a ranking result. Replacing positional IDs with opaque IDs during freezing made that field true without changing native candidate order. Analysis uses the frozen sequence, not that field.

No daily configuration changes, commits or publication were made.
