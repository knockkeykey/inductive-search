import browser from "webextension-polyfill";
import type { BlockId } from "../shared/protocol";
import { THRESHOLD } from "../shared/questions";
import { type Ranked, rank } from "../shared/ranking";
import { computed, type PageBlock } from "./blocks";

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
  for (const { el, p } of hits) {
    if (painted.has(el)) continue;
    painted.add(el);
    ensureStyles(el);
    el.classList.add("hunch-hl");

    if (computed(el).position === "static") el.classList.add("hunch-rel");

    // Keyword-only hits sit below the threshold; give them the faintest highlight.
    const strength = Math.max(0, (p - threshold) / (1 - threshold));
    el.style.setProperty("--hunch-alpha", (0.08 + 0.14 * strength).toFixed(2));
    el.dataset.hunchP = p.toFixed(2);
  }
}

export function clearPaint() {
  for (const el of [...painted, ...document.querySelectorAll<HTMLElement>(".hunch-hl")]) {
    el.classList.remove("hunch-hl", "hunch-rel", "hunch-current");
    el.style.removeProperty("--hunch-alpha");
    delete el.dataset.hunchP;
  }
  painted.clear();
}

export function markCurrent(prev: Hit | undefined, next: Hit | undefined, { scroll = true } = {}) {
  prev?.el.classList.remove("hunch-current");
  next?.el.classList.add("hunch-current");
  if (scroll) next?.el.scrollIntoView({ block: "center", behavior: "smooth" });
}

// Position in the top document, adding the offsets of any same-origin frames on the way up.
export function pageTop(el: HTMLElement): number {
  let top = el.getBoundingClientRect().top;
  let view = el.ownerDocument.defaultView;
  while (view && view !== window) {
    const frame = view.frameElement as HTMLElement | null;
    if (!frame) break;
    top += frame.getBoundingClientRect().top;
    view = frame.ownerDocument.defaultView;
  }
  return top + window.scrollY;
}
