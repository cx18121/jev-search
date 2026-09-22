# Jev search

Intent-based code search ranking for Pi, built on FFF.

FFF finds matches. Jev reorders them based on what the agent is trying to find. The extension adds an `intent` argument to the existing `ffgrep` tool and leaves `fffind` unchanged.

This is experimental. Small evaluations show better ranking, but do not establish faster coding or better task outcomes.

## Try it

You need Node.js, npm, Pi, and a TypeSafe API key for Jev ranking.

```sh
git clone https://github.com/cx18121/jev-search.git
cd jev-search
npm ci --ignore-scripts
```

Make `TYPESAFE_API_KEY` available in your shell environment. From the project you want to search, launch Pi with the absolute path to this checkout:

```sh
pi --no-extensions -e /path/to/jev-search/vendor/pi-fff/src/index.ts
```

This loads only the search extension for that session. It does not edit Pi settings. Do not load it alongside another FFF extension, since both register `ffgrep` and `fffind`.

**Search intent and candidate code snippets are sent to the TypeSafe API.** Use it only with code you are allowed to send to that service. Keep credentials out of the repository.

## Usage

The agent supplies a search pattern and a description of the code it needs. For example, an `ffgrep` call could use:

```json
{
  "pattern": "fallback",
  "path": "src/",
  "intent": "Find how a failed ranking returns the original search order"
}
```

The pattern controls which matches FFF retrieves. The intent controls their ranking. Jev cannot recover code that the pattern did not match.

Results retain file paths, line numbers, and source text. Low-scoring matches are not discarded. Continuation cursors expose the rest of the pool before retrieving more matches. Continuations keep the same search arguments and may omit `intent`.

## Behavior and limits

- Each pool contains up to 80 matches. Ranking is within that pool, not across the whole repository.
- Output is capped at 12,000 UTF-8 bytes per page and 3,500 bytes per snippet. Truncation is marked. FFF also limits matches to 200 per file.
- Missing credentials, invalid responses, or provider failures return the original pool order with a notice. Ranking has a 20-second deadline and no retries.
- The ranker uses `jev-1.13.0`, with up to eight candidates per request. Tool metadata includes ranking latency, reported token usage, and fallback status.

`JEV_SEARCH_ORDER` selects `jev` (default), `native`, or `deterministic`. Native preserves FFF's pool order. Deterministic puts definitions first, then favors different files. All modes share the same retrieval and output limits.

## Results

In a [matched-pool evaluation](eval/retrieval/RESULTS.md) of eight exploratory searches, useful evidence appeared in the top five for:

| Ordering | Searches with useful evidence in the top five |
| --- | --- |
| Native | 4/8 |
| Deterministic | 5/8 |
| Jev | 8/8 in both repetitions |

Every ordering already exposed some useful evidence on the full first page. These were curated queries with fixed candidate pools, not a comparison against the entire unmodified FFF tool.

A [60-run agent comparison](eval/effort/RESULTS.md) produced correct answers in every ordering. Jev modestly reduced follow-up calls, but the net saving over native came from one question and elapsed time was essentially tied. An earlier [coding comparison](eval/coding/RESULTS.md) found identical fix success across orderings.

The evidence supports improved ranking on this sample, not a general productivity claim. Historical campaigns require local source archives, Docker images, and ignored artifacts that are not bundled here.

## Development

```sh
npm test
npm run typecheck
```

- [`src/rank.ts`](src/rank.ts) handles scoring and fallback without depending on FFF.
- [`src/grep-pilot.ts`](src/grep-pilot.ts) handles candidate pools, snippets, and pagination.
- [`vendor/pi-fff/`](vendor/pi-fff/) contains FFF 0.11.0 with a patched `src/index.ts`.
- [`eval/`](eval/) contains evaluation harnesses, protocols, and reports.

The API integration follows the [System One API](https://docs.typesafe.ai/api.md) and [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md).

## License

Original project code is licensed under the [MIT License](LICENSE). Third-party code and source excerpts retain their upstream licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
