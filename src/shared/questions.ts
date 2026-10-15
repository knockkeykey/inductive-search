import { type NoulQuestion, noul } from "@typesafe-ai/sdk";
import type { BlockId, Combination } from "./protocol";

export const MAX_CHUNK_CHARS = 60_000;
export const MAX_CHUNK_BLOCKS = 200;
export const MAX_BLOCK_CHARS = 1_500;
export const MIN_BLOCK_CHARS = 12;
export const MAX_CONCURRENT_REQUESTS = 4;
// Batches at or above this size are not retried after a timeout.
export const LARGE_CHUNK_CHARS = 8_000;

export const THRESHOLD = 0.4;
export const MAX_CONDITIONS = 3;

export function parseConditions(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export const conditionId = (id: BlockId | `S${string}`, index: number) => `${id}_C${index + 1}`;

// Each condition is judged exactly like a 按问题 search for that condition, once per condition.
export function conditionQuestions(
  conditions: readonly string[],
  ids: readonly BlockId[],
): Record<string, NoulQuestion> {
  return Object.fromEntries(
    ids.flatMap((id) => conditions.map((condition, index) => [conditionId(id, index), blockQuestion(condition, id)])),
  );
}

// These are conservative ranking scores, not calibrated probabilities of an AND/OR event.
export function combineConditions(scores: readonly number[], combination: Combination): number {
  if (!scores.length) return 0;
  return combination === "all" ? Math.min(...scores) : Math.max(...scores);
}

const blockQuestion = (query: string, id: BlockId): NoulQuestion =>
  noul(`Is block \`${id}\` what a reader searching this page for "${query}" is looking for?`, {
    true: "The block contains, states, or is specifically about what the search is for; for a question, the block answers it",
    false: "The block is unrelated, or only shares a few words with the search without containing or addressing it",
  });

export function questionsFor(query: string, ids: readonly BlockId[]): Record<BlockId, NoulQuestion> {
  return Object.fromEntries(ids.map((id) => [id, blockQuestion(query, id)]));
}

const sentenceQuestion = (query: string, id: string): NoulQuestion =>
  noul(`Within this paragraph, is sentence \`${id}\` the part a reader searching for "${query}" is looking for?`, {
    true: "The sentence itself contains, states, or answers what the search is for; for a question, it gives the answer",
    false:
      "The sentence is only context around the answer, or merely shares a few words with the search without containing it",
  });

export function sentenceQuestionsFor(query: string, ids: readonly string[]): Record<string, NoulQuestion> {
  return Object.fromEntries(ids.map((id) => [id, sentenceQuestion(query, id)]));
}

// Condition mode's in-paragraph locating: the same sentence question, once per condition.
export function conditionSentenceQuestions(
  conditions: readonly string[],
  ids: readonly `S${string}`[],
): Record<string, NoulQuestion> {
  return Object.fromEntries(
    ids.flatMap((id) =>
      conditions.map((condition, index) => [conditionId(id, index), sentenceQuestion(condition, id)]),
    ),
  );
}
