export type SearchOrder = "native" | "deterministic" | "jev";

export type FactCriterion = {
  id: string;
  description: string;
  patterns: RegExp[];
};

export type NavigationTask = {
  id: string;
  title: string;
  prompt: string;
  requiredPaths: string[];
  factCriteria: FactCriterion[];
};

export const SEARCH_ORDERS: readonly SearchOrder[] = ["native", "deterministic", "jev"];

export const TASKS: readonly NavigationTask[] = [
  {
    id: "fast-mode-gating",
    title: "Trace fast-mode request gating",
    prompt: [
      "Trace the fast-mode implementation end to end.",
      "Report the exact supported model IDs, both accepted provider/API/authentication combinations, every gate before service_tier is injected, what prevents overwriting an existing tier, and how enabled state is restored.",
      "Cite the implementing source path(s).",
    ].join(" "),
    requiredPaths: ["extensions/fast-mode.ts"],
    factCriteria: [
      {
        id: "models",
        description: "all five supported model IDs",
        patterns: [/gpt-5\.4/i, /gpt-5\.5/i, /gpt-5\.6-luna/i, /gpt-5\.6-sol/i, /gpt-5\.6-terra/i],
      },
      {
        id: "openai-api",
        description: "OpenAI Responses combination",
        patterns: [/provider[^\n]{0,80}openai|openai[^\n]{0,80}provider/i, /openai-responses/i],
      },
      {
        id: "codex-oauth",
        description: "Codex Responses requires OAuth",
        patterns: [/openai-codex/i, /openai-codex-responses/i, /oauth/i],
      },
      {
        id: "request-gates",
        description: "injection requires enabled state, supported current model, and matching payload model",
        patterns: [/enabled/i, /support/i, /payload[^\n]{0,120}model|model[^\n]{0,120}payload/i, /match|===|equal/i],
      },
      {
        id: "no-overwrite",
        description: "existing service_tier is not overwritten",
        patterns: [/service_tier/i, /already|existing|present|in payload|"service_tier" in/i, /not|skip|undefined|prevent|refus/i],
      },
      {
        id: "restore",
        description: "last matching custom entry controls restored enabled state",
        patterns: [/findLast|last/i, /personal-fast-mode/i, /enabled[^\n]{0,60}true|true[^\n]{0,60}enabled/i],
      },
    ],
  },
  {
    id: "cx-audit-selection",
    title: "Trace CX audit session selection",
    prompt: [
      "Trace how the CX audit command builds its session manifest.",
      "Explain ordering, current-session exclusion, unreadable-session handling, what counts as CX usage, reference/version collection, current-kernel cohort selection and fallback, plus the command's behavior for skipped or empty inputs.",
      "Cite the implementing source paths.",
    ].join(" "),
    requiredPaths: ["modules/cxstack/lib/audit.ts", "modules/cxstack/extensions/audit.ts"],
    factCriteria: [
      {
        id: "ordering-current",
        description: "newest-first ordering and resolved current-session exclusion",
        patterns: [/modified/i, /newest|descending|right.*left|b.*a/i, /current/i, /resolve/i, /exclude|skip|continue/i],
      },
      {
        id: "read-errors",
        description: "read failures call the callback and skip that session",
        patterns: [/read/i, /error|unreadable/i, /callback|onReadError|notify/i, /skip|continue/i],
      },
      {
        id: "usage-events",
        description: "CX use is detected from active state or active custom message",
        patterns: [/cx-state|CX_STATE_ENTRY/i, /active[^\n]{0,80}true|true[^\n]{0,80}active/i, /cx-active|CX_ACTIVE_MESSAGE|custom_message/i],
      },
      {
        id: "references",
        description: "references require reference+version and are deduplicated/sorted",
        patterns: [/reference/i, /version/i, /dedup|map|unique|key/i, /sort/i],
      },
      {
        id: "cohort-fallback",
        description: "prefer sessions matching current kernel, otherwise retain all used sessions",
        patterns: [/current.*kernel|kernel.*current|currentKernelVersion/i, /include|match/i, /fallback|otherwise|if none|all sessions|return sessions/i],
      },
      {
        id: "command-handling",
        description: "command warns for unreadable sessions and stops on an empty manifest",
        patterns: [/unreadable|skipped/i, /warn/i, /no earlier|sessions\.length|empty|zero/i, /return|stop/i],
      },
    ],
  },
  {
    id: "memory-search-pipeline",
    title: "Trace memory search and ranking",
    prompt: [
      "Trace the project-memory search pipeline from source-file collection through result ranking.",
      "Explain source scopes and exclusions, identifier tokenization, markdown cleanup/blocking, exact-phrase boundaries, AND/OR/fuzzy fallback rules, ranking tie-breaks, and the effective result cap.",
      "Cite the implementing source paths.",
    ].join(" "),
    requiredPaths: ["vendor/pi-memory/src/core.ts", "vendor/pi-memory/src/search.ts"],
    factCriteria: [
      {
        id: "sources",
        description: "global plus optional project sources and PAPERCUTS exclusion",
        patterns: [/global/i, /project/i, /PAPERCUTS\.md/i, /exclude|filter|not search/i],
      },
      {
        id: "tokens",
        description: "identifier-aware lowercase token variants split camel/Pascal/uppercase/numeric pieces",
        patterns: [/lower/i, /identifier/i, /camel|pascal|uppercase|snake|parts/i, /number|numeric|digit|\p\{N\}/i],
      },
      {
        id: "markdown",
        description: "markdown is split into heading-aware blocks and metadata/markup is cleaned",
        patterns: [/heading/i, /block/i, /metadata/i, /clean|strip|remove/i],
      },
      {
        id: "boundaries",
        description: "exact phrases use identifier-aware punctuation boundaries",
        patterns: [/exact phrase|exactPhrase/i, /boundar(?:y|ies)/i, /[./:@+\-]|punctuation|identifier/i],
      },
      {
        id: "fallback",
        description: "AND first, then OR, then constrained edit-distance fuzzy fallback",
        patterns: [/AND/i, /OR/i, /fuzzy/i, /length[^\n]{0,30}5|five characters|>=?\s*5/i, /maxFuzzy|edit distance|one edit|distance[^\n]{0,20}1/i],
      },
      {
        id: "ranking",
        description: "exact phrase, score, word coverage, partial matches, then path",
        patterns: [/exact/i, /score/i, /matchingWords|matching words|word coverage/i, /partialMatches|partial matches/i, /path/i],
      },
      {
        id: "cap",
        description: "limit is clamped to 1..25 after flooring",
        patterns: [/25/, /1|one/, /floor|integer|clamp|min|max/i],
      },
    ],
  },
] as const;

export function getTask(id: string): NavigationTask | undefined {
  return TASKS.find((task) => task.id === id);
}
