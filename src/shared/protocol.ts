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
