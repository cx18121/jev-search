# Next experiment. Isolate retrieval quality

Keep the current prototype and daily search unchanged. Do not build more wrapper features or repeat the bug-fix campaign as the primary test.

## Question

Given the same search intent, query and candidate pool, does Jev put useful code evidence earlier than native FFF ordering or the deterministic rule?

The completed coding experiment did not isolate this question. Finding the relevant module and producing a correct patch are different outcomes.

## First gate. Matched rankings

1. Freeze realistic code questions and search queries before running any ranking arm. Include ambiguous searches with many plausible matches and a few straightforward controls. Do not select examples based on Jev's results.
2. Retrieve each candidate pool once. Preserve native ordering and exact candidate text. Apply deterministic and Jev ordering to that same pool. Use the same snippet and output budgets.
3. Label the passages that directly answer each code question independently of arm identity and ranking. Check the surrounding source, not only a match to a gold patch. Record uncertainty and multiple valid passages. Freeze labels before comparing scores.
4. Report whether useful evidence was retrieved at all, separately from where each ranking placed it. Reranking cannot recover evidence absent from its input pool.
5. Compare the position of the first useful passage, useful evidence in the first five and ten candidates, and useful evidence within the actual first-page byte budget. Include API latency and estimated cost.
6. Report gains, regressions and ties per query. Distinguish challenging searches from easy controls. This deliberately selected sample tests whether reranking can help when ordering matters, not how frequently those situations occur in daily use.

## Second gate. Agent search effort

If the matched rankings show a useful advantage, give agents concrete code questions rather than bug-fix tasks. Measure answer correctness against the frozen evidence labels, searches, file reads, time and usage. Keep the model and budgets equal and repeat the comparisons.

The two gates answer different questions. Better ordering is not automatically a productivity improvement, and an unchanged patch-success rate is not proof that ordering failed.

## Status

The matched retrieval gate is complete. Queries, labels and thresholds were fixed before scoring. Both Jev repetitions passed. See the [retrieval results](../retrieval/RESULTS.md) and [frozen protocol](../retrieval/README.md).

The agent search-effort gate is also complete. All 60 answers passed blinded semantic grading. Jev used 31 follow-up calls versus native's 35 and deterministic's 40 on the exploratory questions. Its net gain over native was concentrated in one question, elapsed time was essentially tied, and the predeclared effort threshold against native was not met. See the [agent search-effort results](../effort/RESULTS.md). Neither daily activation nor another campaign is authorized by this result alone.
