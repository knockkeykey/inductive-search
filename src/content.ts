import browser from "webextension-polyfill";
import { FindBar, type Theme } from "./content/bar";
import { captureSelection, extractBlocks, type PageBlock } from "./content/blocks";
import { CopyButton } from "./content/copy-button";
import { Dock } from "./content/dock";
import { clearPaint, ensureStyles, type Hit, markCurrent, paint, rankHits } from "./content/hits";
import { clearPending, markPending, settlePending } from "./content/pipeline";
import { ScopeFrame } from "./content/scope-frame";
import { clearSentences, paintSentences, sentenceRanges } from "./content/sentence-marks";
import { Spotlight } from "./content/spotlight";
import { cacheEnabled, setCacheEnabled } from "./shared/cache";
import {
  type BlockId,
  blockId,
  type Progress,
  type ProviderStatus,
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
// Matches the .hunch-theme-shift transition in ui.css, plus a frame of slack.
const THEME_SHIFT_MS = 420;
const THEME_REVEAL_MS = 620;
// The reveal animates the view transition snapshots ourselves; these turn off the default cross-fade
// so the old palette stays fully opaque until the circle passes over it.
const THEME_REVEAL_CSS = `
::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }`;
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
  // Dims the page around the current hit.
  spotlight: boolean;
}
const DEFAULT_PREFS: UiPrefs = {
  theme: "auto",
  showScope: true,
  threshold: validThreshold(undefined),
  refine: true,
  sentenceThreshold: SENTENCE_THRESHOLD,
  spotlight: true,
};
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
    onTheme: (theme, origin) => this.switchTheme(theme, origin),
    onRefine: (refine) => this.setPrefs({ refine }),
    onSpotlight: (spotlight) => this.setPrefs({ spotlight }),
    onSentenceThreshold: (sentenceThreshold) => this.setPrefs({ sentenceThreshold }),
    onCache: (on) => this.setCache(on),
    // Everything adjustable in the settings panel; the scope outline toggle lives on the toolbar.
    onSettingsShown: () => void this.showProvider(),
    onEditProvider: () => {
      try {
        void Promise.resolve(browser.runtime.sendMessage({ type: "open-options" })).catch(() => {});
      } catch {}
    },
    onResetSettings: () => {
      const { showScope: _, ...defaults } = DEFAULT_PREFS;
      this.setPrefs(defaults);
      this.setCache(true);
      this.bar.flash("已恢复默认设置。");
    },
  });
  private readonly scopeFrame = new ScopeFrame();
  private readonly spotlight = new Spotlight();
  private prefs: UiPrefs = { ...DEFAULT_PREFS };
  // Keyed by block id and text, since one element can hold several split blocks.
  private refined = new Map<string, Refined | "pending">();
  // Bumped whenever results are invalidated, so late sentence scores from an old search are dropped.
  private generation = 0;
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
  private readonly dock: HTMLElement;
  private themeTimer: number | undefined;
  private warmedAt = 0;
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
    this.dock = dock.root;
    this.bar.root.prepend(dock.grabber);
    // After the bar in the DOM (and in tab order); CSS order places it above.
    dock.root.append(this.bar.panel);
    this.shadow.append(style, this.spotlight.root, this.scopeFrame.root, this.copyButton.root, dock.root);
    document.documentElement.appendChild(this.host);
    // Listen inside the closed shadow root before its targets are retargeted to the host.
    this.shadow.addEventListener("keydown", (event) => this.navigateResults(event as KeyboardEvent));
    document.addEventListener("keydown", (event) => {
      if (event.target !== this.host) this.navigateResults(event);
    });
    this.ready = Promise.all([styled, this.loadPrefs()]).then(() => {
      this.host.style.removeProperty("display");
    });
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
    this.warm();
    this.bar.focus();
  }
  // Wakes the background worker and lets it open the provider connection ahead of submit.
  // Throttled here so typing doesn't send a message per key; the worker throttles the network side.
  private warm() {
    if (Date.now() - this.warmedAt < KEEPALIVE_MS) return;
    this.warmedAt = Date.now();
    // Best effort: a reloaded extension throws synchronously here, and opening must not fail.
    try {
      void Promise.resolve(browser.runtime.sendMessage({ type: "warm" })).catch(() => {});
    } catch {}
  }
  close() {
    this.host.classList.remove("hunch-open");
    this.observer.disconnect();
    clearTimeout(this.growthTimer);
    this.scopeFrame.hide();
    this.abort();
    this.reset();
  }
  private async showProvider() {
    try {
      this.bar.setProvider((await browser.runtime.sendMessage({ type: "provider-status" })) as ProviderStatus);
    } catch {
      this.bar.setProvider(undefined);
    }
  }
  // Stored apart from the UI prefs: the background reads it before every search.
  private setCache(on: boolean) {
    this.bar.setCache(on);
    void setCacheEnabled(on).catch(() => {});
  }
  private async loadPrefs() {
    this.bar.setCache(await cacheEnabled().catch(() => true));
    try {
      const stored = (await browser.storage?.local.get("ui")) as { ui?: Partial<UiPrefs> } | undefined;
      const ui = stored?.ui;
      this.applyPrefs({
        theme: ui?.theme && THEME_ORDER.includes(ui.theme) ? ui.theme : "auto",
        showScope: ui?.showScope !== false,
        threshold: validThreshold(ui?.threshold),
        refine: ui?.refine !== false,
        sentenceThreshold: validSentenceThreshold(ui?.sentenceThreshold),
        spotlight: ui?.spotlight !== false,
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
    this.bar.setSpotlight(prefs.spotlight);
    this.paintSpotlight();
    if (changed && this.request) this.rerank();
    else if (resentence) this.refineTop();
    this.paintScope();
  }
  // A picked appearance washes over the UI in a circle from the clicked button. The snapshot is of the
  // whole page (not just the host) so the bar's backdrop blur stays real mid-reveal. Anything that
  // can't do it (no View Transitions, page CSP, reduced motion) falls back to applyTheme's cross-fade.
  private switchTheme(theme: Theme, origin: { x: number; y: number }) {
    const from = this.host.dataset.theme;
    const to = theme === "auto" ? (pageTheme() === "light" ? "dark" : "light") : theme;
    if (
      from === to ||
      !this.isOpen ||
      typeof document.startViewTransition !== "function" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return this.setPrefs({ theme });
    let sheet: CSSStyleSheet | undefined;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(THEME_REVEAL_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      this.dropRevealSheet(sheet);
      return this.setPrefs({ theme });
    }
    // Reach the farthest corner of the dock and settings panel, so the circle ends as it covers the UI.
    const radius = Math.max(
      ...[this.dock, this.bar.panel]
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height)
        .flatMap((rect) => [
          Math.hypot(rect.left - origin.x, rect.top - origin.y),
          Math.hypot(rect.right - origin.x, rect.top - origin.y),
          Math.hypot(rect.left - origin.x, rect.bottom - origin.y),
          Math.hypot(rect.right - origin.x, rect.bottom - origin.y),
        ]),
      0,
    );
    let transition: ViewTransition;
    try {
      transition = document.startViewTransition(() => {
        // Set the palette first so applyTheme sees no change and skips its own cross-fade.
        this.host.dataset.theme = to;
        this.setPrefs({ theme });
      });
    } catch {
      this.dropRevealSheet(sheet);
      return this.setPrefs({ theme });
    }
    transition.ready
      .then(() => {
        const at = `at ${origin.x}px ${origin.y}px`;
        document.documentElement.animate(
          { clipPath: [`circle(0 ${at})`, `circle(${radius + 24}px ${at})`] },
          {
            duration: THEME_REVEAL_MS,
            easing: "cubic-bezier(0.65, 0, 0.35, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {});
    transition.finished.finally(() => this.dropRevealSheet(sheet)).catch(() => {});
  }
  private dropRevealSheet(sheet: CSSStyleSheet | undefined) {
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  }
  // 自动 contrasts with the page, not the system: a light site gets the dark bar so it stands off the content.
  applyTheme() {
    const theme = this.prefs.theme === "auto" ? (pageTheme() === "light" ? "dark" : "light") : this.prefs.theme;
    if (this.host.dataset.theme === theme) return;
    // Cross-fade colors only for a visible switch; the first paint and reopen should land instantly.
    if (this.isOpen && this.host.dataset.theme) {
      this.host.classList.add("hunch-theme-shift");
      // Commit the old colors as the transition start before the palette flips.
      void this.host.offsetWidth;
      window.clearTimeout(this.themeTimer);
      this.themeTimer = window.setTimeout(() => this.host.classList.remove("hunch-theme-shift"), THEME_SHIFT_MS);
    }
    this.host.dataset.theme = theme;
  }
  // Outlines the search range for as long as the bottom bar is up. The article container is looked up
  // again only when `refresh` is set (scope switch, page change); typing just reuses it.
  private paintScope(refresh = false) {
    if (this.isOpen && this.prefs.showScope) this.scopeFrame.show(this.bar.controls().scope, this.ranges, refresh);
    else this.scopeFrame.hide();
  }
  private reset() {
    clearPaint();
    clearPending();
    clearSentences();
    this.refined.clear();
    this.generation++;
    this.hits = [];
    this.current = undefined;
    this.spotlight.hide();
    this.scores = {};
    this.conditionScores = {};
    this.base = { scores: {}, conditionScores: {} };
    this.terms = [];
    this.lastProgress = undefined;
    this.setFailed([]);
    this.setPending([]);
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
    this.warm();
  }
  // Reading the page waits for submit: search() extracts the blocks it sends, so reading here would be thrown away.
  private rescope() {
    this.abort();
    this.request = undefined;
    this.blocks = [];
    this.reset();
    this.paintScope(true);
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
    const ids = new Set(this.sent);
    markPending(
      this.blocks.filter((block) => ids.has(block.id)),
      ensureStyles,
    );
    this.bar.set({ verdict: { text: this.judging(0), tone: "busy" }, progress: { done: 0, total: 1 } });
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
    clearPending();
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
      // Nothing to compare against before the first search; only the article outline may have moved.
      if (scope === "article") this.paintScope(true);
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
    this.copyButton.update(this.hits, this.current);
    this.paintSpotlight();
    if (this.lastProgress) this.bar.set(this.status(this.lastProgress));
    else this.bar.set({ counter: this.counterText() });
  }
  // Scores sentences inside the top hits as soon as their paragraph scores arrive (after each batch),
  // all new hits in one request, then marks the best ones.
  // Cached per block, so threshold changes only repaint; a hit new to the top 3 is scored then.
  private refineTop() {
    const req = this.request;
    if (!req || !this.prefs.refine || req.scope === "selection") {
      return clearSentences();
    }
    const top = this.hits.filter((hit) => !HEADING.test(hit.el.tagName) && hit.p >= this.prefs.threshold);
    const generation = this.generation;
    const batch: { key: string; hit: Hit; sentences: Sentence[] }[] = [];
    for (const hit of top.slice(0, REFINE_TOP)) {
      const key = `${hit.id}\u0000${hit.text}`;
      if (this.refined.has(key) || !(hit.id in this.scores)) continue;
      // Table rows join cells with " | "; their sentences don't map back to the row's text.
      if (hit.el.matches("tr") || getComputedStyle(hit.el).display === "table-row") continue;
      const sentences = refinableSentences(hit.text);
      if (!sentences.length) continue;
      this.refined.set(key, "pending");
      batch.push({ key, hit, sentences });
    }
    if (batch.length) {
      const message: Refine = {
        type: "refine",
        url: req.url,
        title: req.title,
        query: req.query,
        ...(req.mode === "conditions" ? { conditions: req.conditions, combination: req.combination ?? "all" } : {}),
        paragraphs: batch.map(({ hit, sentences }) => ({
          id: hit.id,
          sentences: sentences.map(({ id, text }) => ({ id, text })),
        })),
      };
      Promise.resolve(browser.runtime.sendMessage(message) as Promise<RefineResult | undefined>)
        .catch(() => undefined)
        .then((result) => {
          if (generation !== this.generation) return;
          for (const { key, hit, sentences } of batch) {
            this.refined.set(key, { sentences, scores: result?.scores?.[hit.id] ?? {} });
          }
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
    settlePending(this.scores);
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
      ? this.judging(Object.keys(progress.scores).length)
      : progress.failed
        ? `${
            progress.failed === progress.total
              ? `搜索失败${count ? `（以下 ${count} 段仅为字面匹配）` : ""}`
              : `${progress.failed}/${progress.total} 批搜索失败，已找到 ${count} 段`
          }：${(progress.error ?? "未知错误").replace(/[。.]$/, "")}。可点“重试”。`
        : count
          ? `${this.blocks.length} 个文字块中 ${count} 段符合，已按分数排序`
          : "没有高相关结果";
    return {
      verdict: { text, tone: !finished ? "busy" : progress.failed ? "error" : count ? "found" : "absent" },
      meta: `${progress.ms} 毫秒 · ${progress.done}/${progress.total} 批次${progress.failed ? ` · ${progress.failed} 失败` : ""}`,
      progress: { done: progress.done, total: progress.total },
      counter: this.counterText(),
    } as const;
  }
  // Names the step the search is in, so the status reads like the pipeline: blocks cut, Jev judging.
  private judging(scored: number) {
    const sent = this.sent.length;
    return `已分成 ${this.blocks.length} 个文字块 · Jev 判断中 ${Math.min(scored, sent)}/${sent}`;
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
  private navigateResults(event: KeyboardEvent) {
    if (
      !this.isOpen ||
      !this.hits.length ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.shiftKey && event.key !== "Enter") ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter")
    )
      return;
    const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
    const query = path[0];
    const inQuery = query?.matches(".hunch-input") && this.bar.root.contains(query);
    // Keep editing, native controls, settings and keyboard dock movement working as usual.
    if (
      path.some((node) => node.matches(".hunch-settings, .hunch-grabber")) ||
      (event.key === "Enter" &&
        path.some((node) => node.matches("button, a[href], summary, [role='button'], [role='link']"))) ||
      (!inQuery &&
        path.some(
          (node) =>
            node.matches(
              "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='spinbutton']",
            ) || node.isContentEditable,
        ))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.step(event.key === "ArrowUp" || event.shiftKey ? -1 : 1);
  }
  private goTo(hit: Hit) {
    if (!hit.el.isConnected) return this.bar.flash("网页内容已变化，请重新搜索。");
    markCurrent(this.current, hit);
    this.current = hit;
    this.bar.set({ counter: this.counterText() });
    this.copyButton.update(this.hits, this.current);
    this.paintSpotlight();
  }
  private paintSpotlight() {
    this.spotlight.show(this.isOpen && this.prefs.spotlight ? this.current?.el : undefined);
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
    // viewer.ts switched the page's appearance; 自动 must re-contrast with it.
    document.addEventListener("hunch-page-theme", () => hunch.applyTheme());
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
