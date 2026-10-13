import { element } from "./element";

const MARGIN = 8;
const STEP = 24;

// The floating dock (result card + command bar). A grabber on the bar moves it anywhere
// in the viewport; double-click or Home snaps it back to the bottom centre.
export class Dock {
  readonly root = element("div", { class: "hunch-dock" });
  readonly grabber = element("button", {
    type: "button",
    class: "hunch-grabber",
    title: "拖动移动搜索栏，双击复位",
    "aria-label": "移动搜索栏（方向键移动，Home 复位）",
  });
  private x = 0;
  private y = 0;

  constructor(...children: HTMLElement[]) {
    this.root.append(...children);
    this.grabber.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX - this.x;
      const startY = event.clientY - this.y;
      this.grabber.setPointerCapture?.(event.pointerId);
      this.root.classList.add("hunch-dragging");
      const move = (e: PointerEvent) => this.moveTo(e.clientX - startX, e.clientY - startY);
      const end = () => {
        this.root.classList.remove("hunch-dragging");
        this.grabber.removeEventListener("pointermove", move);
        this.grabber.removeEventListener("pointerup", end);
        this.grabber.removeEventListener("pointercancel", end);
      };
      this.grabber.addEventListener("pointermove", move);
      this.grabber.addEventListener("pointerup", end);
      this.grabber.addEventListener("pointercancel", end);
    });
    this.grabber.addEventListener("dblclick", () => this.moveTo(0, 0));
    this.grabber.addEventListener("keydown", (event) => {
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-STEP, 0],
        ArrowRight: [STEP, 0],
        ArrowUp: [0, -STEP],
        ArrowDown: [0, STEP],
      };
      if (event.key === "Home") this.moveTo(0, 0);
      else if (delta[event.key]) this.moveTo(this.x + delta[event.key]![0], this.y + delta[event.key]![1]);
      else return;
      event.preventDefault();
    });
    // Keep it on screen when the window shrinks or the card grows.
    new ResizeObserver(() => this.moveTo(this.x, this.y)).observe(this.root);
    window.addEventListener("resize", () => this.moveTo(this.x, this.y));
  }

  private moveTo(x: number, y: number) {
    const rect = this.root.getBoundingClientRect();
    if (!rect.width) return;
    // rect already includes the current offset; work out the untranslated box.
    const left = rect.left - this.x;
    const top = rect.top - this.y;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
    this.x = clamp(x, MARGIN - left, window.innerWidth - MARGIN - left - rect.width);
    this.y = clamp(y, MARGIN - top, window.innerHeight - MARGIN - top - rect.height);
    this.root.style.translate = this.x || this.y ? `${this.x}px ${this.y}px` : "";
  }
}
