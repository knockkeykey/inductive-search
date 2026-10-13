import type { Excerpt } from "../shared/excerpts";
import { THRESHOLD } from "../shared/questions";
import { element } from "./element";
import type { Hit } from "./hits";

interface Handlers {
  onPick(hit: Hit): void;
  onSave(hit: Hit): void;
  onCopyHit(hit: Hit): void;
  onCopyExcerpt(excerpt: Excerpt): void;
  onDelete(excerpt: Excerpt): void;
  onExport(): void;
  onLoadSaved(): void;
  onClose(): void;
}

export class ResultsSidebar {
  readonly root = element("aside", { class: "hunch-sidebar", "aria-label": "感应式搜索结果与摘录" });
  private readonly results = element("div", { class: "hunch-result-list" });
  private readonly saved = element("div", { class: "hunch-result-list" });
  private readonly resultTab = element("button", { type: "button", "aria-pressed": "true" }, "搜索结果");
  private readonly savedTab = element("button", { type: "button", "aria-pressed": "false" }, "已存摘录");
  private readonly notice = element("div", { class: "hunch-notice", role: "status", "aria-live": "polite" });
  private readonly exportButton = element("button", { type: "button", class: "hunch-export" }, "导出 Markdown");
  private excerpts: Excerpt[] = [];
  private hits: Hit[] = [];
  private current: Hit | undefined;
  private conditions: string[] = [];
  private empty = "输入问题或条件，再点击搜索。";

  constructor(private readonly handlers: Handlers) {
    const close = element("button", { type: "button", class: "hunch-close", "aria-label": "收起侧边栏" }, "✕");
    this.root.append(
      element(
        "div",
        { class: "hunch-sidebar-title" },
        element("strong", {}, "感应式搜索"),
        element("span", {}, "原文查找与摘录"),
        close,
      ),
      element("div", { class: "hunch-tabs" }, this.resultTab, this.savedTab),
      this.notice,
      this.results,
      this.saved,
      this.exportButton,
      element("div", { class: "hunch-sidebar-footer" }, "基于 tymscar/Hunch · 中文增强版"),
    );
    this.saved.hidden = true;
    this.exportButton.hidden = true;
    close.addEventListener("click", handlers.onClose);
    this.resultTab.addEventListener("click", () => this.showSaved(false));
    this.savedTab.addEventListener("click", () => {
      this.showSaved(true);
      handlers.onLoadSaved();
    });
    this.exportButton.addEventListener("click", handlers.onExport);
  }

  showSaved(saved: boolean) {
    this.results.hidden = saved;
    this.saved.hidden = !saved;
    this.exportButton.hidden = !saved;
    this.resultTab.setAttribute("aria-pressed", String(!saved));
    this.savedTab.setAttribute("aria-pressed", String(saved));
  }
  setResults(hits: Hit[], current: Hit | undefined, conditions: string[], empty: string) {
    this.hits = hits;
    this.current = current;
    this.conditions = conditions;
    this.empty = empty;
    this.drawResults();
  }
  setCurrent(hit: Hit) {
    this.current = hit;
    this.drawResults();
  }
  setExcerpts(excerpts: Excerpt[]) {
    this.excerpts = excerpts;
    this.savedTab.textContent = `已存摘录 (${excerpts.length})`;
    this.exportButton.disabled = !excerpts.length;
    this.drawSaved();
    this.drawResults();
  }
  tell(message: string) {
    this.notice.textContent = message;
  }

  private drawResults() {
    if (!this.hits.length) {
      this.results.replaceChildren(element("p", { class: "hunch-empty" }, this.empty));
      return;
    }
    this.results.replaceChildren(
      ...this.hits.map((hit, index) => {
        const row = element("section", {
          class: `hunch-result${hit.id === this.current?.id ? " hunch-selected" : ""}`,
        });
        const pick = element(
          "button",
          { type: "button", class: "hunch-result-pick" },
          element("span", { class: "hunch-result-heading" }, hit.heading || `文字块 ${index + 1}`),
          element(
            "span",
            { class: "hunch-score" },
            `${hit.conditionScores.length ? "条件分数" : "语义评分"} ${hit.p.toFixed(2)}`,
          ),
          element("span", { class: "hunch-excerpt-text" }, hit.text),
        );
        pick.addEventListener("click", () => this.handlers.onPick(hit));
        row.append(pick);
        if (hit.conditionScores.length)
          row.append(
            element(
              "ul",
              { class: "hunch-condition-evidence" },
              ...hit.conditionScores.map((p, i) =>
                element("li", {}, `${p >= THRESHOLD ? "✓" : "·"} ${this.conditions[i] ?? "条件"} (${p.toFixed(2)})`),
              ),
            ),
          );
        const copy = element("button", { type: "button" }, "复制原文与来源");
        const already = this.excerpts.some((e) => e.url === location.href && e.text === hit.text);
        const save = element("button", { type: "button" }, already ? "已保存" : "保存摘录");
        save.disabled = already;
        copy.addEventListener("click", () => this.handlers.onCopyHit(hit));
        save.addEventListener("click", () => this.handlers.onSave(hit));
        row.append(element("div", { class: "hunch-result-actions" }, copy, save));
        return row;
      }),
    );
  }

  private drawSaved() {
    if (!this.excerpts.length) {
      this.saved.replaceChildren(
        element("p", { class: "hunch-empty" }, "还没有摘录。搜索后点击“保存摘录”，原文和来源会保存在本机。"),
      );
      return;
    }
    this.saved.replaceChildren(
      ...this.excerpts.map((excerpt) => {
        const source = element(
          "a",
          { href: excerpt.url, target: "_blank", rel: "noopener noreferrer", class: "hunch-source" },
          excerpt.title,
        );
        const copy = element("button", { type: "button" }, "复制");
        const remove = element("button", { type: "button" }, "删除");
        copy.addEventListener("click", () => this.handlers.onCopyExcerpt(excerpt));
        remove.addEventListener("click", () => this.handlers.onDelete(excerpt));
        return element(
          "section",
          { class: "hunch-result" },
          source,
          element("p", { class: "hunch-excerpt-text" }, excerpt.text),
          element("p", { class: "hunch-saved-date" }, new Date(excerpt.createdAt).toLocaleString()),
          element("div", { class: "hunch-result-actions" }, copy, remove),
        );
      }),
    );
  }
}
