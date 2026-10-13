import type { Combination, SearchMode, SearchScope } from "../shared/protocol";
import { THRESHOLDS } from "../shared/ranking";
import { ConditionList } from "./condition-list";
import { element } from "./element";
import { icon } from "./icons";

export type Theme = "auto" | "light" | "dark";
const THEMES: Record<Theme, { icon: Parameters<typeof icon>[0]; label: string }> = {
  auto: { icon: "circleHalf", label: "外观：跟随系统" },
  light: { icon: "sun", label: "外观：浅色" },
  dark: { icon: "moon", label: "外观：深色" },
};

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
  onScope(): void;
  onRefresh(): void;
  onStep(dir: 1 | -1): void;
  onClose(): void;
  onScopeVisible(): void;
  onTheme(): void;
  onThreshold(value: number): void;
  onRetry(): void;
}
export interface Status {
  counter?: string;
  verdict?: { text: string; tone: "found" | "absent" | "busy" | "error" | "none" };
  meta?: string;
  progress?: { done: number; total: number };
}

function iconButton(name: Parameters<typeof icon>[0], label: string, extra = "") {
  return element(
    "button",
    { type: "button", class: `hunch-icon-button ${extra}`.trim(), title: label, "aria-label": label },
    icon(name),
  );
}

// A Spotlight-style command bar: one prominent field on top, compact chips underneath.
export class FindBar {
  readonly root: HTMLElement;
  private readonly input = element("input", {
    class: "hunch-input",
    type: "text",
    placeholder: "问点什么，例如「父亲去买什么了」",
    "aria-label": "搜索问题",
    maxlength: "1000",
    autocomplete: "off",
  });
  private readonly conditions: ConditionList;
  private readonly modeButtons = [
    element("button", { type: "button", role: "radio", "data-value": "semantic" }, "按意思"),
    element("button", { type: "button", role: "radio", "data-value": "conditions" }, "按条件"),
  ];
  private readonly mode = element(
    "div",
    { class: "hunch-segmented", role: "radiogroup", "aria-label": "查找方式" },
    ...this.modeButtons,
  );
  private modeValue: SearchMode = "semantic";
  private readonly scope = element("select", { class: "hunch-chip-select", "aria-label": "搜索范围" });
  private readonly combination = element("select", { class: "hunch-chip-select", "aria-label": "条件组合" });
  private readonly leading = element("span", { class: "hunch-field-icon" }, icon("magnifier"));
  private readonly counter = element("span", { class: "hunch-counter" });
  private readonly stepper: HTMLElement;
  // Status and errors get their own full-width row so long messages wrap instead of being cut off.
  private readonly verdict = element("span", { class: "hunch-verdict", role: "status", "aria-live": "polite" });
  private readonly meta = element("span", { class: "hunch-meta" });
  private readonly status = element("div", { class: "hunch-status" }, this.verdict, this.meta);
  private readonly progress = element("div", { class: "hunch-progress-fill" });
  private readonly scopeButton = element(
    "button",
    {
      type: "button",
      class: "hunch-chip hunch-scope-toggle",
      "aria-pressed": "true",
      title: "在网页上标出搜索范围",
      "aria-label": "标出搜索范围",
    },
    icon("viewfinder"),
  );
  private readonly themeButton = element("button", { type: "button", class: "hunch-chip hunch-theme-toggle" });
  // Shown when the page grew after a search (infinite scroll, lazy sections).
  private readonly refreshButton = element(
    "button",
    { type: "button", class: "hunch-chip hunch-refresh", title: "只搜索页面新增的文字块", hidden: "" },
    icon("refresh"),
    element("span", { class: "hunch-chip-count" }, ""),
  );
  // Re-ranks the scores already received; changing it never sends a request.
  private readonly threshold = element("select", {
    class: "hunch-chip-select",
    "aria-label": "相关度阈值",
    title: "相关度阈值：越低结果越多、越可能不相关。只重新排序，不重新请求。",
  });
  // Shown when some batches failed; re-sends only the blocks that got no score.
  private readonly retryButton = element(
    "button",
    { type: "button", class: "hunch-chip hunch-retry", title: "只重新搜索失败的文字块", hidden: "" },
    icon("refresh"),
    element("span", { class: "hunch-chip-count" }, ""),
  );
  private verdictState: NonNullable<Status["verdict"]> = { text: "", tone: "none" };
  private flashTimer: number | undefined;

  constructor(handlers: BarHandlers) {
    this.conditions = new ConditionList({ onChange: handlers.onChange, onSubmit: handlers.onSubmit });
    this.scope.append(new Option("整页", "page"), new Option("仅正文", "article"), new Option("当前选区", "selection"));
    this.combination.append(new Option("全部满足", "all"), new Option("任一满足", "any"));
    for (const value of THRESHOLDS) this.threshold.append(new Option(`阈值 ${value.toFixed(1)}`, String(value)));
    const submit = element(
      "button",
      { type: "button", class: "hunch-submit", title: "搜索 (Enter)", "aria-label": "搜索" },
      icon("arrowUp"),
    );
    const prev = iconButton("chevronUp", "上一个结果 (Shift+Enter)");
    const next = iconButton("chevronDown", "下一个结果");
    const close = iconButton("xmark", "关闭 (Esc)", "hunch-close");
    this.stepper = element("span", { class: "hunch-stepper" }, prev, this.counter, next);
    this.root = element(
      "div",
      { class: "hunch-bar hunch-material", role: "search", "aria-label": "感应式搜索网页查找" },
      element(
        "div",
        { class: "hunch-command" },
        this.leading,
        this.input,
        this.conditions.root,
        this.stepper,
        submit,
        close,
      ),
      element(
        "div",
        { class: "hunch-toolbar" },
        this.mode,
        this.scope,
        this.scopeButton,
        this.combination,
        element("span", { class: "hunch-spacer" }),
        this.retryButton,
        this.refreshButton,
        this.threshold,
        this.themeButton,
      ),
      this.status,
      element("div", { class: "hunch-progress" }, this.progress),
    );
    this.paintMode();
    this.setTheme("auto");
    this.set({ counter: "" });
    submit.addEventListener("click", handlers.onSubmit);
    close.addEventListener("click", handlers.onClose);
    prev.addEventListener("click", () => handlers.onStep(-1));
    next.addEventListener("click", () => handlers.onStep(1));
    this.scopeButton.addEventListener("click", handlers.onScopeVisible);
    this.themeButton.addEventListener("click", handlers.onTheme);
    this.refreshButton.addEventListener("click", handlers.onRefresh);
    this.retryButton.addEventListener("click", handlers.onRetry);
    this.threshold.addEventListener("change", () => handlers.onThreshold(Number(this.threshold.value)));
    const pickMode = (value: SearchMode) => {
      if (value === this.modeValue) return;
      this.modeValue = value;
      this.paintMode();
      handlers.onChange();
      this.focus();
    };
    for (const button of this.modeButtons) {
      button.addEventListener("click", () => pickMode(button.dataset.value as SearchMode));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const other = this.modeButtons.find((b) => b !== button)!;
        pickMode(other.dataset.value as SearchMode);
        other.focus();
      });
    }
    this.scope.addEventListener("change", handlers.onScope);
    this.combination.addEventListener("change", handlers.onChange);
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) handlers.onClose();
    });
    this.input.addEventListener("input", (event) => {
      if (!(event as InputEvent).isComposing) handlers.onChange();
    });
    this.input.addEventListener("compositionend", handlers.onChange);
    this.input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Enter") return;
      event.preventDefault();
      if (event.shiftKey) handlers.onStep(-1);
      else handlers.onSubmit();
    });
  }

  controls(): SearchControls {
    return {
      query: this.input.value.trim(),
      mode: this.modeValue,
      scope: this.scope.value as SearchScope,
      combination: this.combination.value as Combination,
      conditions: this.conditions.values(),
    };
  }
  focus() {
    (this.modeValue === "conditions" ? this.conditions : this.input).focus();
  }
  private paintMode() {
    const conditional = this.modeValue === "conditions";
    for (const button of this.modeButtons) {
      const on = button.dataset.value === this.modeValue;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    this.root.classList.toggle("hunch-multiline", conditional);
    this.leading.hidden = conditional;
    this.input.hidden = conditional;
    this.conditions.root.hidden = !conditional;
    this.combination.hidden = !conditional;
  }
  setScopeVisible(on: boolean) {
    this.scopeButton.setAttribute("aria-pressed", String(on));
  }
  setTheme(theme: Theme) {
    const { icon: name, label } = THEMES[theme];
    this.themeButton.replaceChildren(icon(name));
    this.themeButton.title = `${label}（点击切换）`;
    this.themeButton.setAttribute("aria-label", label);
  }
  // `count` new blocks appeared since the last search; 0 hides the chip.
  setPending(count: number) {
    this.refreshButton.hidden = !count;
    this.refreshButton.lastElementChild!.textContent = count ? `新增 ${count}` : "";
    this.refreshButton.setAttribute("aria-label", `搜索新增的 ${count} 个文字块`);
  }
  setRetry(count: number) {
    this.retryButton.hidden = !count;
    this.retryButton.lastElementChild!.textContent = count ? `重试 ${count}` : "";
    this.retryButton.setAttribute("aria-label", `重新搜索失败的 ${count} 个文字块`);
  }
  setThreshold(value: number) {
    this.threshold.value = String(value);
  }
  // Briefly replaces the status line with a confirmation, then restores the search verdict.
  flash(message: string) {
    clearTimeout(this.flashTimer);
    if (!message) return this.paintVerdict(this.verdictState);
    this.paintVerdict({ text: message, tone: "none" });
    this.flashTimer = window.setTimeout(() => this.paintVerdict(this.verdictState), 2400);
  }
  private paintVerdict({ text, tone }: NonNullable<Status["verdict"]>) {
    this.verdict.textContent = text;
    this.verdict.className = `hunch-verdict hunch-${tone}`;
    this.paintStatus();
  }
  private paintStatus() {
    this.status.hidden = !this.verdict.textContent && !this.meta.textContent;
  }
  set(status: Status) {
    if (status.counter !== undefined) {
      this.counter.textContent = status.counter;
      this.stepper.hidden = !status.counter;
    }
    if (status.meta !== undefined) {
      this.meta.textContent = status.meta;
      this.paintStatus();
    }
    if (status.verdict) {
      clearTimeout(this.flashTimer);
      this.verdictState = status.verdict;
      this.paintVerdict(status.verdict);
    }
    if (status.progress) {
      const { done, total } = status.progress;
      this.progress.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
      this.progress.parentElement!.classList.toggle("hunch-active", total > 0 && done < total);
    }
  }
}
