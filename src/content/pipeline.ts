import type { BlockId } from "../shared/protocol";
import type { PageBlock } from "./blocks";

// Makes the search pipeline visible on the page: while Jev is judging, every text block that was
// sent gets a dashed outline; each one clears as soon as its score comes back. Purely visual —
// it never changes which blocks are sent or how they rank.
const PENDING = "hunch-pending";
const waiting = new Map<HTMLElement, Set<BlockId>>();

// `style` gives shadow roots and iframes their copy of content.css (hits.ts ensureStyles); it is
// passed in so this module stays free of extension APIs and loads in the dev preview.
export function markPending(blocks: readonly PageBlock[], style: (el: HTMLElement) => void = () => {}) {
  for (const { id, el } of blocks) {
    if (!el.isConnected) continue;
    let ids = waiting.get(el);
    if (!ids) {
      ids = new Set();
      waiting.set(el, ids);
      style(el);
      el.classList.add(PENDING);
    }
    ids.add(id);
  }
}

// An element can hold several blocks (long paragraphs are split); it clears once all are scored.
export function settlePending(scored: Record<BlockId, unknown>) {
  for (const [el, ids] of waiting) {
    for (const id of ids) if (id in scored) ids.delete(id);
    if (ids.size) continue;
    el.classList.remove(PENDING);
    waiting.delete(el);
  }
}

export function clearPending() {
  for (const el of waiting.keys()) el.classList.remove(PENDING);
  waiting.clear();
}
