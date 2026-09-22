# Agent search-effort prototype

## Decision

Does Jev's improved search ordering help a source-navigation agent answer code questions correctly with less follow-up work?

This is an isolated experiment, not a daily search installation. It does not test bug fixes or replace the matched retrieval result. Keep it outside production. Any rollout needs a separate decision.

The matched retrieval experiment found earlier useful snippets with Jev. All three orderings already placed some useful evidence on the full first page for every exploratory question. Correctness may therefore tie, and improved ranking may produce no measurable agent benefit.

## Frozen comparison

Use every question and its immutable source snapshot from `../retrieval/frozen.json`. Do not select only questions where Jev won. Eight exploratory questions are the main sample; two exact-symbol controls are reported separately.

Each question has two repetitions under three orderings, for 60 planned runs. All arms use the same enhanced FFF tool interface, source, model, prompt, budgets and output limits. Native means native order within the enhanced collected pool, not the pristine stock FFF interface. Deterministic means the existing definition-first/file-diversity ordering. Jev means the existing live relevance ranker.

Arrange complete three-arm blocks per question and repetition, rotating the six arm permutations. Twenty blocks do not divide evenly by six; preserve the exact schedule in the manifest. Never selectively retry an unsuccessful answer. Report incomplete blocks and campaign truncation.

Use `openai-codex/gpt-6-astra` with high reasoning. Each run has at most 12 assistant turns, 120 seconds and an estimated $1 model-plus-Jev cost. The campaign has an estimated $12 soft bound. Cost limits are checked at turn boundaries and cannot prevent one request overshooting. Reserve $3 before starting a new triple rather than deliberately beginning a block that cannot fit its per-run allowances. No automatic budget increase.

## Exposure and isolation

The agent must first execute the exact frozen search pattern, path when present, and intent. The first search uses limit 20, context 3, no exclude, cursor or explicit case override. The live tool infers plain versus regex mode; all frozen patterns are plain. The prompt supplies the exact first-call arguments, not a reference answer or evidence locations. Wrong initial calls are blocked and counted. After one successful matching search, the agent freely chooses follow-up searches and reads.

Use the actual registered tool, not a pre-rendered page. A model-free preflight must reproduce each frozen first candidate pool, comparing path, line and snippet text in native order while ignoring IDs. Drain only the first collected pool; later native pools are not part of this check. Stop before paid runs on a mismatch. Do not silently mix seeded and live queries.

The only active tools are `read`, `ffgrep` and `fffind`. There is no Bash, edit, write, network tool, repository history or gold patch access. Custom read operations enforce the existing realpath/symlink workspace guard. Search paths stay relative to the immutable source root. Disable home/root scans and symlink following. Do not load personal context files, skills, other extensions, prompt templates or themes.

Share the immutable source trees to avoid copying them for every run. Verify source hashes before and after the campaign. Use fresh sessions and fresh FFF databases per run; remove only per-run runtime indexes after recording outcomes. Agent work cannot modify source files.

Hide the ordering name in the final search footer with one identical harness-side replacement. Preserve snippet text, pool size, truncation, cursors and real fallback notices. Host telemetry retains the actual arm. The installed Codex serializer was checked directly and with a synthetic converter probe. It sends tool-result content, not `details` or `usage`, to the model. Fallbacks may reveal the arm and must be reported, not erased.

## Answers and independent grading

Ask for a concise answer with repo-relative file and line citations. Do not prescribe extra reads when a search snippet already supports the answer.

`rubric.json` freezes the essential facts and citation standard before inference. It is separate from the agent prompt. The rubric uses source facts, not keyword regexes or exact prose. Reference evidence is a starting point, not an exhaustive whitelist of valid supporting locations.

A fresh independent judge receives opaque answer IDs in shuffled order, the question, rubric and pinned source access. It does not receive arm, repetition, run status, transcript, tool counts, cost, timing or earlier rankings. Record each fact judgment, material errors and citation errors. Grade factual completeness and grounded completeness separately. Preserve partial fact credit for incomplete answers.

The parent checks any ambiguity or alleged material error against source and records adjudication before joining judgments to the arm mapping. No regrading to improve an arm's score. Missing answers remain failures rather than disappearing from the denominator.

## Measurements and interpretation

Primary evidence is paired follow-up tool calls, with grounded answer completeness as a required quality constraint. Follow-up calls are all read/ffgrep/fffind attempts after the mandatory successful first search, including tool errors. Record blocked initial attempts separately and also report total tool attempts so enforcement friction cannot disappear.

Report all runs, then compare exploratory question/repetition pairs. Show complete-answer counts and per-question results before effort averages. Also report effort on pairs where both answers are grounded-complete; label that as a conditional comparison, not a replacement for the all-run result. Do not treat a fast wrong answer as a win.

Secondary measurements are searches, reads, distinct read files, output bytes delivered to the model, assistant turns, model input/output/cache tokens, estimated model and ranking cost, ranking time, total elapsed time and fallbacks. Time includes initial retrieval and Jev inference. Controls are separate. Never choose whichever secondary metric happens to favor Jev as the primary result.

A practical signal for a further natural-query trial requires all of the following against both alternatives in each repetition, on the exploratory questions.

- No lower grounded-complete count and no new material-error regression on a question the alternative answered correctly.
- At least 20 percent fewer follow-up tool calls in aggregate, with at least three paired questions using fewer calls. If the comparison uses zero follow-up calls, this threshold is not met.
- No grounded-completeness loss on either exact-symbol control.
- No infrastructure failure, missing arm, initial-pool mismatch or Jev fallback behind the claimed matched comparison.

This is a practical pilot threshold, not statistical significance. Report raw deltas even when it is not met. A tie, ceiling effect or cost/time regression means this experiment did not establish agent benefit. It does not invalidate the independently observed ranking gain. No result alone authorizes daily activation. A positive result would justify testing naturally chosen queries; a negative or mixed result calls for a narrower diagnosis, not another broad bug-fix benchmark.

## Evidence and limits

Before live calls, save hashes of this protocol, rubric, frozen retrieval dataset, source trees, ranking core, vendored extension and harness, plus the complete plan and exact prompt/configuration. Save each run's transcript, final answer, tool arguments/results, model and Jev usage, first-page hash and outcome status. Preserve partial-campaign artifacts on errors or budget stops.

The ten curated questions span three repository families and old pinned versions. Repetition does not create twenty independent questions. The required first query isolates ordering but understates the freedom of real search. Fresh frecency differs from daily use. Live Jev scores can vary; pool contents and tool contracts remain controlled. A model judge is imperfect even with blinded identities and source verification. These limits must accompany the result.
