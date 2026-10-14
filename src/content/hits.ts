import browser from "webextension-polyfill";
import type { BlockId } from "../shared/protocol";
import { THRESHOLD } from "../shared/questions";
import { type Ranked, rank } from "../shared/ranking";
import { computed, type PageBlock } from "./blocks";
import { applyTone, clearTone } from "./tone";

export interface Hit extends PageBlock, Partial<Pick<Ranked, "keyword">> {
  p: number;
  conditionScores: number[];
}

export function rankHits(
  blocks: readonly PageBlock[],
  scores: Record<BlockId, number>,
  conditionScores: Record<BlockId, number[]> = {},
  options: { threshold?: number; terms?: readonly string[] } = {},
): Hit[] {
  return rank(blocks, scores, conditionScores, options);
}

// Hits can live in shadow trees and same-origin iframes, which document.querySelectorAll can't see.
const painted = new Set<HTMLElement>();
const styled = new WeakSet<Node>();

// content.css is only inserted into the top document; give other roots their own copy.
function ensureStyles(el: HTMLElement) {
  const root = el.getRootNode();
  if (root === document || styled.has(root)) return;
  const target = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root : (root as Document).head;
  if (!target) return;
  styled.add(root);
  const link = el.ownerDocument.createElement("link");
  link.rel = "stylesheet";
  link.href = browser.runtime.getURL("content.css");
  link.dataset.hunch = "";
  target.appendChild(link);
}

export function paint(hits: readonly Hit[], threshold = THRESHOLD) {
  clearPaint();
  for (const { el, p, conditionScores } of hits) {
    if (painted.has(el)) continue;
    painted.add(el);
    ensureStyles(el);
    applyTone(el);
    el.classList.add("hunch-hl");

    if (computed(el).position === "static") el.classList.add("hunch-rel");

    // Keyword-only hits sit below the threshold; give them the lightest wash. Still well below the
    // sentence marks' saturation so those carry the emphasis.
    const strength = Math.max(0, (p - threshold) / (1 - threshold));
    el.style.setProperty("--hunch-alpha", (0.2 + 0.4 * strength).toFixed(3));
    el.dataset.hunchP = p.toFixed(2);
    // Condition mode: tint by the strongest condition, matching that condition's badge in the bar.
    // Purely visual; the score and order above come from the combined p.
    const cond = strongest(conditionScores);
    if (cond >= 0) el.dataset.hunchCond = String(cond + 1);
  }
}

// Index of the highest score, or -1 when there are no per-condition scores (semantic mode).
export function strongest(scores: readonly number[]): number {
  let best = -1;
  for (let i = 0; i < scores.length; i++) if (best < 0 || scores[i]! > scores[best]!) best = i;
  return best;
}

export function clearPaint() {
  for (const el of [...painted, ...document.querySelectorAll<HTMLElement>(".hunch-hl")]) {
    el.classList.remove("hunch-hl", "hunch-rel", "hunch-current", "hunch-hover", "hunch-spot");
    clearTone(el);
    el.style.removeProperty("--hunch-alpha");
    delete el.dataset.hunchP;
    delete el.dataset.hunchCond;
  }
  painted.clear();
}

export function markCurrent(prev: Hit | undefined, next: Hit | undefined, { scroll = true } = {}) {
  prev?.el.classList.remove("hunch-current");
  next?.el.classList.add("hunch-current");
  if (scroll) next?.el.scrollIntoView({ block: "center", behavior: "smooth" });
}
