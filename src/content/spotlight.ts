import { element } from "./element";
import { isDark } from "./tone";

const PAD = 8;
// On the lit paragraph, so content.css can drop the ring the cutout already provides.
const SPOT = "hunch-spot";

// Dims the page around the current hit, after macOS's Spotlight and Safari's find-in-page: one
// rounded cutout whose huge spread shadow is the dimming, so the page itself is never touched.
export class Spotlight {
  readonly root = element("div", { class: "hunch-spotlight", "aria-hidden": "true", hidden: "" });
  // The page's own score badge straddles the paragraph's top edge, so the dimming would cut it in
  // half; this copy sits in the same spot but above the dimming.
  private readonly score = element("span", { class: "hunch-spotlight-score" });
  private target: HTMLElement | undefined;
  private frame = 0;

  constructor() {
    this.root.append(this.score);
    const schedule = () => {
      if (this.target && !this.frame) this.frame = requestAnimationFrame(() => this.layout());
    };
    // Capture so scrolls inside nested containers move the cutout too.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
  }

  show(el: HTMLElement | undefined) {
    if (!el) return this.hide();
    const moved = this.target !== el;
    this.target?.classList.remove(SPOT);
    this.target = el;
    el.classList.add(SPOT);
    this.root.classList.toggle("hunch-spotlight-dark", isDark(el));
    this.score.textContent = el.dataset.hunchP ?? "";
    this.score.hidden = !this.score.textContent;
    this.root.hidden = false;
    this.layout();
    if (moved) {
      // Restart the pop on every new target.
      this.root.classList.remove("hunch-spotlight-pop");
      void this.root.offsetWidth;
      this.root.classList.add("hunch-spotlight-pop");
    }
  }

  hide() {
    this.target?.classList.remove(SPOT);
    this.target = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.root.hidden = true;
  }

  private layout() {
    this.frame = 0;
    if (!this.target) return;
    if (!this.target.isConnected) return this.hide();
    const rect = this.target.getBoundingClientRect();
    let { left, top } = rect;
    // Hits in same-origin frames report coordinates relative to their own viewport.
    let view = this.target.ownerDocument.defaultView;
    while (view && view !== window) {
      const frame = view.frameElement as HTMLElement | null;
      if (!frame) break;
      const box = frame.getBoundingClientRect();
      left += box.left;
      top += box.top;
      view = frame.ownerDocument.defaultView;
    }
    Object.assign(this.root.style, {
      left: `${left - PAD}px`,
      top: `${top - PAD}px`,
      width: `${rect.width + PAD * 2}px`,
      height: `${rect.height + PAD * 2}px`,
    });
  }
}
