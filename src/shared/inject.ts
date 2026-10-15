import browser from "webextension-polyfill";
import type { TabMessage } from "./protocol";

export const sendToTab = (tabId: number, msg: TabMessage) => browser.tabs.sendMessage(tabId, msg);

export async function hasContentScript(tabId: number): Promise<boolean> {
  try {
    await sendToTab(tabId, { type: "ping" });
    return true;
  } catch {
    return false;
  }
}

// The content script is injected on demand via activeTab, so pages the user never
// searched don't run any extension code.
export async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}
