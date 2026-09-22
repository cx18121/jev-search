# Matched retrieval prototype

This tests ordering, not bug-fix ability. Daily search and the ranking implementation stay unchanged.

## Frozen protocol

Use ten real code questions across the existing pinned Requests, pytest and SymPy sources. Eight are exploratory keyword searches and two are exact-symbol controls. The curator inspects source to establish an answer, without seeing any ranking results. Do not tune queries after scoring.

Collect one pool per query through the existing `GrepPilot`, with three lines of context, an 80-candidate cap and at most three native scans. Use fresh indexes with no personal frecency history. All arms receive identical visible candidate text. Native means original order in this collected pool, not the entire stock FFF interface. Do not change retrieval, snippets, prompts or batching for any arm.

An independent reviewer labels every candidate from a packet sorted by opaque ID, without native positions, ordering scores or arm names. Labels concern directly useful evidence visible in the snippet. Surrounding source verifies meaning but cannot supply evidence missing from the snippet. Each label includes a short reason. Partial or ambiguous evidence may be marked uncertain. Reference answers are starting points for verification, not automatic labels based on matching a gold patch.

Freeze queries, pools, labels, source hashes and this protocol before live ranking. Labels and reference answers never go into Jev requests. Run native and deterministic once, and Jev twice with identical input and default batches of eight. No retries or post-result prompt tuning. Stop before another pool if estimated Jev usage reaches $1. No coding-model runs in this gate.

## Measurements

Report every question, including empty or zero-positive pools.

- Coverage. Does the collected pool contain any independently labeled useful evidence?
- Ordering. First useful position and reciprocal rank, presence of useful evidence in the first five and ten candidates, and number of useful candidates in those prefixes.
- Actual first page. Useful evidence within the production 20-candidate, 12,000-byte output limit, including its 1,200-byte footer reserve.
- Cost and latency. Report Jev usage, fallback and elapsed ranking time separately.

Use hit rate and reciprocal rank as primary ordering measures. Nearby overlapping snippets can all be useful, so raw useful-candidate counts are descriptive, not independent pieces of evidence. Compute uncertain-label sensitivity both excluding and including uncertain candidates. Keep controls separate from exploratory questions.

## Decision gate fixed before scores

This is a practical pilot threshold, not statistical significance or an estimate of daily frequency.

A dataset can support the next gate only if at least six exploratory pools contain useful evidence and at least four have their first useful native result below position five. Otherwise report insufficient retrieval coverage or insufficient ranking challenge. Do not repair the dataset after seeing scores.

Proceed to a small agent code-question comparison only if both Jev repetitions:

1. Improve mean reciprocal rank by at least 0.10 over both alternatives on covered exploratory queries.
2. Produce at least two additional top-five hits in aggregate over each alternative on those same queries.
3. Lose useful first-page evidence on no more than one exploratory query relative to either alternative, and lose none on the controls.

The conclusion must survive uncertain-label sensitivity and must not rely on fallback runs. A failed or inconclusive gate is not proof that reranking cannot work elsewhere. Record exactly whether coverage, ranking quality, reliability or sample size prevented a conclusion. Do not launch the agent-effort gate automatically if the evidence is ambiguous.

## Evidence boundary

These are deliberately selected navigation questions, not a representative sample of Charlie's daily searches. Fresh frecency differs from a warmed daily index. An independent model supplies labels, with source verification and explicit uncertainty, not a human-labeled benchmark. Ranking the correct passage earlier does not itself establish faster or more reliable coding.
