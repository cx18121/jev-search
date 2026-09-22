import type { NavigationTask } from "./tasks.ts";

export type StructuredAnswer = {
  paths: string[];
  facts: string[];
};

export type CriterionResult = {
  id: string;
  description: string;
  passed: boolean;
  matchedPatterns: number;
  totalPatterns: number;
};

export type Grade = {
  parsed: boolean;
  score: number;
  maxScore: number;
  pathScore: number;
  factScore: number;
  missingPaths: string[];
  criteria: CriterionResult[];
  answer?: StructuredAnswer;
  parseError?: string;
};

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function candidateJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

/** Parse the frozen answer contract without invoking a model or judge. */
export function parseStructuredAnswer(raw: string): StructuredAnswer {
  const value: unknown = JSON.parse(candidateJson(raw));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("answer must be a JSON object");
  }
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.paths) || !object.paths.every((item) => typeof item === "string")) {
    throw new Error("answer.paths must be an array of strings");
  }
  if (!Array.isArray(object.facts) || !object.facts.every((item) => typeof item === "string")) {
    throw new Error("answer.facts must be an array of strings");
  }
  return {
    paths: object.paths.map(normalizePath),
    facts: object.facts.map((fact) => fact.trim()).filter(Boolean),
  };
}

/** Deterministic navigation grader: exact paths plus frozen fact-pattern groups. */
export function gradeAnswer(task: NavigationTask, raw: string): Grade {
  const maxScore = task.requiredPaths.length + task.factCriteria.length;
  let answer: StructuredAnswer;
  try {
    answer = parseStructuredAnswer(raw);
  } catch (error) {
    return {
      parsed: false,
      score: 0,
      maxScore,
      pathScore: 0,
      factScore: 0,
      missingPaths: [...task.requiredPaths],
      criteria: task.factCriteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        passed: false,
        matchedPatterns: 0,
        totalPatterns: criterion.patterns.length,
      })),
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const answerPaths = new Set(answer.paths);
  const missingPaths = task.requiredPaths.filter((path) => !answerPaths.has(normalizePath(path)));
  const pathScore = task.requiredPaths.length - missingPaths.length;
  const factText = answer.facts.join("\n");
  const criteria = task.factCriteria.map((criterion): CriterionResult => {
    const matchedPatterns = criterion.patterns.filter((pattern) => pattern.test(factText)).length;
    return {
      id: criterion.id,
      description: criterion.description,
      passed: matchedPatterns === criterion.patterns.length,
      matchedPatterns,
      totalPatterns: criterion.patterns.length,
    };
  });
  const factScore = criteria.filter((criterion) => criterion.passed).length;

  return {
    parsed: true,
    score: pathScore + factScore,
    maxScore,
    pathScore,
    factScore,
    missingPaths,
    criteria,
    answer,
  };
}
