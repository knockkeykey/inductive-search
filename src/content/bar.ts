import type { Combination, SearchMode, SearchScope } from "../shared/protocol";
import { parseConditions } from "../shared/questions";
import { element } from "./element";

export interface SearchControls {
  query: string;
  mode: SearchMode;
  scope: SearchScope;
  combination: Combination;
  conditions: string[];
}
export interface BarHandlers {
  onSubmit(): void;
  onChange(): void;
  onStep(dir: 1 | -1): void;
  onClose(): void;
  onPanel(): void;
}
export interface Status {
  counter?: string;
  verdict?: { text: string; tone: "found" | "absent" | "busy" | "error" | "none" };
  meta?: string;
  progress?: { done: number; total: number };
}

export class FindBar {
  readonly root: HTMLElement;
  private readonly input = element("input", {
    class: "hunch-input",
    type: "text",
    placeholder: "输入问题，按 Enter 搜索",
    "aria-label": "搜索问题",
    maxlength: "1000",
    autocomplete: "off",
  });
  private readonly conditions = element("textarea", {
    class: "hunch-conditions",
    placeholder: "每行一个条件，例如：\n包含作者实际测试的结果\n给出了具体数据",
    "aria-label": "搜索条件，每行一个",
    rows: "3",
    maxlength: "3000",
  });
  private readonly mode = element("select", { "aria-label": "查找方式" });
  private readonly scope = element("select", { "aria-label": "搜索范围" });
  private readonly combination = element("select", { "aria-label": "条件组合" });
  private readonly counter = element("span", { class: "hunch-counter" });
  private readonly verdict = element("span", { class: "hunch-verdict", role: "status", "aria-live": "polite" });
  private readonly meta = element("span", { class: "hunch-meta" });
  private readonly progress = element("div", { class: "hunch-progress-fill" });
  private readonly panelButton = element(
    "button",
    { type: "button", class: "hunch-nav", "aria-expanded": "true" },
    "结果 / 摘录",
  );

  constructor(handlers: BarHandlers) {
    this.mode.append(new Option("按意思找", "semantic"), new Option("按条件找", "conditions"));
    this.scope.append(new Option("整页", "page"), new Option("仅正文", "article"), new Option("当前选区", "selection"));
    this.combination.append(new Option("全部满足", "all"), new Option("任一满足", "any"));
    this.conditions.hidden = true;
    this.combination.hidden = true;
    const submit = element("button", { type: "button", class: "hunch-submit" }, "搜索");
    const prev = element(
      "button",
      { type: "button", class: "hunch-nav", title: "上一个结果", "aria-label": "上一个结果" },
      "▲",
    );
    const next = element(
      "button",
      { type: "button", class: "hunch-nav", title: "下一个结果", "aria-label": "下一个结果" },
      "▼",
    );
    const close = element(
      "button",
      { type: "button", class: "hunch-close", title: "关闭 (Esc)", "aria-label": "关闭感应式搜索" },
      "✕",
    );
    this.root = element(
      "div",
      { class: "hunch-bar", role: "search", "aria-label": "感应式搜索网页查找" },
      element(
        "div",
        { class: "hunch-controls" },
        this.mode,
        this.scope,
        this.input,
        this.combination,
        submit,
        this.panelButton,
        close,
      ),
      this.conditions,
      element("div", { class: "hunch-status" }, this.counter, prev, next, this.verdict, this.meta),
      element("div", { class: "hunch-progress" }, this.progress),
    );
    submit.addEventListener("click", handlers.onSubmit);
    close.addEventListener("click", handlers.onClose);
    prev.addEventListener("click", () => handlers.onStep(-1));
    next.addEventListener("click", () => handlers.onStep(1));
    this.panelButton.addEventListener("click", handlers.onPanel);
    this.mode.addEventListener("change", () => {
      const conditional = this.mode.value === "conditions";
      this.input.hidden = conditional;
      this.conditions.hidden = !conditional;
      this.combination.hidden = !conditional;
      handlers.onChange();
      this.focus();
    });
    for (const select of [this.scope, this.combination]) select.addEventListener("change", handlers.onChange);
    for (const input of [this.input, this.conditions]) {
      input.addEventListener("input", (event) => {
        if (!(event as InputEvent).isComposing) handlers.onChange();
      });
      input.addEventListener("compositionend", handlers.onChange);
      input.addEventListener("keydown", (rawEvent) => {
        const event = rawEvent as KeyboardEvent;
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") handlers.onClose();
        else if (event.key === "Enter" && (input === this.input || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (event.shiftKey) handlers.onStep(-1);
          else handlers.onSubmit();
        }
      });
    }
  }

  controls(): SearchControls {
    return {
      query: this.input.value.trim(),
      mode: this.mode.value as SearchMode,
      scope: this.scope.value as SearchScope,
      combination: this.combination.value as Combination,
      conditions: parseConditions(this.conditions.value),
    };
  }
  focus() {
    (this.mode.value === "conditions" ? this.conditions : this.input).focus();
  }
  setPanelOpen(open: boolean) {
    this.panelButton.setAttribute("aria-expanded", String(open));
  }
  set(status: Status) {
    if (status.counter !== undefined) this.counter.textContent = status.counter;
    if (status.meta !== undefined) this.meta.textContent = status.meta;
    if (status.verdict) {
      this.verdict.textContent = status.verdict.text;
      this.verdict.className = `hunch-verdict hunch-${status.verdict.tone}`;
    }
    if (status.progress) {
      const { done, total } = status.progress;
      this.progress.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
      this.progress.parentElement!.classList.toggle("hunch-active", total > 0 && done < total);
    }
  }
}
