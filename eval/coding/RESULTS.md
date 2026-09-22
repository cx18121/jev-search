# Coding comparison result

Keep daily search unchanged. This experiment found no fix-quality advantage for Jev. Its modest aggregate efficiency gain over stock FFF did not repeat in the second pass. It did not isolate ranking quality, so these results are insufficient grounds to abandon reranking. Keep the prototype for a matched retrieval comparison before deciding whether to develop or enable it further.

## All 30 runs completed

Five public SWE-bench Lite tasks ran twice with each of three search approaches. Every run used `openai-codex/gpt-6-astra` at high thinking, a fresh workspace and FFF database, and the same tool and agent budgets. Arm order rotated. Stock FFF kept native retrieval and ordering, with common presentation limits. See the [experiment contract](README.md).

| Search approach | Test-verified fixes | Total elapsed time | Estimated combined cost | Agent turns |
| --- | --- | --- | --- | --- |
| Stock FFF | 6/10 | 808.7 seconds | $3.087 | 94 |
| Deterministic | 6/10 | 916.8 seconds | $2.928 | 97 |
| Jev | 6/10 | 745.1 seconds | $2.800 | 89 |

Times include workspace setup and final grading. Costs use configured rate tables and reported usage, not verified billing. Total estimated campaign cost was **$8.815**. No run reached a turn, time or cost limit. Every run has a grade, and there were no recorded runner or grading errors.

## Exactly the same successes and failures

| Task | Stock | Deterministic | Jev |
| --- | --- | --- | --- |
| SymPy BlockMatrix indexing, `19007` | 0/2 | 0/2 | 0/2 |
| SymPy PolynomialError, `21379` | 2/2 | 2/2 | 2/2 |
| pytest changed working directory, `7220` | 2/2 | 2/2 | 2/2 |
| pytest mark evaluation caching, `7373` | 2/2 | 2/2 | 2/2 |
| Requests Unicode decoding, `3362` | 0/2 | 0/2 | 0/2 |

Passing requires the exact selected regression and existing test IDs to pass in a fresh grader workspace. All five pinned bases failed their regression cases, and all five official fixes passed preflight. These are selected tests, not a claim that each patch passes its repository's entire suite.

The failed BlockMatrix patches edited the relevant module but failed the two symbolic-index regressions. The failed Requests patches edited response/encoding code but failed the required Unicode-decoding test. The failure pattern does not establish that finding the right file was the limiting factor.

## The efficiency result did not repeat against stock

Across both passes, Jev used 7.9% less elapsed time and 9.3% less estimated cost than stock. It was faster in six of ten matched runs and cheaper in five.

| Pass | Stock time | Jev time | Stock estimated cost | Jev estimated cost |
| --- | --- | --- | --- | --- |
| First | 456.2 seconds | 382.0 seconds | $1.732 | $1.418 |
| Second | 352.5 seconds | 363.1 seconds | $1.354 | $1.383 |

Jev was faster and cheaper in the first pass, then slightly slower and more expensive in the second. Median run time was also slightly higher for Jev, 80.0 versus 78.1 seconds. Provider latency, caching and agent behavior vary between runs. This is not a repeatable efficiency win over stock.

Jev was faster than deterministic ordering in both passes. Its cost advantage over deterministic appeared only in the second pass. Deterministic ordering did not provide a consistent alternative advantage either.

## Jev actually ran

The Jev arm made 30 `ffgrep` calls. Ranking made 63 API requests, reported 141,747 input tokens and 7,976 output tokens, and took 17.14 seconds total. Candidate order changed on 23 search calls. There were no fallbacks. Estimated ranking cost was **$0.00595**. Main-model usage dominated cost.

Stock made 36 `ffgrep` calls and deterministic made 31. No Bash calls matched the harness's `grep`/`rg`/`find` bypass detector. That detector is not proof that every possible alternate search method was absent.

## Decision and limits

The initial recommendation was to shelve the wrapper. On reconsideration, that went beyond the evidence. Identical bug-fix outcomes do not establish that the rankings were equally useful. Correctness of the final patch also depends on the agent's reasoning after retrieval.

The settled next step is to keep the prototype and compare ordering on identical queries and candidate pools, with independently labeled useful passages. Then test whether any ranking improvement reduces agent search effort. Do not add wrapper features or enable it daily on the strength of these coding results. See the [next experiment](RETRIEVAL-NEXT.md).

There are only five distinct public tasks and two repetitions. Training contamination is possible. Different agents chose different queries. Stock versus either enhanced arm measures the whole tool difference, while deterministic versus Jev isolates ordering within the enhanced tool. This experiment does not prove that Jev cannot help a different workload.

## Evidence

Artifacts are under `results/coding/2026-09-22T01-18-01-809Z-62868-ed23ed6b/`.

- `frozen-plan.json` records the model, budgets, source hashes and 30-run plan.
- `summary.json` preserves all original outcomes and usage.
- `analysis.json` aggregates paired outcomes, repeat-level totals and integrity checks without changing original results.
- Each `run-*/` has a transcript, candidate patch, grader output and exact test grades.
- `preflight/` and `isolation/` hold baseline, gold and sandbox evidence.

The runner received independent correctness review. Two blocking findings were fixed before paid calls. Typecheck, 33 tests and a real container timeout regression probe passed. Nothing was committed, published or activated in daily Pi.
