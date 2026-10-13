import browser from "webextension-polyfill";
import { answer } from "./background/answer";
import { PROVIDERS } from "./shared/api";
import { documentKind, VIEWER_PAGE, viewerQuery } from "./shared/documents";
import { hasContentScript, injectContentScript, sendToTab } from "./shared/inject";
import { SEARCH_PORT, type Search, type SearchEvent } from "./shared/protocol";
import { hasApiAccess, loadSettings } from "./shared/settings";

async function toggle(tab: browser.Tabs.Tab) {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const url = tab.url ?? "";
  if (url.startsWith(browser.runtime.getURL(VIEWER_PAGE))) {
    await browser.runtime.sendMessage({ type: "viewer-toggle", tabId }).catch(() => undefined);
    return;
  }
  // The browser's own PDF viewer has no searchable DOM; open the document in ours instead.
  const navigable = /^(https?|file):/.test(url);
  if (navigable && documentKind(url)) return openInViewer(tabId, url);
  if (await hasContentScript(tabId)) return void (await sendToTab(tabId, { type: "toggle" }));
  if (navigable && (await isPdfTab(tabId))) return openInViewer(tabId, url);
  // Opening the bar must not depend on an API permission prompt. Chrome loses the
  // user gesture after async storage reads; request provider access from Save instead.
  if (!(await injectContentScript(tabId))) return unavailable(tabId);
  await sendToTab(tabId, { type: "toggle" });
}

async function openInViewer(tabId: number, url: string) {
  await browser.tabs.update(tabId, { url: browser.runtime.getURL(`${viewerQuery(url)}&open=1`) });
}

// PDFs served without a .pdf path (e.g. arxiv.org/pdf/…) are recognised by their content type.
async function isPdfTab(tabId: number): Promise<boolean> {
  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType,
    });
    return result?.result === "application/pdf";
  } catch {
    return false;
  }
}

async function unavailable(tabId: number) {
  await browser.action.setBadgeBackgroundColor({ tabId, color: "#ff5b5b" });
  await browser.action.setBadgeText({ tabId, text: "n/a" });
  await browser.action.setTitle({
    tabId,
    title: "感应式搜索无法在此页面运行：浏览器禁止扩展访问此页面",
  });
  setTimeout(() => void browser.action.setBadgeText({ tabId, text: "" }), 2500);
}

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install" && !(await loadSettings()).apiKey) void browser.runtime.openOptionsPage();
});

browser.action.onClicked.addListener(async (tab) => {
  try {
    await toggle(tab);
  } catch (error) {
    console.error("感应式搜索 activation failed:", error);
    if (tab.id !== undefined) await unavailable(tab.id);
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== SEARCH_PORT) return;
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  // The content script pings while a search runs so Chrome doesn't stop this worker mid-search.
  port.onMessage.addListener((msg: unknown) => {
    if ((msg as { type?: string })?.type !== "keepalive") void run(msg as Search);
  });

  const emit = (e: SearchEvent) => {
    if (!abort.signal.aborted) port.postMessage(e);
  };

  async function run(req: Search) {
    try {
      const settings = await loadSettings();
      if (!settings.apiKey) {
        void browser.runtime.openOptionsPage();
        return emit({ type: "failure", message: "尚未设置 API 密钥。请在刚打开的设置页面中粘贴密钥。" });
      }
      if (!(await hasApiAccess(settings.provider))) {
        void browser.runtime.openOptionsPage();
        return emit({
          type: "failure",
          message: `感应式搜索需要访问 ${PROVIDERS[settings.provider].name}。请在设置页面点击“保存”并允许访问，然后重试搜索。`,
        });
      }
      await answer(req, settings, abort.signal, emit);
    } catch (e) {
      emit({ type: "failure", message: e instanceof Error ? e.message : String(e) });
    }
  }
});
