import { element } from "./element";

export interface SelectionPopoverHandlers {
  onAsk(question: string, ranges: readonly Range[]): void;
}

export class SelectionPopover {
  readonly root: HTMLElement;
  private readonly input = element("input", {
    class: "hunch-selection-question",
    type: "text",
    placeholder: "问一个关于选中文字的问题…",
    "aria-label": "关于选中文字提问",
    maxlength: "1000",
    autocomplete: "off",
  });
  private readonly askButton = element(
    "button",
    { type: "button", class: "hunch-selection-ask", "aria-label": "提问" },
    "提问",
  );
  private readonly closeButton = element(
    "button",
    { type: "button", class: "hunch-selection-close", title: "关闭", "aria-label": "关闭提问栏" },
    "×",
  );
  private ranges: Range[] = [];
  private showTimer: number | undefined;
  private hideTimer: number | undefined;

  constructor(
    private readonly shadow: ShadowRoot,
    private readonly host: HTMLElement,
    private readonly handlers: SelectionPopoverHandlers,
  ) {
    this.root = element(
      "div",
      { class: "hunch-selection-popover", role: "search", "aria-label": "询问选中的文字" },
      element("strong", { class: "hunch-selection-title" }, "AI 搜索"),
      this.input,
      this.askButton,
      this.closeButton,
    );
    this.root.hidden = true;
    this.shadow.append(this.root);
    this.askButton.addEventListener("click", this.ask);
    this.closeButton.addEventListener("click", () => this.hide());
    this.input.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.hide();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.ask();
      }
    });
    document.addEventListener("pointerdown", this.onOutsidePointerDown, true);
    window.addEventListener("scroll", this.reposition, true);
    window.addEventListener("resize", this.reposition);
  }

  selectionChanged(ranges: readonly Range[]) {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    if (!ranges.length) {
      this.hideTimer = window.setTimeout(() => {
        if (!this.hasFocus()) this.hide();
      }, 180);
      return;
    }

    if (this.root.hidden) this.input.value = "";
    this.ranges = [...ranges];
    this.showTimer = window.setTimeout(() => this.show(), 140);
  }

  hide() {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    this.root.hidden = true;
    if (!this.host.classList.contains("hunch-open")) this.host.classList.remove("hunch-popover-open");
  }

  private show() {
    if (!this.ranges.length) return;
    this.root.hidden = false;
    this.host.classList.add("hunch-popover-open");
    requestAnimationFrame(this.reposition);
  }

  private readonly ask = () => {
    const question = this.input.value.trim();
    if (!question || !this.ranges.length) {
      this.input.focus();
      return;
    }
    this.hide();
    this.handlers.onAsk(question, this.ranges);
  };

  private readonly onOutsidePointerDown = (event: PointerEvent) => {
    if (this.root.hidden || event.composedPath().includes(this.host)) return;
    this.hide();
  };

  private readonly reposition = () => {
    if (this.root.hidden || !this.ranges.length) return;
    const rects = this.ranges
      .flatMap((range) => [...range.getClientRects()])
      .filter((rect) => rect.width && rect.height);
    if (!rects.length) return;

    const leftEdge = Math.min(...rects.map((rect) => rect.left));
    const rightEdge = Math.max(...rects.map((rect) => rect.right));
    const topEdge = Math.min(...rects.map((rect) => rect.top));
    const bottomEdge = Math.max(...rects.map((rect) => rect.bottom));
    const width = this.root.offsetWidth || 420;
    const height = this.root.offsetHeight || 52;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, (leftEdge + rightEdge - width) / 2),
      Math.max(margin, window.innerWidth - width - margin),
    );
    let top = topEdge - height - margin;
    if (top < margin) top = bottomEdge + margin;
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  };

  private hasFocus() {
    const activeElement = this.shadow.activeElement;
    return activeElement !== null && this.root.contains(activeElement);
  }
}
