import type { Combination, SearchScope } from "./protocol";

export interface ExcerptDraft {
  title: string;
  url: string;
  text: string;
  heading: string;
  query: string;
  conditions: string[];
  combination: Combination;
  scope: SearchScope;
}

export interface Excerpt extends ExcerptDraft {
  id: string;
  createdAt: string;
}

export type ExcerptRequest =
  | { type: "excerpt-list" }
  | { type: "excerpt-save"; excerpt: ExcerptDraft }
  | { type: "excerpt-delete"; id: string };

export type ExcerptResponse = { ok: true; excerpts: Excerpt[] } | { ok: false; error: string };

export function validateExcerpt(draft: ExcerptDraft): ExcerptDraft {
  const url = new URL(draft.url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only web-page sources can be saved.");
  if (typeof draft.text !== "string" || !draft.text.trim() || draft.text.length > 20_000) {
    throw new Error("An excerpt must contain between 1 and 20,000 characters.");
  }
  const line = (value: string) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1_000) : "");
  return {
    url: url.href,
    title: line(draft.title) || url.hostname,
    text: draft.text.trim(),
    heading: line(draft.heading),
    query: line(draft.query),
    conditions: Array.isArray(draft.conditions) ? draft.conditions.slice(0, 5).map(line).filter(Boolean) : [],
    combination: draft.combination === "any" ? "any" : "all",
    scope: draft.scope === "article" || draft.scope === "selection" ? draft.scope : "page",
  };
}

const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}[\]<>#])/g, "\\$1");

export function excerptsMarkdown(excerpts: readonly Excerpt[]): string {
  return excerpts
    .map((excerpt) => {
      const source = excerpt.url.replace(/[<>]/g, (char) => encodeURIComponent(char));
      const criteria = excerpt.conditions.length
        ? `筛选条件（${excerpt.combination === "all" ? "全部满足" : "任一满足"}）：${excerpt.conditions.map(escapeMarkdown).join("；")}`
        : excerpt.query
          ? `搜索：${escapeMarkdown(excerpt.query)}`
          : "";
      return [
        `## ${escapeMarkdown(excerpt.title)}`,
        `[原文来源](<${source}>)`,
        excerpt.heading ? `所在标题：${escapeMarkdown(excerpt.heading)}` : "",
        criteria,
        `保存时间：${excerpt.createdAt}`,
        excerpt.text
          .split(/\r?\n/)
          .map((line) => `> ${escapeMarkdown(line)}`)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n---\n\n");
}
