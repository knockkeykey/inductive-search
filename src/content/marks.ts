import { type Hit, pageTop } from "./hits";

export class ScrollMarks {
  readonly root: HTMLElement;
  private readonly viewport: HTMLElement;

  constructor(private readonly onPick: (hit: Hit) => void) {
    this.root = document.createElement("div");
    this.root.className = "hunch-marks";
    this.viewport = document.createElement("div");
    this.viewport.className = "hunch-viewport";
    this.root.appendChild(this.viewport);
    window.addEventListener("scroll", () => requestAnimationFrame(() => this.updateViewport()), { passive: true });
  }

  draw(hits: readonly Hit[], current: Hit | undefined) {
    for (const m of this.root.querySelectorAll(".hunch-mark")) m.remove();
    const height = docHeight();
    for (const hit of hits) {
      const m = document.createElement("div");
      m.className = hit === current ? "hunch-mark hunch-mark-current" : "hunch-mark";
      m.style.top = `${(pageTop(hit.el) / height) * 100}%`;
      m.style.opacity = hit === current ? "1" : String(0.4 + 0.6 * hit.p);
      m.title = `${Math.round(hit.p * 100)}%`;
      m.addEventListener("click", () => this.onPick(hit));
      this.root.appendChild(m);
    }
    this.updateViewport();
  }

  updateViewport() {
    const height = docHeight();
    this.viewport.style.top = `${(window.scrollY / height) * 100}%`;
    this.viewport.style.height = `${(window.innerHeight / height) * 100}%`;
  }
}

const docHeight = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);
