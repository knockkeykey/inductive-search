import type { SearchScope } from "../shared/protocol";
import { articleRoot } from "./blocks";
import { element } from "./element";

const SCOPE_HIGHLIGHT = "hunch-scope";
const LABELS: Record<SearchScope, string> = { page: "整页", article: "正文", selection: "选区" };
const PAD = 6;
const EDGE = 4;

// A quiet outline of the region the next search will read: the whole viewport for 整页,
// the detected article container for 正文, and the selected text for 选区.
export class ScopeFrame {
  readonly root = element("div", { class: "hunch-scope", "aria-hidden": "true", hidden: "" });
  private readonly label = element("span", { class: "hunch-scope-label" });
  private scope: SearchScope | undefined;
  private ranges: readonly Range[] = [];
  private target: HTMLElement | undefined;
  private frame = 0;

  constructor() {
    this.root.append(this.label);
    const schedule = () => {
      if (this.scope && !this.frame) this.frame = requestAnimationFrame(() => this.layout());
    };
    // Capture so scrolls inside nested containers move the frame too.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
  }

  show(scope: SearchScope, ranges: readonly Range[]) {
    this.scope = scope;
    this.ranges = ranges;
    this.target = scope === "article" ? articleRoot() : undefined;
    this.label.textContent = `搜索范围 · ${LABELS[scope]}`;
    this.root.className = `hunch-scope hunch-scope-${scope}`;
    const highlights = globalThis.CSS?.highlights;
    if (highlights && scope === "selection" && ranges.length) {
      const highlight = new Highlight(...ranges);
      highlight.priority = -1;
      highlights.set(SCOPE_HIGHLIGHT, highlight);
    } else highlights?.delete(SCOPE_HIGHLIGHT);
    this.layout();
  }

  hide() {
    this.scope = undefined;
    this.ranges = [];
    this.target = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.root.hidden = true;
    globalThis.CSS?.highlights?.delete(SCOPE_HIGHLIGHT);
  }

  private layout() {
    this.frame = 0;
    if (!this.scope) return;
    if (this.scope === "page") {
      this.place(0, 0, window.innerWidth, window.innerHeight);
      return;
    }
    const rect = this.scope === "article" ? this.target?.getBoundingClientRect() : this.selectionRect();
    if (!rect?.width || !rect.height) {
      this.root.hidden = true;
      return;
    }
    this.place(
      Math.max(rect.left - PAD, EDGE),
      Math.max(rect.top - PAD, EDGE),
      Math.min(rect.right + PAD, window.innerWidth - EDGE),
      Math.min(rect.bottom + PAD, window.innerHeight - EDGE),
    );
  }

  private place(left: number, top: number, right: number, bottom: number) {
    // Scrolled fully out of view: nothing to outline.
    this.root.hidden = right - left < 1 || bottom - top < 1;
    if (this.root.hidden) return;
    // No room above for the label (selection labels sit fully above the box).
    this.root.classList.toggle("hunch-scope-tight", top < (this.scope === "selection" ? 24 : 12));
    Object.assign(this.root.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    });
  }

  private selectionRect() {
    let box: { left: number; top: number; right: number; bottom: number } | undefined;
    for (const range of this.ranges) {
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      box = box
        ? {
            left: Math.min(box.left, r.left),
            top: Math.min(box.top, r.top),
            right: Math.max(box.right, r.right),
            bottom: Math.max(box.bottom, r.bottom),
          }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return box && new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  }
}
