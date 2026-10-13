// Static style preview: renders the real bar and result card with fake data, no extension APIs.
import type { Excerpt } from "../src/shared/excerpts";
import { FindBar } from "../src/content/bar";
import { Dock } from "../src/content/dock";
import type { Hit } from "../src/content/hits";
import { Peek } from "../src/content/peek";
import { ScopeFrame } from "../src/content/scope-frame";

const host = document.createElement("hunch-ui");
host.className = "hunch-open";
document.body.append(host);
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = "../src/content/ui.css";

const noop = () => {};
const peek = new Peek({
  onSave: noop,
  onCopyHit: noop,
  onCopyExcerpt: noop,
  onDelete: noop,
  onExport: noop,
  onCloseSaved: () => states.results(),
});
const bar = new FindBar({
  onSubmit: noop,
  onStep: noop,
  onClose: noop,
  onSaved: () => (peek.isSavedOpen ? states.results() : states.saved()),
  onScopeVisible: () => {
    scopeOn = !scopeOn;
    bar.setScopeVisible(scopeOn);
    if (scopeOn) scopeFrame.show(bar.controls().scope, []);
    else scopeFrame.hide();
  },
  onChange: () => scopeOn && scopeFrame.show(bar.controls().scope, []),
  onTheme: () => {
    const next = { auto: "light", light: "dark", dark: "auto" } as const;
    const theme = next[(host.dataset.theme as "light" | "dark" | undefined) ?? "auto"];
    if (theme === "auto") delete host.dataset.theme;
    else host.dataset.theme = theme;
    bar.setTheme(theme);
  },
});
const dock = new Dock(peek.root, bar.root);
bar.root.prepend(dock.grabber);
const scopeFrame = new ScopeFrame();
let scopeOn = true;
shadow.append(style, scopeFrame.root, dock.root);
scopeFrame.show("page", []);

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
const excerpts = [
  {
    id: "1",
    url: location.href,
    title: "背影 - 维基文库",
    text: hits[0].text,
    query: "借钱",
    createdAt: new Date().toISOString(),
  },
] as unknown as Excerpt[];

const states: Record<string, () => void> = {
  results() {
    peek.showSaved(false);
    bar.setSavedOpen(false);
    peek.setExcerpts(excerpts);
    bar.setSavedCount(excerpts.length);
    peek.showHit(hits[0], []);
    bar.set({
      counter: "1 / 3",
      verdict: { text: "找到 3 处高相关结果", tone: "found" },
      meta: "1317 毫秒 · 1/1 批次",
      progress: { done: 1, total: 1 },
    });
  },
  busy() {
    peek.showHit(undefined);
    bar.set({
      counter: "",
      verdict: { text: "正在搜索…", tone: "busy" },
      meta: "420 毫秒 · 1/3 批次",
      progress: { done: 1, total: 3 },
    });
  },
  error() {
    peek.showHit(undefined);
    bar.set({ verdict: { text: "搜索连接已断开，请重新搜索。", tone: "error" }, progress: { done: 0, total: 0 } });
  },
  empty() {
    peek.showHit(undefined);
    bar.set({ counter: "", verdict: { text: "没有高相关结果", tone: "absent" }, meta: "" });
  },
  saved() {
    peek.setExcerpts(excerpts);
    peek.showSaved(true);
    bar.setSavedOpen(true);
  },
  conditions() {
    (bar.root.querySelector('[data-value="conditions"]') as HTMLButtonElement).click();
    peek.showHit({ ...hits[0], conditionScores: [0.9, 0.4] } as Hit, ["提到了借钱", "提到了祖母"]);
  },
  article() {
    const scope = bar.root.querySelector<HTMLSelectElement>('[aria-label="搜索范围"]')!;
    scope.value = "article";
    scope.dispatchEvent(new Event("change"));
  },
  dark() {
    host.dataset.theme = "dark";
    bar.setTheme("dark");
  },
};

hits[0].el.classList.add("hunch-hl", "hunch-current");
for (const hit of hits) {
  hit.el.classList.add("hunch-hl", "hunch-rel");
  hit.el.dataset.hunchP = hit.p.toFixed(2);
  hit.el.style.setProperty("--hunch-alpha", String(hit.p * 0.6));
}

const toolbar = document.getElementById("states")!;
for (const name of Object.keys(states)) {
  const button = document.createElement("button");
  button.textContent = name;
  button.addEventListener("click", states[name]);
  toolbar.append(button);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-page]"))
  button.addEventListener("click", () => {
    document.body.dataset.page = button.dataset.page;
  });
states.results();
for (const name of location.hash.slice(1).split(",").filter(Boolean)) {
  if (name in states) states[name]();
  else document.body.dataset.page = name;
}
