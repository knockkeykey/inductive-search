import browser from "webextension-polyfill";
import { FindBar, type Theme } from "./content/bar";
import { captureSelection, extractBlocks, type PageBlock } from "./content/blocks";
import { CopyButton } from "./content/copy-button";
import { Dock } from "./content/dock";
import { clearPaint, type Hit, markCurrent, paint, rankHits } from "./content/hits";
import { ScrollMarks } from "./content/marks";
import { ScopeFrame } from "./content/scope-frame";
import { clearSentences, paintSentences, sentenceRanges } from "./content/sentence-marks";
import {
  type BlockId,
  blockId,
  type Progress,
  type Refine,
  type RefineResult,
  SEARCH_PORT,
  type Search,
  type SearchEvent,
  type TabMessage,
} from "./shared/protocol";
import { MAX_CONDITIONS } from "./shared/questions";
import { keywordTerms, validThreshold } from "./shared/ranking";
import {
  pickSentences,
  REFINE_TOP,
  refinableSentences,
  SENTENCE_THRESHOLD,
  type Sentence,
  type SentenceId,
  validSentenceThreshold,
} from "./shared/sentences";

const THEME_ORDER: Theme[] = ["auto", "light", "dark"];
const HEADING = /^H[1-6]$/;
// Wait for a burst of DOM changes (infinite scroll, lazy sections) to settle before re-reading.
const GROWTH_DEBOUNCE_MS = 800;
// Chrome stops an idle service worker after ~30 s and cuts its ports; a port message resets that timer.
const KEEPALIVE_MS = 20_000;
// In the extension's document viewer, results cite the PDF / Word source rather
// than viewer.html. Only the extension's own pages may set it, so web pages can't spoof a source.
const inViewer = location.origin === new URL(browser.runtime.getURL("")).origin;
const pageUrl = () =>
  (inViewer && document.querySelector<HTMLMetaElement>("meta[name='hunch-source']")?.content) || location.href;
interface UiPrefs {
  theme: Theme;
  showScope: boolean;
  threshold: number;
  // Second pass that scores sentences inside the top hits.
  refine: boolean;
  sentenceThreshold: number;
}
// Sentence scores for one hit; `scores` stays empty when the request failed.
interface Refined {
  sentences: Sentence[];
  scores: Partial<Record<SentenceId, number>>;
}

class Hunch {
  private readonly host = document.createElement("hunch-ui");
  private readonly shadow: ShadowRoot;
  private readonly bar = new FindBar({
    onSubmit: () => this.search(),
    onChange: () => this.changed(),
    onScope: () => this.rescope(),
    onRefresh: () => this.searchNew(),
    onStep: (dir) => this.step(dir),
    onClose: () => this.close(),
    onThreshold: (threshold) => this.setPrefs({ threshold }),
    onRetry: () => this.retry(),
    onScopeVisible: () => this.setPrefs({ showScope: !this.prefs.showScope }),
    onTheme: (theme) => this.setPrefs({ theme }),
    onRefine: (refine) => this.setPrefs({ refine }),
    onSentenceThreshold: (sentenceThreshold) => this.setPrefs({ sentenceThreshold }),
  });
  private readonly scopeFrame = new ScopeFrame();
  private prefs: UiPrefs = {
    theme: "auto",
    showScope: true,
    threshold: validThreshold(undefined),
    refine: true,
    sentenceThreshold: SENTENCE_THRESHOLD,
  };
  // Keyed by block id and text, since one element can hold several split blocks.
  private refined = new Map<string, Refined | "pending">();
  // Bumped whenever results are invalidated, so late sentence scores from an old search are dropped.
  private generation = 0;
  private readonly marks = new ScrollMarks((hit) => this.goTo(hit));
  private readonly copyButton = new CopyButton((ok) =>
    this.bar.flash(ok ? "已复制段落。" : "复制失败，请手动选中文字复制。"),
  );
  private blocks: PageBlock[] = [];
  private ranges: Range[] = [];
  private hits: Hit[] = [];
  private current: Hit | undefined;
  private request: Search | undefined;
  private port: browser.Runtime.Port | undefined;
  private searching = false;
  private keepalive: number | undefined;
  // Scores from finished batches; an incremental search adds to them instead of starting over.
  private scores: Record<BlockId, number> = {};
  private conditionScores: Record<BlockId, number[]> = {};
  private base: { scores: Record<BlockId, number>; conditionScores: Record<BlockId, number[]> } = {
    scores: {},
    conditionScores: {},
  };
  private pending: PageBlock[] = [];
  // Literal terms from the query; blocks containing all of them are shown even with a low score.
  private terms: string[] = [];
  // Ids in the latest request, and those that came back without a score because a batch failed.
  private sent: BlockId[] = [];
  private failed: BlockId[] = [];
  private lastProgress: Progress | undefined;
  private growthTimer: number | undefined;
  private readonly observer = new MutationObserver((records) => {
    if (records.some((record) => !this.host.contains(record.target))) this.scheduleGrowthCheck();
  });
  // Blocks read by the cross-tab search page, kept so a clicked result can be revealed later.
  // Settles once ui.css and the saved theme are in, so the first open never paints unstyled.
  private readonly ready: Promise<void>;

  constructor() {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = browser.runtime.getURL("ui.css");
    const styled = new Promise<void>((resolve) => {
      style.addEventListener("load", () => resolve(), { once: true });
      style.addEventListener("error", () => resolve(), { once: true });
    });
    // The <link> loads asynchronously; keep the host hidden until it has, or its content flashes unstyled.
    this.host.style.display = "none";
    // Keep the search UI out of reach of the host page's scripts.
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const dock = new Dock(this.bar.root);
    this.bar.root.prepend(dock.grabber);
    // After the bar in the DOM (and in tab order); CSS order places it above.
    dock.root.append(this.bar.panel);
    this.shadow.append(style, this.scopeFrame.root, this.copyButton.root, dock.root, this.marks.root);
    document.documentElement.appendChild(this.host);
    this.ready = Promise.all([styled, this.loadPrefs()]).then(() => {
      this.host.style.removeProperty("display");
    });
    window.addEventListener("resize", () => this.marks.draw(this.hits, this.current));
    // Single-page apps change the URL without reloading; history events catch what mutations may miss.
    window.addEventListener("popstate", () => this.scheduleGrowthCheck());
    window.addEventListener("hashchange", () => this.scheduleGrowthCheck());
    document.addEventListener("selectionchange", () => {
      const ranges = captureSelection();
      if (ranges.length) {
        this.ranges = ranges;
        if (this.bar.controls().scope === "selection") {
          const characters = ranges.reduce((count, range) => count + range.toString().length, 0);
          this.bar.set({
            verdict: { text: `已选中 ${characters} 个字符，可搜索当前选区。`, tone: "none" },
          });
          this.paintScope();
        }
      }
    });
  }
  get isOpen() {
    return this.host.classList.contains("hunch-open");
  }
  async open() {
    await this.ready;
    if (this.isOpen) return;
    const ranges = captureSelection();
    if (ranges.length) this.ranges = ranges;
    // The page may have switched its own theme since the last open.
    this.applyTheme();
    this.host.classList.add("hunch-open");
    this.rescope();
    this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    this.bar.focus();
  }
  close() {
    this.host.classList.remove("hunch-open");
    this.observer.disconnect();
    clearTimeout(this.growthTimer);
    this.scopeFrame.hide();
    this.abort();
    this.reset();
  }
  private async loadPrefs() {
    try {
      const stored = (await browser.storage?.local.get("ui")) as { ui?: Partial<UiPrefs> } | undefined;
      const ui = stored?.ui;
      this.applyPrefs({
        theme: ui?.theme && THEME_ORDER.includes(ui.theme) ? ui.theme : "auto",
        showScope: ui?.showScope !== false,
        threshold: validThreshold(ui?.threshold),
        refine: ui?.refine !== false,
        sentenceThreshold: validSentenceThreshold(ui?.sentenceThreshold),
      });
    } catch {
      this.applyPrefs(this.prefs);
    }
  }
  private setPrefs(patch: Partial<UiPrefs>) {
    this.applyPrefs({ ...this.prefs, ...patch });
    void browser.storage?.local.set({ ui: this.prefs }).catch(() => {});
  }
  private applyPrefs(prefs: UiPrefs) {
    const changed = this.prefs.threshold !== prefs.threshold;
    const resentence = this.prefs.refine !== prefs.refine || this.prefs.sentenceThreshold !== prefs.sentenceThreshold;
    this.prefs = prefs;
    this.applyTheme();
    this.bar.setTheme(prefs.theme);
    this.bar.setScopeVisible(prefs.showScope);
    this.bar.setThreshold(prefs.threshold);
    this.bar.setRefine(prefs.refine);
    this.bar.setSentenceThreshold(prefs.sentenceThreshold);
    if (changed && this.request) this.rerank();
    else if (resentence) this.refineTop();
    this.paintScope();
  }
  // 自动 contrasts with the page, not the system: a light site gets the dark bar so it stands off the content.
  private applyTheme() {
    this.host.dataset.theme =
      this.prefs.theme === "auto" ? (pageTheme() === "light" ? "dark" : "light") : this.prefs.theme;
  }
  // Outlines the search range for as long as the bottom bar is up.
  private paintScope() {
    if (this.isOpen && this.prefs.showScope) this.scopeFrame.show(this.bar.controls().scope, this.ranges);
    else this.scopeFrame.hide();
  }
  private reset() {
    clearPaint();
    clearSentences();
    this.refined.clear();
    this.generation++;
    this.hits = [];
    this.current = undefined;
    this.scores = {};
    this.conditionScores = {};
    this.base = { scores: {}, conditionScores: {} };
    this.terms = [];
    this.lastProgress = undefined;
    this.setFailed([]);
    this.setPending([]);
    this.marks.draw([], undefined);
    this.copyButton.update([], undefined);
    this.bar.set({
      counter: "",
      meta: "",
      verdict: { text: "", tone: "none" },
      progress: { done: 0, total: 0 },
    });
  }
  // Typing only invalidates results. Reading the page is expensive, so it waits for submit.
  private changed() {
    this.abort();
    this.request = undefined;
    this.reset();
    this.paintScope();
  }
  private rescope() {
    this.abort();
    this.request = undefined;
    this.blocks = extractBlocks(this.bar.controls().scope, this.ranges);
    this.reset();
    this.paintScope();
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
      url: pageUrl(),
      title: document.title,
      blocks: this.blocks.map(({ id, text }) => ({ id, text })),
      ...controls,
      query: controls.mode === "conditions" ? controls.conditions.join("；") : controls.query,
    };
    this.request = req;
    this.terms = controls.mode === "semantic" ? keywordTerms(controls.query) : [];
    // Literal matches are local, so they show up before the first batch returns.
    if (this.terms.length) this.rerank();
    this.send(req.blocks);
  }
  private send(blocks: Search["blocks"]) {
    const req = this.request;
    if (!req) return;
    this.abort();
    this.sent = blocks.map((block) => block.id);
    this.setFailed([]);
    this.searching = true;
    this.bar.set({ verdict: { text: "正在搜索…", tone: "busy" }, progress: { done: 0, total: 1 } });
    try {
      const port = browser.runtime.connect({ name: SEARCH_PORT });
      this.port = port;
      port.onMessage.addListener((event: unknown) => {
        if (this.port === port) this.render(event as SearchEvent);
      });
      // A finished search closes its own port (see finish), so this only fires mid-search:
      // the background was stopped, or the extension was reloaded under this page.
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.finish();
        const reason = browser.runtime.lastError?.message;
        this.error(
          browser.runtime.id
            ? `搜索连接中断${reason ? `（${reason}）` : ""}，已保留收到的结果，可点“重试”补搜其余文字块。`
            : "扩展已更新或重新加载，请刷新网页后再搜索。",
        );
      });
      port.postMessage({ ...req, blocks });
      this.keepalive = window.setInterval(() => port.postMessage({ type: "keepalive" }), KEEPALIVE_MS);
    } catch (error) {
      this.finish();
      this.error(
        browser.runtime?.id
          ? error instanceof Error
            ? error.message
            : String(error)
          : "扩展已更新或重新加载，请刷新网页后再搜索。",
      );
    }
  }
  // Closes the port of the current search. Leaving it open after the last batch let Chrome
  // cut it when the idle service worker stopped, which surfaced as a bogus "disconnected" error.
  private finish() {
    clearInterval(this.keepalive);
    this.keepalive = undefined;
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
  }
  private abort() {
    this.finish();
    if (this.searching) {
      this.searching = false;
      this.base = { scores: this.scores, conditionScores: this.conditionScores };
    }
  }
  private setPending(blocks: PageBlock[]) {
    this.pending = blocks;
    this.bar.setPending(blocks.length);
  }
  private scheduleGrowthCheck() {
    if (!this.isOpen) return;
    clearTimeout(this.growthTimer);
    this.growthTimer = window.setTimeout(() => this.checkGrowth(), GROWTH_DEBOUNCE_MS);
  }
  // Finds text that appeared after the last search. It only offers a follow-up search:
  // spending API requests on every DOM change would be costly and surprising.
  private checkGrowth() {
    if (!this.isOpen) return;
    const req = this.request;
    if (req && req.url !== pageUrl()) {
      this.rescope();
      return this.bar.set({ verdict: { text: "网页已切换，请重新搜索。", tone: "none" } });
    }
    const scope = this.bar.controls().scope;
    if (scope === "selection") return;
    if (!req) {
      this.blocks = extractBlocks(scope, this.ranges);
      return;
    }
    if (this.searching || req.scope !== scope) return;
    const known = new Map<HTMLElement, Set<string>>();
    for (const block of this.blocks) {
      const texts = known.get(block.el) ?? new Set<string>();
      texts.add(block.text);
      known.set(block.el, texts);
    }
    this.setPending(extractBlocks(scope, this.ranges).filter((block) => !known.get(block.el)?.has(block.text)));
  }
  private searchNew() {
    if (!this.request || this.searching || !this.pending.length) return;
    // Continue the numbering so new ids never collide with scored blocks.
    const added = this.pending.map((block, i) => ({ ...block, id: blockId(this.blocks.length + i + 1) }));
    this.blocks = [...this.blocks.filter((block) => block.el.isConnected), ...added];
    this.setPending([]);
    this.send(added.map(({ id, text }) => ({ id, text })));
  }
  private setFailed(ids: BlockId[]) {
    this.failed = ids;
    this.bar.setRetry(ids.length);
  }
  // Re-sends only blocks whose batch failed; scores already received are kept and merged.
  private retry() {
    if (!this.request || this.searching) return;
    const failed = new Set(this.failed);
    const blocks = this.blocks.filter((block) => failed.has(block.id) && block.el.isConnected);
    if (!blocks.length) return this.setFailed([]);
    this.send(blocks.map(({ id, text }) => ({ id, text })));
  }
  private rerank() {
    this.hits = rankHits(this.blocks, this.scores, this.conditionScores, {
      threshold: this.prefs.threshold,
      terms: this.terms,
    });
    paint(this.hits, this.prefs.threshold);
    this.refineTop();
    this.current = this.hits.find((hit) => hit.id === this.current?.id);
    // Wait for model scores before jumping: early keyword-only hits rank below model hits.
    if (!this.current && !this.searching && this.lastProgress && this.hits[0]) this.goTo(this.hits[0]);
    this.marks.draw(this.hits, this.current);
    this.copyButton.update(this.hits, this.current);
    if (this.lastProgress) this.bar.set(this.status(this.lastProgress));
    else this.bar.set({ counter: this.counterText() });
  }
  // Scores sentences inside the top hits once their paragraph scores are final, then marks the best ones.
  // Cached per block, so threshold changes only repaint; a hit new to the top 3 is scored then.
  private refineTop() {
    const req = this.request;
    if (!req || !this.prefs.refine || req.mode === "conditions" || req.scope === "selection") {
      return clearSentences();
    }
    const top = this.hits.filter((hit) => !HEADING.test(hit.el.tagName) && hit.p >= this.prefs.threshold);
    const generation = this.generation;
    for (const hit of top.slice(0, REFINE_TOP)) {
      const key = `${hit.id}\u0000${hit.text}`;
      if (this.refined.has(key) || !(hit.id in this.scores)) continue;
      // Table rows join cells with " | "; their sentences don't map back to the row's text.
      if (hit.el.matches("tr") || getComputedStyle(hit.el).display === "table-row") continue;
      const sentences = refinableSentences(hit.text);
      if (!sentences.length) continue;
      this.refined.set(key, "pending");
      const message: Refine = {
        type: "refine",
        url: req.url,
        title: req.title,
        query: req.query,
        text: hit.text,
        sentences: sentences.map(({ id, text }) => ({ id, text })),
      };
      Promise.resolve(browser.runtime.sendMessage(message) as Promise<RefineResult | undefined>)
        .catch(() => undefined)
        .then((result) => {
          if (generation !== this.generation) return;
          this.refined.set(key, { sentences, scores: result?.scores ?? {} });
          this.paintRefined();
        });
    }
    this.paintRefined();
  }
  private paintRefined() {
    if (!this.prefs.refine) return clearSentences();
    const ranges: Range[] = [];
    for (const hit of this.hits.slice(0, REFINE_TOP * 2)) {
      const entry = this.refined.get(`${hit.id}\u0000${hit.text}`);
      if (!entry || entry === "pending") continue;
      const picked = pickSentences(entry.sentences, entry.scores, this.prefs.sentenceThreshold);
      ranges.push(...sentenceRanges(hit.el, hit.text, picked));
    }
    paintSentences(ranges);
  }
  private error(message: string) {
    // Blocks that already got a score are kept; only the rest are offered for retry.
    if (this.searching && this.request) this.setFailed(this.sent.filter((id) => !(id in this.scores)));
    this.searching = false;
    this.bar.set({ verdict: { text: message, tone: "error" }, progress: { done: 0, total: 0 } });
  }
  private render(event: SearchEvent) {
    if (event.type === "failure") {
      this.finish();
      return this.error(event.message);
    }
    this.scores = { ...this.base.scores, ...event.scores };
    this.conditionScores = { ...this.base.conditionScores, ...event.conditionScores };
    const finished = event.done === event.total;
    if (finished) {
      this.finish();
      this.searching = false;
      this.base = { scores: this.scores, conditionScores: this.conditionScores };
      if (event.failed) this.setFailed(this.sent.filter((id) => !(id in event.scores)));
    }
    this.lastProgress = event;
    this.rerank();
  }
  private status(progress: Progress) {
    const finished = progress.done === progress.total;
    const count = this.hits.length;
    const text = !finished
      ? "正在搜索…"
      : progress.failed
        ? `部分搜索失败，已找到 ${count} 段，可点“重试”`
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
    if (!this.hits.length) return "";
    return this.current ? `${this.hits.indexOf(this.current) + 1} / ${this.hits.length}` : `${this.hits.length} 个结果`;
  }
  private step(dir: 1 | -1) {
    if (!this.hits.length) return;
    const index = this.current ? this.hits.indexOf(this.current) : dir === 1 ? -1 : 0;
    this.goTo(this.hits[(index + dir + this.hits.length) % this.hits.length]!);
  }
  private goTo(hit: Hit) {
    if (!hit.el.isConnected) return this.bar.flash("网页内容已变化，请重新搜索。");
    markCurrent(this.current, hit);
    this.current = hit;
    this.bar.set({ counter: this.counterText() });
    this.marks.draw(this.hits, this.current);
    this.copyButton.update(this.hits, this.current);
  }
}

// Light or dark, judged from the page's own background (falling back to its text color).
function pageTheme(): "light" | "dark" {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const rgb = rgba(getComputedStyle(el).backgroundColor);
    if (rgb && rgb[3] > 0.5) return luminance(rgb) < 0.4 ? "dark" : "light";
  }
  const text = document.body && rgba(getComputedStyle(document.body).color);
  return text && luminance(text) > 0.6 ? "dark" : "light";
}
function rgba(color: string): [number, number, number, number] | undefined {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/);
  if (!m) return undefined;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}
// Relative luminance (WCAG), 0 = black, 1 = white.
function luminance([r, g, b]: readonly number[]) {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

declare global {
  interface Window {
    __hunchLoaded?: boolean;
  }
}
if (!window.__hunchLoaded) {
  window.__hunchLoaded = true;
  const hunch = new Hunch();
  if (inViewer) {
    // Extension pages don't receive tabs.sendMessage; the background broadcasts with a tab id.
    const self = browser.tabs?.getCurrent?.().then((tab) => tab?.id);
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const { type, tabId } = message as { type?: string; tabId?: number };
      if (type !== "viewer-toggle" || tabId !== (await self)) return undefined;
      hunch.isOpen ? hunch.close() : void hunch.open();
      return true;
    });
    document.addEventListener("hunch-open", () => void hunch.open());
  }
  browser.runtime.onMessage.addListener((message: unknown) => {
    switch ((message as TabMessage).type) {
      case "ping":
        return Promise.resolve(true);
      case "toggle":
        hunch.isOpen ? hunch.close() : void hunch.open();
        return;
    }
  });
}
