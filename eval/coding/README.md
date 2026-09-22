# Coding-task search experiment

This is an isolated follow-up to the navigation pilot. Nothing here enables the extension in daily Pi.

## Fixed question

Does Jev-assisted search help the same strong model complete real bug fixes more often, or with meaningfully less time and model usage, than stock FFF and a simple deterministic order?

The plan is five public SWE-bench Lite tasks across SymPy, pytest and Requests, with three search approaches and two repetitions each. All 30 runs use `openai-codex/gpt-6-astra` at high thinking. The task sources and local reproduction evidence are in [tasks/README.md](tasks/README.md).

Task selection and environment validation happen before any coding-model run. All five selected regression cases fail on their pinned base and pass with their official fixes. Public benchmark tasks may have appeared in model training, so this is not a contamination-free assessment.

## Comparison contract

- Stock FFF uses the pristine 0.11.0 implementation. A common harness normalizes default context and output limits. Its native candidate retrieval and ordering stay intact.
- Deterministic and Jev use the existing experimental implementation. Only their ordering policy differs.
- All arms share the same model, task text, available tools, environment and per-call search-output budget.
- The stock comparison measures the enhanced tool as a whole. Only deterministic versus Jev isolates the ranking choice within the enhanced tool.
- Agents choose their own queries. They are asked to use `ffgrep` for content search, but Bash remains available for development commands. Record search usage rather than silently excluding agents that solve a task without it.
- Rotate arm order and start every run with a fresh source tree, session and FFF database.

## Budgets and isolation

Each agent session is limited to 40 turns and eight minutes, excluding workspace setup and final grading. Estimated usage has a $3 per-run and $60 campaign soft limit, checked at turn boundaries. A final in-flight turn may exceed a soft limit. These are configured rate-card estimates, not verified charges. Record Jev usage separately.

Agents must not see gold patches, withheld test patches, validation logs, dataset records or repository history. Their Bash commands run in an isolated container without host credentials or network access. File and search tools stay within that run's workspace. Daily Pi configuration and source projects are not workspaces.

## Grading and interpretation

Construct each grader workspace from a fresh base. Apply agent source changes, excluding agent test edits, test configuration changes and SymPy's `bin/` test launcher, then the trusted test patch. Require the named regression tests and selected existing tests to pass. A zero shell exit code alone is not enough. Existing expected failures are not new regressions.

Grade partial patches even when an agent reaches its budget. Preserve failed and stopped runs in the results. Distinguish an unsolved task from an infrastructure failure; do not count a broken environment as model failure.

Compare solved tasks first, then paired time and main-model usage. A quality gain must recur across repetitions rather than depend on one lucky run. Equal scores with small timing differences do not justify added machinery. If deterministic ordering matches Jev, prefer the simpler option. If neither improves on stock FFF, shelve the wrapper.

No result automatically authorizes daily activation. This sample is a bounded decision aid, not a claim of general benchmark performance.

## Run locally

From the `jev-search` root, inspect the plan without API calls or containers.

```sh
node --import tsx eval/coding/cli.ts --manifest eval/coding/tasks/manifest.json
```

Use `--preflight` for container isolation and baseline/gold checks without model calls. Only `--live` starts the paid campaign. It verifies the fixtures and environments before invoking the model. Provide the Jev key through the subprocess environment, never through the agent prompt or workspace.

```sh
node --env-file=../jev-context/.env --import tsx eval/coding/cli.ts --manifest eval/coding/tasks/manifest.json --live
```

Results go into a unique directory under `results/coding/`, including the frozen plan and source hashes, per-run transcripts, candidate patches, exact test grades and cumulative usage estimates.
