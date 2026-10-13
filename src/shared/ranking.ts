import type { BlockId } from "./protocol";
import { THRESHOLD } from "./questions";

export const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] as const;
export const validThreshold = (value: unknown): number =>
  THRESHOLDS.includes(value as (typeof THRESHOLDS)[number]) ? (value as number) : THRESHOLD;

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const QUOTED = /"([^"]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/g;

// Literal terms for hybrid matching. Quoted phrases are exact; otherwise the query is split on
// spaces and every word must appear. A natural-language question rarely matches literally, and
// that is fine: the model handles meaning, keywords only catch what it scores low.
export function keywordTerms(query: string): string[] {
  const quoted = [...query.matchAll(QUOTED)].map((m) => m.slice(1).find(Boolean) ?? "");
  const raw = quoted.length ? quoted : query.split(/\s+/);
  const terms = raw.map((term) => normalize(term).replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")).filter(Boolean);
  // One-character terms would match almost every Chinese block.
  return [...new Set(terms)].filter((term) => [...term].length >= 2);
}

export const matchesKeywords = (text: string, terms: readonly string[]) => {
  if (!terms.length) return false;
  const haystack = normalize(text);
  return terms.every((term) => haystack.includes(term));
};

export interface Ranked {
  p: number;
  conditionScores: number[];
  // Included because it literally contains the search terms, whatever its model score.
  keyword: boolean;
}

export function rank<T extends { id: BlockId; text: string }>(
  blocks: readonly T[],
  scores: Record<BlockId, number>,
  conditionScores: Record<BlockId, number[]> = {},
  { threshold = THRESHOLD, terms = [] as readonly string[] } = {},
): (T & Ranked)[] {
  return blocks
    .map((b) => ({
      ...b,
      p: scores[b.id] ?? 0,
      conditionScores: conditionScores[b.id] ?? [],
      keyword: matchesKeywords(b.text, terms),
    }))
    .filter((h) => h.p >= threshold || h.keyword)
    .sort((a, b) => Number(b.p >= threshold) - Number(a.p >= threshold) || b.p - a.p);
}
