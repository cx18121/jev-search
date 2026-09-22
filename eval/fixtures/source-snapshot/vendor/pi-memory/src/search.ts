import * as path from "node:path";
import MiniSearch from "minisearch";
import { isMetadataLine } from "./format.js";

export interface SearchSource {
  path: string;
  content: string;
}

export interface SearchResult {
  path: string;
  excerpt: string;
  score: number;
  exactPhrase: boolean;
  matchingWords: number;
  partialMatches: number;
}

function identifierParts(term: string) {
  return term
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap(
      (part) =>
        part.match(/\p{Lu}+(?=\p{Lu}\p{Ll}|\p{N}|$)|\p{Lu}?\p{Ll}+|\p{N}+/gu) ?? [part],
    )
    .map((part) => part.toLocaleLowerCase());
}

function tokenVariants(term: string) {
  return [...new Set([term.toLocaleLowerCase(), ...identifierParts(term)])];
}

function searchTokens(text: string) {
  const terms = text.match(/[\p{L}\p{N}_./:@+-]+/gu) ?? [];
  return terms.flatMap(tokenVariants);
}

function queryWords(query: string) {
  return [...new Set(searchTokens(query))];
}

function cleanSearchText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !isMetadataLine(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]\s+)?\[[ xX]\]\s+/, "")
        .replace(/^\s*(?:[-*+] |\d+[.)] )/, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
        .replace(/[`*~]/g, ""),
    )
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizedPhrase(text: string) {
  return cleanSearchText(text)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function isPhraseBoundary(text: string, index: number, direction: -1 | 1, phraseEdge: string) {
  const character = text[index];
  if (character === undefined) return true;
  if (/[\p{L}\p{N}_]/u.test(character)) return false;
  if (!/[./:@+-]/u.test(character)) return true;
  if (character === phraseEdge) return false;
  const beyond = text[index + direction];
  return beyond === undefined || !/[\p{L}\p{N}_./:@+-]/u.test(beyond);
}

function containsExactPhrase(text: string, phrase: string) {
  const normalized = normalizedPhrase(text);
  let index = normalized.indexOf(phrase);
  while (index >= 0) {
    const leftBoundary = isPhraseBoundary(normalized, index - 1, -1, phrase[0]);
    const rightBoundary = isPhraseBoundary(normalized, index + phrase.length, 1, phrase.at(-1)!);
    if (leftBoundary && rightBoundary) return true;
    index = normalized.indexOf(phrase, index + 1);
  }
  return false;
}

interface MarkdownSearchBlock {
  heading: string[];
  original: string;
}

interface MarkdownFence {
  character: string;
  length: number;
}

function markdownFence(line: string) {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  return { character: match[1][0], length: match[1].length, markerLength: match[0].length };
}

function closesMarkdownFence(line: string, fence: MarkdownFence) {
  const marker = markdownFence(line);
  return marker?.character === fence.character
    && marker.length >= fence.length
    && !line.slice(marker.markerLength).trim();
}

function markdownSearchBlocks(content: string) {
  const blocks: MarkdownSearchBlock[] = [];
  const headings: string[] = [];
  let blockHeading: string[] = [];
  let fence: MarkdownFence | null = null;
  let lines: string[] = [];
  const flush = () => {
    const original = lines.join("\n").trim();
    if (original) blocks.push({ heading: blockHeading, original });
    lines = [];
  };

  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMarker = markdownFence(line);
    if (fence) {
      lines.push(line);
      if (closesMarkdownFence(line, fence)) fence = null;
      continue;
    }
    if (fenceMarker) {
      if (!lines.length) blockHeading = [...headings];
      lines.push(line);
      fence = fenceMarker;
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const depth = heading[1].length;
      headings.length = depth - 1;
      headings[depth - 1] = cleanSearchText(heading[2]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!lines.length) blockHeading = [...headings];
    lines.push(line);
  }
  flush();
  return blocks;
}

function identifierText(text: string) {
  const candidates = text.match(/[\p{L}\p{N}_./:@+-]*[_./:@+-][\p{L}\p{N}_./:@+-]*|\b(?:\p{Ll}+\p{Lu}[\p{L}\p{N}]*|\p{Lu}[\p{Lu}\p{N}_]{2,})\b/gu) ?? [];
  return candidates.join(" ");
}

function sourceText(filePath: string, heading: string[]) {
  const file = path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ");
  return [file, ...heading].join(" ");
}

function matchingLineIndex(lines: string[], phrase: string, words: string[]) {
  const exact = lines.findIndex((line) => containsExactPhrase(line, phrase));
  if (exact >= 0) return exact;
  return lines.findIndex((line) => {
    const tokens = new Set(searchTokens(cleanSearchText(line)));
    return words.some((word) => tokens.has(word));
  });
}

function codeFenceRange(lines: string[], target: number) {
  let fence: (MarkdownFence & { start: number }) | null = null;
  for (let index = 0; index < lines.length; index++) {
    const marker = markdownFence(lines[index]);
    if (!fence && marker) {
      fence = { ...marker, start: index };
      continue;
    }
    if (fence && closesMarkdownFence(lines[index], fence)) {
      if (target >= fence.start && target <= index) return { start: fence.start, end: index + 1, closed: true };
      fence = null;
    }
  }
  if (fence && target >= fence.start) return { start: fence.start, end: lines.length, closed: false };
  return null;
}

function cropExcerpt(text: string, phrase: string, words: string[], limit: number) {
  if (text.length <= limit) return text;
  const normalized = text.toLocaleLowerCase();
  const anchor = [phrase, ...words]
    .map((value) => normalized.indexOf(value))
    .find((index) => index >= 0) ?? 0;
  const start = Math.max(0, Math.min(anchor - Math.floor(limit * 0.4), text.length - limit));
  const prefix = start > 0 ? "…" : "";
  const suffix = start + limit < text.length ? "…" : "";
  return `${prefix}${text.slice(start, start + limit - prefix.length - suffix.length).trim()}${suffix}`;
}

function centeredExcerpt(original: string, phrase: string, words: string[]) {
  const lines = original.split("\n").filter((line) => !isMetadataLine(line));
  const match = matchingLineIndex(lines, phrase, words);
  const center = match >= 0 ? match : 0;
  const fence = codeFenceRange(lines, center);
  if (fence) {
    const opening = lines[fence.start].trimEnd();
    const closing = fence.closed ? lines[fence.end - 1].trimEnd() : "";
    const bodyEnd = fence.closed ? fence.end - 1 : fence.end;
    const body = lines.slice(fence.start + 1, bodyEnd).join("\n").trim();
    const separators = closing ? 2 : 1;
    const bodyLimit = Math.max(1, 400 - opening.length - closing.length - separators);
    return `${opening}\n${cropExcerpt(body, phrase, words, bodyLimit)}${closing ? `\n${closing}` : ""}`;
  }

  const excerpt = lines.slice(Math.max(0, center - 1), center + 2).join("\n").trim();
  return cropExcerpt(excerpt, phrase, words, 400);
}

interface SearchDocument {
  id: number;
  path: string;
  original: string;
  body: string;
  source: string;
  identifiers: string;
}

export function searchSources(sources: SearchSource[], query: string, limit = 5) {
  const phrase = normalizedPhrase(query);
  const words = queryWords(query);
  if (!phrase || !words.length) return [];

  const documents: SearchDocument[] = [];
  for (const source of sources) {
    for (const block of markdownSearchBlocks(source.content)) {
      const body = cleanSearchText(block.original);
      if (!body) continue;
      documents.push({
        id: documents.length,
        path: source.path,
        original: block.original,
        body,
        source: sourceText(source.path, block.heading),
        identifiers: identifierText(body),
      });
    }
  }
  if (!documents.length) return [];

  const index = new MiniSearch<SearchDocument>({
    fields: ["body", "source", "identifiers"],
    storeFields: ["path", "original", "body"],
    tokenize: searchTokens,
  });
  index.addAll(documents);

  const prefix = (term: string, position: number, terms: string[]) =>
    term.length >= 3 && position === terms.length - 1;
  const searchOptions = {
    boost: { body: 1, source: 1.5, identifiers: 2 },
    combineWith: "AND" as const,
    prefix,
    weights: { prefix: 0.5, fuzzy: 0.25 },
  };
  let matches = index.search(query, searchOptions);
  if (!matches.length) {
    matches = index.search(query, { ...searchOptions, combineWith: "OR" });
    const fuzzy = (term: string) => term.length >= 5 && /^[\p{L}\p{N}]+$/u.test(term) ? 1 : false;
    const fullCoverage = matches.some((match) => match.queryTerms.length >= words.length);
    if (!fullCoverage && words.some((word) => fuzzy(word) !== false)) {
      matches = index.search(query, { ...searchOptions, combineWith: "OR", fuzzy, maxFuzzy: 1 });
    }
  }

  return matches
    .map((match): SearchResult => {
      const body = String(match.body);
      const tokens = new Set(searchTokens(body));
      return {
        path: String(match.path),
        excerpt: centeredExcerpt(String(match.original), phrase, words),
        score: match.score,
        exactPhrase: containsExactPhrase(body, phrase),
        matchingWords: words.filter((word) => tokens.has(word)).length,
        partialMatches: words.filter((word) => containsExactPhrase(body, word)).length,
      };
    })
    .sort(
      (left, right) =>
        Number(right.exactPhrase) - Number(left.exactPhrase) ||
        right.score - left.score ||
        right.matchingWords - left.matchingWords ||
        right.partialMatches - left.partialMatches ||
        left.path.localeCompare(right.path),
    )
    .slice(0, Math.min(25, Math.max(1, Math.floor(limit))));
}
