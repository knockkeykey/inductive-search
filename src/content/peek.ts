import type { Excerpt } from "../shared/excerpts";
import { THRESHOLD } from "../shared/questions";
import { element } from "./element";
import type { Hit } from "./hits";
import { type IconName, icon } from "./icons";

function action(name: IconName, label: string, extra = "") {
  return element(
    "button",
    { type: "button", class: `hunch-action ${extra}`.trim(), title: label, "aria-label": label },
    icon(name),
  );
}

interface Handlers {
  onSave(hit: Hit): void;
  onCopyHit(hit: Hit): void;
  onCopyExcerpt(excerpt: Excerpt): void;
  onDelete(excerpt: Excerpt): void;
  onExport(): void;
  onCloseSaved(): void;
}

// A card that floats just above the command bar. It previews the current hit, or
// lists saved excerpts, so the page itself stays uncovered.
export class Peek {
  readonly root = element("section", { class: "hunch-peek hunch-material", "aria-live": "polite" });
  private readonly hitView = element("div", { class: "hunch-peek-hit" });
  private readonly savedView = element("div", { class: "hunch-peek-saved" });
  private readonly savedList = element("div", { class: "hunch-saved-list" });
  private readonly exportButton = action("download", "导出 Markdown");
  private excerpts: Excerpt[] = [];
  private hit: Hit | undefined;
  private conditions: string[] = [];
  private collapsed = false;
  private savedOpen = false;

  constructor(private readonly handlers: Handlers) {
    const closeSaved = action("xmark", "收起摘录");
    this.root.setAttribute("aria-label", "感应式搜索结果预览");
    this.savedView.append(
      element(
        "header",
        { class: "hunch-peek-header" },
        element("span", { class: "hunch-peek-title" }, "已存摘录"),
        this.exportButton,
        closeSaved,
      ),
      this.savedList,
    );
    this.root.append(this.hitView, this.savedView);
    this.exportButton.addEventListener("click", handlers.onExport);
    closeSaved.addEventListener("click", handlers.onCloseSaved);
    this.paint();
  }

  get isSavedOpen() {
    return this.savedOpen;
  }
  showSaved(open: boolean) {
    this.savedOpen = open;
    this.paint();
  }
  showHit(hit: Hit | undefined, conditions: string[] = this.conditions) {
    this.hit = hit;
    this.conditions = conditions;
    this.drawHit();
    this.paint();
  }
  setExcerpts(excerpts: Excerpt[]) {
    this.excerpts = excerpts;
    this.exportButton.disabled = !excerpts.length;
    this.drawSaved();
    this.drawHit();
  }

  private paint() {
    this.savedView.hidden = !this.savedOpen;
    this.hitView.hidden = this.savedOpen || !this.hit;
    this.root.hidden = this.savedView.hidden && this.hitView.hidden;
  }

  private drawHit() {
    const hit = this.hit;
    if (!hit) return this.hitView.replaceChildren();
    const copy = action("copy", "复制原文与来源");
    const already = this.excerpts.some((e) => e.url === location.href && e.text === hit.text);
    const save = action("bookmark", already ? "已保存" : "保存摘录", already ? "hunch-on" : "");
    save.disabled = already;
    const fold = action(this.collapsed ? "chevronUp" : "chevronDown", this.collapsed ? "展开预览" : "收起预览");
    fold.setAttribute("aria-expanded", String(!this.collapsed));
    copy.addEventListener("click", () => this.handlers.onCopyHit(hit));
    save.addEventListener("click", () => this.handlers.onSave(hit));
    fold.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.drawHit();
    });
    const body: Node[] = [];
    if (!this.collapsed) {
      body.push(element("p", { class: "hunch-excerpt-text" }, hit.text));
      if (hit.conditionScores.length)
        body.push(
          element(
            "ul",
            { class: "hunch-condition-evidence" },
            ...hit.conditionScores.map((p, i) =>
              element(
                "li",
                { class: p >= THRESHOLD ? "hunch-pass" : "" },
                `${p >= THRESHOLD ? "✓" : "·"} ${this.conditions[i] ?? "条件"} ${p.toFixed(2)}`,
              ),
            ),
          ),
        );
    }
    this.hitView.replaceChildren(
      element(
        "header",
        { class: "hunch-peek-header" },
        element(
          "span",
          { class: "hunch-score" },
          `${hit.conditionScores.length ? "条件" : "语义"} ${hit.p.toFixed(2)}`,
        ),
        element("span", { class: "hunch-peek-title" }, hit.heading || "相关原文"),
        copy,
        save,
        fold,
      ),
      ...body,
    );
  }

  private drawSaved() {
    if (!this.excerpts.length) {
      this.savedList.replaceChildren(
        element("p", { class: "hunch-empty" }, "还没有摘录。搜索后点击书签图标，原文和来源会保存在本机。"),
      );
      return;
    }
    this.savedList.replaceChildren(
      ...this.excerpts.map((excerpt) => {
        const source = element(
          "a",
          { href: excerpt.url, target: "_blank", rel: "noopener noreferrer", class: "hunch-source" },
          excerpt.title,
        );
        const copy = action("copy", "复制");
        const remove = action("trash", "删除", "hunch-destructive");
        copy.addEventListener("click", () => this.handlers.onCopyExcerpt(excerpt));
        remove.addEventListener("click", () => this.handlers.onDelete(excerpt));
        return element(
          "article",
          { class: "hunch-saved" },
          element(
            "header",
            { class: "hunch-saved-header" },
            source,
            element("time", { class: "hunch-saved-date" }, new Date(excerpt.createdAt).toLocaleDateString()),
            copy,
            remove,
          ),
          element("p", { class: "hunch-excerpt-text" }, excerpt.text),
        );
      }),
    );
  }
}
