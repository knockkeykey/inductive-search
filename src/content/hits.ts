import type { BlockId } from "../shared/protocol";
import { THRESHOLD } from "../shared/questions";
import type { PageBlock } from "./blocks";

export interface Hit extends PageBlock {
  p: number;
  conditionScores: number[];
}

export function rankHits(
  blocks: readonly PageBlock[],
  scores: Record<BlockId, number>,
  conditionScores: Record<BlockId, number[]> = {},
): Hit[] {
  return blocks
    .map((b) => ({ ...b, p: scores[b.id] ?? 0, conditionScores: conditionScores[b.id] ?? [] }))
    .filter((h) => h.p >= THRESHOLD)
    .sort((a, b) => b.p - a.p);
}

export function paint(hits: readonly Hit[]) {
  clearPaint();
  const seen = new Set<HTMLElement>();
  for (const { el, p } of hits) {
    if (seen.has(el)) continue;
    seen.add(el);
    el.classList.add("hunch-hl");

    if (getComputedStyle(el).position === "static") el.classList.add("hunch-rel");

    el.style.setProperty("--hunch-alpha", (0.15 + 0.6 * ((p - THRESHOLD) / (1 - THRESHOLD))).toFixed(2));
    el.dataset.hunchP = p.toFixed(2);
  }
}

export function clearPaint() {
  for (const el of document.querySelectorAll<HTMLElement>(".hunch-hl")) {
    el.classList.remove("hunch-hl", "hunch-rel", "hunch-current");
    el.style.removeProperty("--hunch-alpha");
    delete el.dataset.hunchP;
  }
}

export function markCurrent(prev: Hit | undefined, next: Hit | undefined, { scroll = true } = {}) {
  prev?.el.classList.remove("hunch-current");
  next?.el.classList.add("hunch-current");
  if (scroll) next?.el.scrollIntoView({ block: "center", behavior: "smooth" });
}
