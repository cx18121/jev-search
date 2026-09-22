# Jev search pilot

An isolated experiment that adds intent-based ordering to FFF's existing `ffgrep` tool. It is not installed in the daily Pi configuration. `fffind` is unchanged. There is no new competing search tool.

The pilot measures retrieval relevance separately from completed-task gains. Better ranking is useful for this trial even without a proven coding-speed improvement. Roughly two seconds of added search latency is acceptable.

The [matched retrieval comparison](eval/retrieval/RESULTS.md) found useful evidence in the top five on all 8 exploratory searches with Jev, versus 4/8 with native ordering and 5/8 with the deterministic rule. Both Jev repetitions passed the predeclared ranking gate. All arms already exposed some useful evidence on the full first page.

The subsequent [60-run agent search-effort comparison](eval/effort/RESULTS.md) produced correct, source-grounded answers in every arm. On the exploratory questions, Jev used 31 follow-up calls versus native's 35 and deterministic's 40. The net saving versus native came entirely from one question, and elapsed time was essentially tied. Jev did not meet the predeclared effort threshold against native. Daily search remains unchanged. An opt-in one-session trial now lets us assess Jev's ranking in ordinary work.

The earlier [30-run coding comparison](eval/coding/RESULTS.md) found identical fix success across arms. That tested end-to-end coding outcomes, not ranking quality in isolation. No additional experiment or rollout is automatic.

## Standalone setup

```sh
npm ci --ignore-scripts
```

Make `TYPESAFE_API_KEY` available in your shell environment without committing it. From the project you want to search, start an isolated Pi session with the absolute path to this checkout:

```sh
pi --no-extensions -e /path/to/jev-search/vendor/pi-fff/src/index.ts \
  --model openai-codex/gpt-5.6-sol --thinking medium
```

This disables other extensions for that session, including installed FFF, to avoid duplicate tool registrations. It does not edit Pi settings. The experiment summaries are included, but reproducing historical campaigns also requires their local source archives, Docker images and ignored artifacts. This repository is not a self-contained benchmark distribution.

Third-party code retains its upstream licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Personal one-session trial

Charlie's separate `pi-personal` checkout provides a launcher that preserves other enabled extensions. From the project you want to work on:

```sh
node ~/Projects/personal/pi-personal/scripts/jev-trial.mjs \
  --env-file ~/Projects/personal/jev-context/.env
```

This launches Sol on medium with Jev-backed FFF and the other enabled extensions. It does not change daily settings. The model-remembering extension is omitted for this session. The env file supplies only `TYPESAFE_API_KEY`. Search intent and candidate snippets are sent to Jev, so choose an appropriate repository. Exit and launch ordinary `pi` to return to stock search.

Trial usage and limits are in `pi-personal/scripts/jev-trial.md` in that separate checkout. The launcher is not bundled in this repository. Historical benchmark protocols are unchanged.

## Implementation

- `vendor/pi-fff/src/` contains `@ff-labs/pi-fff` 0.11.0. Only `index.ts` is patched. The upstream manifest and MIT license are beside it.
- `src/rank.ts` orders plain candidates without depending on FFF.
- `src/grep-pilot.ts` collects candidate pools, formats snippets and manages continuation cursors.
- `eval/` holds the initial controlled navigation probe.
- `eval/coding/` holds the isolated five-task, three-arm, two-repetition coding experiment. It is not proof of general coding gains.
- `eval/retrieval/` holds the matched-pool ordering experiment, blind relevance labels and frozen decision protocol.
- `eval/effort/` holds the read-only code-question comparison, frozen answer rubric and search-effort results.

Fresh `ffgrep` calls need both `pattern` and `intent`. A continuation keeps the same search arguments and may omit intent. Each search collects up to 80 matches for ordering, using at most three native scan pages per pool. It does not rank every repository match. Native soft-limit overflow is held for the next pool rather than discarded.

All collected candidates remain reachable, regardless of score. A cursor drains the ordered pool before collecting more. Output is capped at 12,000 UTF-8 bytes and each snippet at 3,500 bytes. Truncation is marked. Snippets keep their paths, line numbers and whitespace. FFF itself limits matches to 200 per file and may truncate long lines. No claim of complete repository coverage is made.

`JEV_SEARCH_ORDER` selects `native`, `deterministic`, or `jev` (default). All three use the same interface, candidate collection and output limits. The deterministic arm puts definitions first, then favors different files. The native arm preserves FFF order within the expanded pool. **It is not a comparison against the entire unmodified stock FFF tool.**

Jev uses pinned model `jev-1.13.0`, independent Noul questions per candidate and groups of up to eight candidates. Requests stay under 24,000 serialized UTF-8 bytes. Groups share the search intent and candidate text, so batch scoring remains an empirical choice rather than an assumed equivalent of single-candidate scoring. `JEV_SEARCH_BATCH_SIZE=1` enables that comparison.

A ranking attempt has a 20-second deadline and no retries. Missing credentials, invalid responses and provider failures return the original pool order with an explicit notice. Cancellation remains cancellation. Tool metadata records API calls, reported tokens, ranking latency, fallback and pool coverage. A failed request may incur provider usage that was not returned and therefore cannot be counted locally.

## Checks

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

The focused tests cover stable ordering, retention of low scores, response validation, fallback, cancellation, byte limits, request packing and cursor pagination. The evaluation harness also exercises the real extension without a model call before a live run.

See `eval/README.md` for the frozen tasks, controls and live command. Results stay under ignored `results/`. Keep credentials out of the repository and the source snapshots. Do not load this extension alongside installed FFF because both register `ffgrep` and `fffind`.

## Evidence boundary

The pilot must establish basic retrieval correctness before spending on model runs. A small navigation comparison can reject a slow or ineffective approach, but cannot establish a general productivity gain. Do not activate it globally on the strength of a few passing tasks.

API contracts used here are documented in the [System One API](https://docs.typesafe.ai/api.md), [models](https://docs.typesafe.ai/models.md) and [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md). The published Jev 1.13 input price is $0.042 per million tokens, with free output tokens. Coding-agent inference is separate.
