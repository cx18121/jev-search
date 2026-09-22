# Bounded search-order navigation pilot

This directory is a small, read-only evaluation harness for the enhanced vendored FFF integration. It is not a benchmark platform and is not enabled in daily Pi.

## Safety and scope

- Default invocation is a dry run. Only `--live` can call the configured model.
- Initial matrix: 3 frozen code-navigation tasks × `native|deterministic|jev`, at most 9 runs.
- Each run is bounded to 12 model turns and 120 seconds, with retry and compaction disabled.
- Agents receive only `read`, `ffgrep`, and `fffind`: no bash, edit, or write tool.
- A harness-only `tool_call` guard blocks absolute, home-relative, or parent-traversing read/search paths. Each run uses a disposable copy of the frozen TypeScript-only fixture; original projects are never agent workspaces.
- Settings are in-memory. Extensions, skills, prompt templates, themes, and context files are disabled; only the inline FFF factory is loaded. Sessions are in-memory.
- The upstream-consumed `FFF_FRECENCY_DB`, `FFF_HISTORY_DB`, and `PI_CODING_AGENT_DIR` point inside the disposable run runtime directory, preventing fallback to personal FFF/nvim databases or runtime config.
- Live artifacts go under ignored `results/<unique-id>/`, outside source. No environment or credential values are recorded.
- This evaluates navigation correctness only. It cannot support claims about feature completion, coding productivity, representativeness, or a daily rollout.

The `native` arm uses the same enhanced candidate pool, pagination, context, output bounds, and tool schemas as the other arms. It is **not** stock FFF. A pristine stock-FFF arm is intentionally pending rather than emulated incorrectly.

## Commands

From the project root:

```bash
# Exact plan; no API/model call and no results directory
node --import tsx eval/cli.ts

# Targeted deterministic grader/exposure tests
node --import tsx --test eval/*.test.ts

# Real extension lifecycle/tool smoke, still no model prompt/API call
node --import tsx eval/cli.ts --offline-smoke

# One controlled live smoke (only after plan/cost approval)
node --env-file=../jev-context/.env --import tsx eval/cli.ts \
  --live --task fast-mode-gating --order native

# Full approved pilot (9 runs maximum)
node --env-file=../jev-context/.env --import tsx eval/cli.ts --live
```

`--task` and `--order` may independently narrow a dry or live plan. Live uses `openai-codex/gpt-6-astra` at `high` thinking through `ModelRuntime.create()` and current authentication. The harness never reads or prints a credential value and does not expose bash to the agent.

## Frozen tasks and grading

`tasks.ts` contains the prompts and deterministic path/fact rubrics. Agents must return:

```json
{"paths":["repo/relative.ts"],"facts":["specific verified fact"]}
```

`grader.ts` exports `parseStructuredAnswer()` and `gradeAnswer()` for unit tests. No model grades its own answer.

The fixture contains all `.ts` files from the source snapshot's `extensions/`, `modules/cxstack/`, and `vendor/pi-memory/src/` trees. `fixtures/snapshot-manifest.json` freezes every relative path and SHA-256. Live setup verifies hashes before and after copying.

A run must finish with status `ok`, return parseable paths/facts JSON with the required paths and at least one fact, and expose at least one successful `ffgrep` pool larger than one. Fact-pattern scores are reported but do not gate comparison because a legitimate answer can phrase a fact differently. Native and deterministic runs must report zero ranking API calls. Every Jev run must report at least one ranking API call, no fallback, and `details.rerank.orderChanged: true` for at least one exposed pool. Pool exposure is reported as `exposedPoolSizeSum` over newly scanned/ranked pools, not repeated cursor pages. Turn transcripts retain full tool-result details and every assistant usage report. Unused search, unchanged Jev ordering, fallback, malformed answers, timeouts, and errors invalidate the affected run and are reported directly.

## Artifacts

A live result directory contains:

- `manifest.json`: exact matrix, model, bounds, tool scope, and source hashes.
- `run-*/transcript.json`: assistant turns/usages plus turn-level tool results and full details.
- `run-*/outcome.json`: grade, usage/cost totals, tool counts, FFF exposure telemetry, status/error.
- `summary.json`: compact rows, total usage/cost, gate failures, and changed-ordering validity.

Even a complete 9-run sample is insufficient to choose general coding efficacy or justify rollout.
