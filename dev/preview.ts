import { paintSentences } from "../src/content/sentence-marks";
// Static style preview: renders the real bar with fake data, no extension APIs.
import { FindBar } from "../src/content/bar";
import { CopyButton } from "../src/content/copy-button";
import { Dock } from "../src/content/dock";
import type { Hit } from "../src/content/hits";
import { clearPending, markPending } from "../src/content/pipeline";
import { ScopeFrame } from "../src/content/scope-frame";
import { applyTone } from "../src/content/tone";

const host = document.createElement("hunch-ui");
host.className = "hunch-open";
document.body.append(host);
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = "../src/content/ui.css";

const noop = () => {};
const bar = new FindBar({
  onSubmit: noop,
  onStep: noop,
  onClose: noop,
  onScopeVisible: () => {
    scopeOn = !scopeOn;
    bar.setScopeVisible(scopeOn);
    if (scopeOn) scopeFrame.show(bar.controls().scope, []);
    else scopeFrame.hide();
  },
  onChange: () => scopeOn && scopeFrame.show(bar.controls().scope, []),
  onRefresh: noop,
  onRetry: noop,
  onScope: () => scopeOn && scopeFrame.show(bar.controls().scope, []),
  onThreshold: noop,
  onRefine: (on) => bar.setRefine(on),
  onSentenceThreshold: noop,
  onResetSettings: noop,
  onSettingsShown: () => bar.setProvider({ name: "relay.example.com", state: "ready" }),
  onEditProvider: noop,
  onTheme: (theme) => {
    if (theme === "auto") delete host.dataset.theme;
    else host.dataset.theme = theme;
    bar.setTheme(theme);
  },
});
const dock = new Dock(bar.root, bar.panel);
bar.root.prepend(dock.grabber);
const scopeFrame = new ScopeFrame();
let scopeOn = true;
const copyButton = new CopyButton((ok) => bar.flash(ok ? "已复制段落。" : "复制失败，请手动选中文字复制。"));
shadow.append(style, scopeFrame.root, copyButton.root, dock.root);
scopeFrame.show(bar.controls().scope, []);

const paragraphs = [...document.querySelectorAll<HTMLElement>("article p")];
const hits = paragraphs.slice(0, 3).map(
  (el, i) =>
    ({
      id: i,
      el,
      text: el.textContent ?? "",
      heading: "背影",
      p: [0.92, 0.81, 0.74][i],
      conditionScores: [],
    }) as unknown as Hit,
);

const states: Record<string, () => void> = {
  results() {
    clearPending();
    bar.set({
      counter: "1 / 3",
      verdict: { text: "6 个文字块中 3 段符合，已按分数排序", tone: "found" },
      meta: "1317 毫秒 · 1/1 批次",
      progress: { done: 1, total: 1 },
    });
  },
  // Mid-search: the last two blocks are still dashed (waiting for Jev), the first three are scored.
  judging() {
    markPending(paragraphs.slice(3).map((el, i) => ({ id: `b${i + 4}`, el, text: "", heading: "" }) as never));
    bar.set({
      counter: "",
      verdict: { text: "已分成 6 个文字块 · Jev 判断中 4/6", tone: "busy" },
      meta: "640 毫秒 · 1/2 批次",
      progress: { done: 1, total: 2 },
    });
  },
  busy() {
    bar.set({
      counter: "",
      verdict: { text: "正在搜索…", tone: "busy" },
      meta: "420 毫秒 · 1/3 批次",
      progress: { done: 1, total: 3 },
    });
  },
  error() {
    bar.set({
      verdict: {
        text: "搜索连接中断（Could not establish connection），已保留收到的结果，可点“重试”补搜其余文字块。",
        tone: "error",
      },
      progress: { done: 0, total: 0 },
    });
  },
  empty() {
    bar.set({ counter: "", verdict: { text: "没有高相关结果", tone: "absent" }, meta: "" });
  },
  conditions() {
    (bar.root.querySelector('[data-value="conditions"]') as HTMLButtonElement).click();
  },
  article() {
    const scope = bar.root.querySelector<HTMLSelectElement>('[aria-label="搜索范围"]')!;
    scope.value = "article";
    scope.dispatchEvent(new Event("change"));
  },
  settings() {
    (bar.root.querySelector(".hunch-settings-toggle") as HTMLButtonElement).click();
    (bar.panel.querySelector(".hunch-help-toggle") as HTMLButtonElement).click();
  },
  dark() {
    host.dataset.theme = "dark";
    bar.setTheme("dark");
  },
};

hits[0].el.classList.add("hunch-hl", "hunch-current");
for (const hit of hits) {
  applyTone(hit.el);
  hit.el.classList.add("hunch-hl", "hunch-rel");
  hit.el.dataset.hunchP = hit.p.toFixed(2);
  hit.el.dataset.hunchBadge = `#${hits.indexOf(hit) + 1} · 相关度 ${hit.p.toFixed(2)}`;
  hit.el.style.setProperty("--hunch-alpha", (0.05 + 0.05 * hit.p).toFixed(3));
}
copyButton.update(hits, hits[0]);

// Mark the answer sentence inside the first hit, as the second pass would.
const first = hits[0].el.firstChild;
if (first?.nodeType === 3 && globalThis.CSS?.highlights) {
  const text = first.textContent ?? "";
  const at = text.indexOf("那年冬天");
  if (at >= 0) {
    const range = document.createRange();
    range.setStart(first, at);
    range.setEnd(first, at + "那年冬天，祖母死了，父親的差使也交卸了，正是禍不單行的日子。".length);
    paintSentences([range]);
  }
}
bar.setRefine(true);
bar.setSentenceThreshold(0.7);
bar.setThreshold(0.4);

const toolbar = document.getElementById("states")!;
for (const name of Object.keys(states)) {
  const button = document.createElement("button");
  button.textContent = name;
  button.addEventListener("click", states[name]);
  toolbar.append(button);
}
// Highlights pick their palette from the page background, so re-tone them when it changes.
function setPage(name: string | undefined) {
  document.body.dataset.page = name;
  for (const hit of hits) applyTone(hit.el);
  copyButton.update(hits, hits[0]);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-page]"))
  button.addEventListener("click", () => setPage(button.dataset.page));
states.results();
for (const name of location.hash.slice(1).split(",").filter(Boolean)) {
  // "page-dark" etc. picks the page background; "dark" alone is the bar's dark state.
  if (name in states) states[name]();
  else setPage(name.replace(/^page-/, ""));
}
