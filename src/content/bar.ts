import type { Combination, SearchMode, SearchScope } from "../shared/protocol";
import { THRESHOLDS } from "../shared/ranking";
import { SENTENCE_THRESHOLD_MAX, SENTENCE_THRESHOLD_MIN, SENTENCE_THRESHOLD_STEP } from "../shared/sentences";
import { ConditionList } from "./condition-list";
import { element } from "./element";
import { icon } from "./icons";

export type Theme = "auto" | "light" | "dark";
const THEMES: Record<Theme, { icon: Parameters<typeof icon>[0]; label: string }> = {
  auto: { icon: "circleHalf", label: "自动" },
  light: { icon: "sun", label: "浅色" },
  dark: { icon: "moon", label: "深色" },
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
  onTheme(theme: Theme): void;
  onThreshold(value: number): void;
  onRefine(on: boolean): void;
  onSpotlight(on: boolean): void;
  onSentenceThreshold(value: number): void;
  onResetSettings(): void;
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
    element("button", { type: "button", role: "radio", "data-value": "semantic" }, "按问题"),
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
  // Status and errors share the toolbar's space between scope controls and settings.
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
  // Shown when the page grew after a search (infinite scroll, lazy sections).
  private readonly refreshButton = element(
    "button",
    { type: "button", class: "hunch-chip hunch-refresh", title: "只搜索页面新增的文字块", hidden: "" },
    icon("refresh"),
    element("span", { class: "hunch-chip-count" }, ""),
  );
  // Shown when some batches failed; re-sends only the blocks that got no score.
  private readonly retryButton = element(
    "button",
    { type: "button", class: "hunch-chip hunch-retry", title: "只重新搜索失败的文字块", hidden: "" },
    icon("refresh"),
    element("span", { class: "hunch-chip-count" }, ""),
  );
  private readonly settings = new SettingsPanel();
  readonly panel = this.settings.root;
  private verdictState: NonNullable<Status["verdict"]> = { text: "", tone: "none" };
  private flashTimer: number | undefined;

  constructor(handlers: BarHandlers) {
    this.conditions = new ConditionList({ onChange: handlers.onChange, onSubmit: handlers.onSubmit });
    this.scope.append(new Option("整页", "page"), new Option("仅正文", "article"), new Option("当前选区", "selection"));
    this.scope.value = "article";
    this.combination.append(new Option("全部满足", "all"), new Option("任一满足", "any"));
    this.combination.value = "any";
    const submit = element(
      "button",
      { type: "button", class: "hunch-submit", title: "搜索 (Enter)", "aria-label": "搜索" },
      icon("arrowUp"),
    );
    const prev = iconButton("chevronUp", "上一个结果 (↑ / Shift+Enter)");
    const next = iconButton("chevronDown", "下一个结果 (↓ / Enter)");
    const close = iconButton("xmark", "关闭 (Esc)", "hunch-close");
    this.stepper = element("span", { class: "hunch-stepper" }, prev, this.counter, next);
    this.root = element(
      "div",
      { class: "hunch-bar hunch-material", role: "search", "aria-label": "感应式查找工具栏" },
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
        this.status,
        this.retryButton,
        this.refreshButton,
        this.settings.button,
      ),
      element("div", { class: "hunch-progress" }, this.progress),
    );
    this.paintMode();
    this.set({ counter: "" });
    submit.addEventListener("click", handlers.onSubmit);
    close.addEventListener("click", handlers.onClose);
    prev.addEventListener("click", () => handlers.onStep(-1));
    next.addEventListener("click", () => handlers.onStep(1));
    this.scopeButton.addEventListener("click", handlers.onScopeVisible);
    this.refreshButton.addEventListener("click", handlers.onRefresh);
    this.retryButton.addEventListener("click", handlers.onRetry);
    this.settings.listen(handlers);
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
      else if (!event.ctrlKey && !event.metaKey && !event.altKey && !this.stepper.hidden) handlers.onStep(1);
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
    this.settings.setTheme(theme);
  }
  setRefine(on: boolean) {
    this.settings.setRefine(on);
  }
  setSpotlight(on: boolean) {
    this.settings.setSpotlight(on);
  }
  setSentenceThreshold(value: number) {
    this.settings.setSentenceThreshold(value);
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
    this.settings.setThreshold(value);
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

let uid = 0;

// Settings that change how results are judged and shown. It opens above the bar, inside the dock,
// so it moves with it. None of these settings sends a request on its own.
class SettingsPanel {
  readonly button = element(
    "button",
    {
      type: "button",
      class: "hunch-chip hunch-settings-toggle",
      title: "设置",
      "aria-label": "设置",
      "aria-expanded": "false",
      "aria-haspopup": "dialog",
    },
    icon("gear"),
  );
  private readonly threshold = element("input", {
    type: "range",
    class: "hunch-range",
    min: String(THRESHOLDS[0]),
    max: String(THRESHOLDS[THRESHOLDS.length - 1]),
    step: "0.1",
    "aria-label": "相关度阈值",
  });
  private readonly thresholdValue = element("output", { class: "hunch-range-value" });
  private readonly refine = element("input", { type: "checkbox", role: "switch", class: "hunch-switch" });
  private readonly spotlight = element("input", { type: "checkbox", role: "switch", class: "hunch-switch" });
  private readonly sentence = element("input", {
    type: "range",
    class: "hunch-range",
    min: String(SENTENCE_THRESHOLD_MIN),
    max: String(SENTENCE_THRESHOLD_MAX),
    step: String(SENTENCE_THRESHOLD_STEP),
    "aria-label": "句子阈值",
  });
  private readonly sentenceValue = element("output", { class: "hunch-range-value" });
  // Child of 段内精确定位: indented under it and dimmed while the switch is off.
  private readonly sentenceRow: HTMLElement;
  private readonly themeButtons = (Object.keys(THEMES) as Theme[]).map((theme) =>
    element(
      "button",
      { type: "button", role: "radio", "data-value": theme, "aria-label": `外观：${THEMES[theme].label}` },
      icon(THEMES[theme].icon),
      THEMES[theme].label,
    ),
  );
  private readonly helpButton = iconButton("question", "判断标准说明", "hunch-help-toggle");
  private readonly help: HTMLElement;
  private readonly resetButton = iconButton("reset", "恢复默认设置", "hunch-reset-toggle");
  private readonly confirmCancel = element("button", { type: "button" }, "取消");
  private readonly confirmOk = element("button", { type: "button", class: "hunch-danger" }, "恢复");
  private readonly confirm: HTMLElement;
  // Per-setting explanations, each toggled by the ? next to its label.
  private readonly notes: { button: HTMLButtonElement; note: HTMLElement }[] = [];
  readonly root: HTMLElement;
  private inside = false;

  constructor() {
    const id = `hunch-settings-${++uid}`;
    const explain = (name: string, about: string, lower: string, higher: string, child = false) => {
      const note = element(
        "div",
        { class: `hunch-note${child ? " hunch-note-child" : ""}`, id: `${id}-${name}-note`, hidden: "" },
        element("p", {}, about),
        element(
          "ul",
          {},
          element("li", {}, element("b", {}, "调低："), lower),
          element("li", {}, element("b", {}, "调高："), higher),
        ),
      );
      const button = iconButton("question", "这是什么？", "hunch-note-toggle");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", note.id);
      this.notes.push({ button, note });
      return { button, note };
    };
    const paragraphHelp = explain(
      "paragraph",
      "每个段落都会得到一个 0 到 1 的相关度分数，表示它有多像你要找的内容。只有分数达到这个值的段落才会被标出。",
      "结果更多，不容易漏掉，但会混进不太相关的段落。",
      "结果更少更准，但可能漏掉说法不同的相关段落。",
    );
    const sentenceHelp = explain(
      "sentence",
      "开启段内精确定位后，排名前 3 的段落会再逐句打分。分数达到这个值的句子会在段落中加深标出，帮你直接看到关键句。",
      "加深标出的句子更容易出现，但未必最贴切。",
      "只标出把握很大的句子，有时一句都不标。",
      true,
    );
    this.confirm = element(
      "div",
      { class: "hunch-confirm", hidden: "" },
      element(
        "div",
        {
          class: "hunch-confirm-card",
          role: "alertdialog",
          "aria-modal": "true",
          "aria-labelledby": `${id}-confirm-title`,
          "aria-describedby": `${id}-confirm-body`,
        },
        element("div", { class: "hunch-confirm-title", id: `${id}-confirm-title` }, "恢复默认设置？"),
        element(
          "div",
          { class: "hunch-confirm-body", id: `${id}-confirm-body` },
          "段落阈值、段内精确定位、句子阈值、聚光灯和外观都会恢复为默认值。",
        ),
        element("div", { class: "hunch-confirm-actions" }, this.confirmCancel, this.confirmOk),
      ),
    );
    this.help = element(
      "div",
      { class: "hunch-help", id: `${id}-help`, hidden: "" },
      element(
        "ol",
        {},
        element("li", {}, "段落分是模型判断「这段是不是你要找的内容」的概率，0 到 1，越高越相关。"),
        element(
          "li",
          {},
          "只显示分数不低于段落阈值的段落，或包含全部关键词的段落。阈值越低，结果越多，也越可能不相关。",
        ),
        element(
          "li",
          {},
          "段内精确定位会对前 3 条结果逐句再判断一次，分数不低于句子阈值的句子会加深标出，最多 2 句。不足 80 字或少于 3 句的段落、标题和表格不做。每条结果多一次请求。",
        ),
        element("li", {}, "调整阈值只重新筛选已有分数，不会重新请求。"),
      ),
    );
    this.helpButton.setAttribute("aria-expanded", "false");
    this.helpButton.setAttribute("aria-controls", this.help.id);
    const row = (label: string, ...controls: Node[]) =>
      element(
        "label",
        { class: "hunch-setting" },
        element("span", { class: "hunch-setting-label" }, label),
        ...controls,
      );
    // A <div>, not <label>: the ? button is labelable and would steal the label's clicks from the slider.
    this.sentenceRow = element(
      "div",
      { class: "hunch-setting hunch-setting-child" },
      element(
        "span",
        { class: "hunch-setting-label" },
        element("span", { class: "hunch-setting-name" }, "句子阈值", sentenceHelp.button),
        element("span", { class: "hunch-setting-hint" }, "开启段内精确定位后可调"),
      ),
      this.sentence,
      this.sentenceValue,
    );
    this.root = element(
      "div",
      {
        class: "hunch-settings hunch-material",
        role: "dialog",
        "aria-label": "设置",
        id,
        hidden: "",
      },
      element(
        "div",
        { class: "hunch-settings-head" },
        element("span", { class: "hunch-settings-title" }, "设置"),
        this.helpButton,
        this.resetButton,
      ),
      this.help,
      element(
        "div",
        { class: "hunch-setting" },
        element(
          "span",
          { class: "hunch-setting-label" },
          element("span", { class: "hunch-setting-name" }, "段落阈值", paragraphHelp.button),
        ),
        this.threshold,
        this.thresholdValue,
      ),
      paragraphHelp.note,
      element(
        "div",
        { class: "hunch-setting-group" },
        row("段内精确定位", this.refine),
        this.sentenceRow,
        sentenceHelp.note,
      ),
      row("聚光灯", this.spotlight),
      element(
        "div",
        { class: "hunch-setting" },
        element("span", { class: "hunch-setting-label" }, "外观"),
        element("div", { class: "hunch-segmented", role: "radiogroup", "aria-label": "外观" }, ...this.themeButtons),
      ),
      this.confirm,
    );
    this.button.setAttribute("aria-controls", id);
  }

  listen(handlers: BarHandlers) {
    this.button.addEventListener("click", () => this.toggle(this.root.hidden));
    this.helpButton.addEventListener("click", () => {
      const open = this.help.hidden;
      this.help.hidden = !open;
      this.helpButton.setAttribute("aria-expanded", String(open));
    });
    for (const { button, note } of this.notes) {
      button.addEventListener("click", () => {
        const open = note.hidden;
        note.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
      });
    }
    this.resetButton.addEventListener("click", () => this.ask(true));
    this.confirmCancel.addEventListener("click", () => this.ask(false));
    this.confirmOk.addEventListener("click", () => {
      this.ask(false);
      handlers.onResetSettings();
    });
    // Only the two buttons are focusable while confirming; Tab cycles between them.
    this.confirm.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.stopPropagation();
        this.ask(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        // event.target, not document.activeElement: focus inside the closed shadow root reports the host.
        (event.target === this.confirmOk ? this.confirmCancel : this.confirmOk).focus();
      }
    });
    this.confirm.addEventListener("pointerdown", (event) => {
      if (event.target === this.confirm) this.ask(false);
    });
    this.threshold.addEventListener("input", () => {
      this.paintThresholdValue();
      handlers.onThreshold(Number(this.threshold.value));
    });
    this.refine.addEventListener("change", () => handlers.onRefine(this.refine.checked));
    this.spotlight.addEventListener("change", () => handlers.onSpotlight(this.spotlight.checked));
    this.sentence.addEventListener("input", () => {
      this.paintSentenceValue();
      handlers.onSentenceThreshold(Number(this.sentence.value));
    });
    for (const button of this.themeButtons) {
      button.addEventListener("click", () => handlers.onTheme(button.dataset.value as Theme));
      button.addEventListener("keydown", (event) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const i = this.themeButtons.indexOf(button);
        const next = this.themeButtons[(i + step + this.themeButtons.length) % this.themeButtons.length]!;
        handlers.onTheme(next.dataset.value as Theme);
        next.focus();
      });
    }
    this.root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      this.toggle(false);
    });
    // Clicks inside the panel or on its button keep it open; any other click closes it.
    const mark = () => {
      this.inside = true;
    };
    this.root.addEventListener("pointerdown", mark);
    this.button.addEventListener("pointerdown", mark);
    window.addEventListener("pointerdown", () => {
      if (!this.inside && !this.root.hidden) this.toggle(false, false);
      this.inside = false;
    });
  }

  // Opens or dismisses the reset confirmation; Cancel takes focus so Enter can't reset by accident.
  private ask(open: boolean) {
    this.confirm.hidden = !open;
    if (open) this.confirmCancel.focus();
    else this.resetButton.focus();
  }
  private toggle(open: boolean, refocus = true) {
    this.confirm.hidden = true;
    this.root.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    this.button.setAttribute("aria-pressed", String(open));
    if (open) this.threshold.focus();
    else if (refocus) this.button.focus();
  }
  private paintThresholdValue() {
    this.thresholdValue.textContent = Number(this.threshold.value).toFixed(1);
  }
  private paintSentenceValue() {
    this.sentenceValue.textContent = Number(this.sentence.value).toFixed(2);
  }
  setThreshold(value: number) {
    this.threshold.value = String(value);
    this.paintThresholdValue();
  }
  setSpotlight(on: boolean) {
    this.spotlight.checked = on;
  }
  setRefine(on: boolean) {
    this.refine.checked = on;
    this.sentence.disabled = !on;
    this.sentenceRow.toggleAttribute("data-disabled", !on);
  }
  setSentenceThreshold(value: number) {
    this.sentence.value = String(value);
    this.paintSentenceValue();
  }
  setTheme(theme: Theme) {
    for (const button of this.themeButtons) {
      const on = button.dataset.value === theme;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    }
  }
}
