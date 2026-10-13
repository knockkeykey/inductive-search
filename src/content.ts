import browser from "webextension-polyfill";
import { FindBar } from "./content/bar";
import { captureSelection, extractBlocks, type PageBlock } from "./content/blocks";
import { clearPaint, type Hit, markCurrent, paint, rankHits } from "./content/hits";
import { ScrollMarks } from "./content/marks";
import { ResultsSidebar } from "./content/sidebar";
import { SelectionPopover } from "./content/selection-popover";
import {
  type Excerpt,
  type ExcerptDraft,
  type ExcerptRequest,
  type ExcerptResponse,
  excerptsMarkdown,
} from "./shared/excerpts";
import { type Progress, SEARCH_PORT, type Search, type SearchEvent, type TabMessage } from "./shared/protocol";
import { MAX_CONDITIONS } from "./shared/questions";

class Hunch {
  private readonly host = document.createElement("hunch-ui");
  private readonly shadow: ShadowRoot;
  private readonly bar = new FindBar({
    onSubmit: () => this.search(),
    onChange: () => this.changed(),
    onStep: (dir) => this.step(dir),
    onClose: () => this.close(),
    onPanel: () => this.setPanel(!this.panelOpen),
  });
  private readonly sidebar = new ResultsSidebar({
    onPick: (hit) => this.goTo(hit),
    onSave: (hit) => void this.save(hit),
    onCopyHit: (hit) => void this.copyHit(hit),
    onCopyExcerpt: (excerpt) => void this.copy(excerptsMarkdown([excerpt])),
    onDelete: (excerpt) => void this.deleteExcerpt(excerpt),
    onExport: () => this.export(),
    onLoadSaved: () => void this.loadExcerpts(),
    onClose: () => this.setPanel(false),
  });
  private readonly marks = new ScrollMarks((hit) => this.goTo(hit));
  private selectionPopover!: SelectionPopover;
  private blocks: PageBlock[] = [];
  private ranges: Range[] = [];
  private hits: Hit[] = [];
  private excerpts: Excerpt[] = [];
  private current: Hit | undefined;
  private request: Search | undefined;
  private port: browser.Runtime.Port | undefined;
  private panelOpen = true;

  constructor() {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = browser.runtime.getURL("ui.css");
    // Saved excerpts from other pages must not be readable through the host page's DOM.
    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.append(style, this.bar.root, this.sidebar.root, this.marks.root);
    this.selectionPopover = new SelectionPopover(this.shadow, this.host, {
      onAsk: (question, ranges) => this.askSelection(question, ranges),
    });
    new ResizeObserver(() =>
      this.host.style.setProperty("--hunch-bar-height", `${this.bar.root.getBoundingClientRect().height}px`),
    ).observe(this.bar.root);
    document.documentElement.appendChild(this.host);
    window.addEventListener("resize", () => this.marks.draw(this.hits, this.current));
    document.addEventListener("selectionchange", () => {
      const ranges = captureSelection();
      if (ranges.length) {
        this.ranges = ranges;
        if (this.bar.controls().scope === "selection") {
          const characters = ranges.reduce((count, range) => count + range.toString().length, 0);
          this.bar.set({
            verdict: { text: `已选中 ${characters} 个字符，可搜索当前选区。`, tone: "none" },
          });
        }
      }
      this.selectionPopover.selectionChanged(ranges);
    });
  }
  get isOpen() {
    return this.host.classList.contains("hunch-open");
  }
  open() {
    const ranges = captureSelection();
    if (ranges.length) this.ranges = ranges;
    this.host.classList.add("hunch-open");
    this.setPanel(true);
    this.changed();
    this.bar.focus();
    void this.loadExcerpts();
  }
  close() {
    this.host.classList.remove("hunch-open");
    this.selectionPopover.hide();
    this.abort();
    this.reset();
  }
  private setPanel(open: boolean) {
    this.panelOpen = open;
    this.sidebar.root.hidden = !open;
    this.host.classList.toggle("hunch-panel-open", open);
    this.bar.setPanelOpen(open);
  }
  private reset() {
    clearPaint();
    this.hits = [];
    this.current = undefined;
    this.marks.draw([], undefined);
    this.bar.set({
      counter: "",
      meta: `${this.blocks.length} 个文字块`,
      verdict: { text: "", tone: "none" },
      progress: { done: 0, total: 0 },
    });
    this.sidebar.setResults([], undefined, [], "输入问题或条件，再点击搜索。摘录可以在“已存摘录”中查看。");
  }
  private changed() {
    this.abort();
    this.request = undefined;
    const controls = this.bar.controls();
    this.blocks = extractBlocks(controls.scope, this.ranges);
    this.reset();
  }
  private askSelection(question: string, ranges: readonly Range[]) {
    this.ranges = [...ranges];
    this.bar.setQuestionForSelection(question);
    this.open();
    this.search();
  }
  private search() {
    if (!this.isOpen) return;
    const controls = this.bar.controls();
    this.abort();
    if (controls.mode === "semantic" && !controls.query) return this.error("请输入要查找的问题。");
    if (
      controls.mode === "conditions" &&
      (!controls.conditions.length || controls.conditions.length > MAX_CONDITIONS)
    ) {
      return this.error(`请输入 1–${MAX_CONDITIONS} 个条件，每行一个。`);
    }
    if (controls.conditions.some((condition) => condition.length > 500)) return this.error("每个条件最多 500 个字符。");
    this.blocks = extractBlocks(controls.scope, this.ranges);
    this.reset();
    if (!this.blocks.length)
      return this.error(
        controls.scope === "selection"
          ? "没有可搜索的选区。请先选中网页正文。"
          : "这个范围没有可提取的文字，请尝试整页搜索。",
      );
    const req: Search = {
      url: location.href,
      title: document.title,
      blocks: this.blocks.map(({ id, text }) => ({ id, text })),
      ...controls,
      query: controls.mode === "conditions" ? controls.conditions.join("；") : controls.query,
    };
    this.request = req;
    this.setPanel(true);
    this.sidebar.showSaved(false);
    this.bar.set({ verdict: { text: "正在搜索…", tone: "busy" }, progress: { done: 0, total: 1 } });
    this.sidebar.setResults([], undefined, req.conditions ?? [], "正在寻找符合条件的原文…");
    try {
      const port = browser.runtime.connect({ name: SEARCH_PORT });
      this.port = port;
      port.onMessage.addListener((event: unknown) => {
        if (this.port === port) this.render(event as SearchEvent);
      });
      port.onDisconnect.addListener(() => {
        if (this.port === port) {
          this.port = undefined;
          this.error("搜索连接已断开，请重新搜索。扩展更新后请刷新网页。");
        }
      });
      port.postMessage(req);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
  }
  private abort() {
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
  }
  private error(message: string) {
    this.bar.set({ verdict: { text: message, tone: "error" }, progress: { done: 0, total: 0 } });
    this.sidebar.tell(message);
  }
  private render(event: SearchEvent) {
    if (event.type === "failure") return this.error(event.message);
    this.hits = rankHits(this.blocks, event.scores, event.conditionScores);
    paint(this.hits);
    this.current = this.hits.find((hit) => hit.id === this.current?.id);
    const finished = event.done === event.total;
    const empty = event.failed
      ? "部分段落未完成搜索，结果可能不完整。请重试。"
      : finished
        ? "没有高相关结果。试试更具体的问题或调整筛选条件。"
        : "正在搜索，结果会逐步显示。";
    this.sidebar.setResults(
      this.hits,
      this.current,
      this.request?.mode === "conditions" ? (this.request.conditions ?? []) : [],
      empty,
    );
    if (finished && !this.current && this.hits[0]) this.goTo(this.hits[0]);
    this.bar.set(this.status(event));
    this.marks.draw(this.hits, this.current);
  }
  private status(progress: Progress) {
    const finished = progress.done === progress.total;
    const count = this.hits.length;
    const text = !finished
      ? "正在搜索…"
      : progress.failed
        ? `部分搜索失败，已找到 ${count} 段`
        : count
          ? `找到 ${count} 段相关原文`
          : "没有高相关结果";
    return {
      verdict: { text, tone: !finished ? "busy" : progress.failed ? "error" : count ? "found" : "absent" },
      meta: `${progress.ms} 毫秒 · ${progress.done}/${progress.total} 批次${progress.failed ? ` · ${progress.failed} 失败` : ""}`,
      progress: { done: progress.done, total: progress.total },
      counter: this.counterText(),
    } as const;
  }
  private counterText() {
    return this.current ? `${this.hits.indexOf(this.current) + 1} / ${this.hits.length}` : `${this.hits.length} 个结果`;
  }
  private step(dir: 1 | -1) {
    if (!this.hits.length) return;
    const index = this.current ? this.hits.indexOf(this.current) : dir === 1 ? -1 : 0;
    this.goTo(this.hits[(index + dir + this.hits.length) % this.hits.length]!);
  }
  private goTo(hit: Hit) {
    if (!hit.el.isConnected) return this.sidebar.tell("网页内容已变化，请重新搜索。");
    markCurrent(this.current, hit);
    this.current = hit;
    this.bar.set({ counter: this.counterText() });
    this.sidebar.setCurrent(hit);
    this.marks.draw(this.hits, this.current);
  }
  private draft(hit: Hit): ExcerptDraft {
    return {
      title: this.request?.title ?? document.title,
      url: this.request?.url ?? location.href,
      text: hit.text,
      heading: hit.heading,
      query: this.request?.query ?? "",
      conditions: this.request?.mode === "conditions" ? (this.request.conditions ?? []) : [],
      combination: this.request?.combination ?? "all",
      scope: this.request?.scope ?? "page",
    };
  }
  private async excerptRequest(message: ExcerptRequest) {
    const response = (await browser.runtime.sendMessage(message)) as ExcerptResponse;
    if (!response?.ok) throw new Error(response?.error ?? "无法读取本地摘录，请刷新网页后重试。");
    this.excerpts = response.excerpts;
    this.sidebar.setExcerpts(this.excerpts);
  }
  private async loadExcerpts() {
    try {
      await this.excerptRequest({ type: "excerpt-list" });
    } catch (error) {
      this.sidebar.tell(error instanceof Error ? error.message : String(error));
    }
  }
  private async save(hit: Hit) {
    try {
      await this.excerptRequest({ type: "excerpt-save", excerpt: this.draft(hit) });
      this.sidebar.tell("已保存原文、标题、网址和搜索条件。");
    } catch (error) {
      this.sidebar.tell(error instanceof Error ? error.message : String(error));
    }
  }
  private async deleteExcerpt(excerpt: Excerpt) {
    try {
      await this.excerptRequest({ type: "excerpt-delete", id: excerpt.id });
      this.sidebar.tell("摘录已删除。");
    } catch (error) {
      this.sidebar.tell(error instanceof Error ? error.message : String(error));
    }
  }
  private async copyHit(hit: Hit) {
    const draft = this.draft(hit);
    await this.copy(
      `${draft.text}\n\n来源：${draft.title}\n${draft.url}${draft.heading ? `\n所在标题：${draft.heading}` : ""}`,
    );
  }
  private async copy(text: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        this.shadow.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("复制失败，请使用导出 Markdown。");
      }
      this.sidebar.tell("已复制原文与来源。");
    } catch {
      this.sidebar.tell("复制失败，请使用导出 Markdown。");
    }
  }
  private export() {
    if (!this.excerpts.length) return this.sidebar.tell("还没有可导出的摘录。");
    const url = URL.createObjectURL(
      new Blob([excerptsMarkdown(this.excerpts)], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `inductive-search-excerpts-${new Date().toISOString().slice(0, 10)}.md`;
    this.shadow.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.sidebar.tell(`已导出 ${this.excerpts.length} 条摘录。`);
  }
}

declare global {
  interface Window {
    __hunchLoaded?: boolean;
  }
}
if (!window.__hunchLoaded) {
  window.__hunchLoaded = true;
  const hunch = new Hunch();
  browser.runtime.onMessage.addListener((message: unknown) => {
    switch ((message as TabMessage).type) {
      case "ping":
        return Promise.resolve(true);
      case "toggle":
        hunch.isOpen ? hunch.close() : hunch.open();
    }
  });
}
