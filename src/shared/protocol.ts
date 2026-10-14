export type BlockId = `B${string}`;

export const blockId = (i: number): BlockId => `B${String(i).padStart(3, "0")}`;

export interface Block {
  id: BlockId;
  text: string;
}

export const pageText = (blocks: readonly Block[]) => blocks.map((b) => `${b.id}| ${b.text}`).join("\n");

export type SearchMode = "semantic" | "conditions";
export type SearchScope = "page" | "article" | "selection";
export type Combination = "all" | "any";

export interface Search {
  url: string;
  title: string;
  blocks: Block[];
  query: string;
  mode?: SearchMode;
  conditions?: string[];
  combination?: Combination;
  scope?: SearchScope;
}

export interface Progress {
  type: "progress";
  scores: Record<BlockId, number>;
  done: number;
  total: number;
  failed: number;
  ms: number;
  conditionScores?: Record<BlockId, number[]>;
  // The first failed batch's error, worded for the user, whenever failed > 0.
  error?: string;
}

export interface Failure {
  type: "failure";
  message: string;
}

export type SearchEvent = Progress | Failure;

export interface Toggle {
  type: "toggle";
}
export interface Ping {
  type: "ping";
}
export type TabMessage = Toggle | Ping;

export const SEARCH_PORT = "hunch-search";

// Second pass inside the top hits: each sentence of each paragraph gets its own score.
// Paragraphs are scored separately; the message only saves round trips to the background.
export interface Refine {
  type: "refine";
  url: string;
  title: string;
  query: string;
  // Condition mode: each sentence is scored once per condition, combined like the paragraph scores.
  conditions?: string[];
  combination?: Combination;
  paragraphs: { id: BlockId; sentences: { id: `S${string}`; text: string }[] }[];
}
// Sentence scores per paragraph. A paragraph is missing when its answers were invalid
// or the request failed; its paragraph highlight stays as it is.
export interface RefineResult {
  scores: Partial<Record<BlockId, Record<`S${string}`, number>>>;
}
