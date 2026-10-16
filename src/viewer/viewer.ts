import * as pdfjs from "pdfjs-dist";
import browser from "webextension-polyfill";
import { DOCUMENT_ACCEPT, type DocumentKind, documentKind, isLegacyDoc } from "../shared/documents";
import { paragraphs, type TextRun } from "./layout";
import { sanitize } from "./sanitize";

// The extension page renders PDF / Word text as ordinary HTML so the regular content script
// (loaded by viewer.html) can extract, score, highlight and save it like any web page.

pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("pdf.worker.min.mjs");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const article = $<HTMLElement>("doc");
const status = $<HTMLParagraphElement>("status");
const picker = $<HTMLInputElement>("file");
const intro = $<HTMLElement>("intro");
const grant = $<HTMLButtonElement>("grant");
const params = new URLSearchParams(location.search);
picker.accept = DOCUMENT_ACCEPT;

function say(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// content.ts reads this to label results with the document, not viewer.html.
function setSource(url: string, title: string) {
  let meta = document.querySelector<HTMLMetaElement>("meta[name='hunch-source']");
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "hunch-source";
    document.head.append(meta);
  }
  meta.content = url;
  document.title = title;
  $("docTitle").textContent = title;
}

async function renderPdf(data: ArrayBuffer): Promise<number> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: browser.runtime.getURL("pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: browser.runtime.getURL("pdfjs/standard_fonts/"),
    // Text extraction needs neither font rendering nor the image-decoding WebAssembly.
    disableFontFace: true,
    useWasm: false,
  });
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const password = prompt(
      reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "密码错误，请重新输入：" : "此 PDF 需要密码：",
    );
    if (password === null) void task.destroy();
    else update(password);
  };
  const pdf = await task.promise;
  let characters = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    say(`正在读取第 ${n} / ${pdf.numPages} 页…`);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const section = document.createElement("section");
    section.className = "page";
    // Page headings label every block below them, so results cite the page.
    const heading = document.createElement("h2");
    heading.textContent = `第 ${n} 页`;
    section.append(heading);
    const runs = content.items.filter((item) => "str" in item) as TextRun[];
    for (const text of paragraphs(runs)) {
      const p = document.createElement("p");
      p.textContent = text;
      section.append(p);
      characters += text.length;
    }
    article.append(section);
    page.cleanup();
  }
  await task.destroy();
  return characters;
}

async function renderDocx(data: ArrayBuffer): Promise<number> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: data });
  article.append(sanitize(result.value));
  return article.textContent?.trim().length ?? 0;
}

async function render(data: ArrayBuffer, kind: DocumentKind, source: string, name: string) {
  article.replaceChildren();
  intro.hidden = true;
  grant.hidden = true;
  setSource(source, name);
  say("正在读取文档…");
  try {
    const characters = kind === "pdf" ? await renderPdf(data) : await renderDocx(data);
    if (!characters) {
      return say(
        kind === "pdf"
          ? "这个 PDF 没有可提取的文字，可能是扫描件。目前不支持图片文字识别（OCR）。"
          : "这个文档没有文字。",
        true,
      );
    }
    say(`已读取 ${characters.toLocaleString()} 个字符。按快捷键或点击工具栏图标开始搜索。`);
    if (params.get("open") === "1") document.dispatchEvent(new CustomEvent("hunch-open"));
  } catch (error) {
    article.replaceChildren();
    intro.hidden = false;
    const message = error instanceof Error ? error.message : String(error);
    say(/password/i.test(message) ? "已取消：此 PDF 需要密码。" : `无法读取文档：${message}`, true);
  }
}

async function openFile(file: File) {
  if (isLegacyDoc(file.name)) return say("不支持旧版 .doc 格式。请在 Word 中另存为 .docx 后再打开。", true);
  const kind = documentKind(file.name, file.type);
  if (!kind) return say("只支持 PDF 和 Word（.docx）文件。", true);
  // A picked file has no path the page can see; its name is the best available source label.
  await render(await file.arrayBuffer(), kind, `file:///${encodeURIComponent(file.name)}`, file.name);
}

async function openUrl(src: string) {
  const url = new URL(src);
  const name = decodeURIComponent(url.pathname.split("/").pop() || url.hostname) || src;
  setSource(url.href, name);
  say("正在下载文档…");
  let response: Response;
  try {
    response = await fetch(url.href, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    return blocked(url, error);
  }
  const kind = documentKind(url.href, response.headers.get("content-type") ?? "") ?? "pdf";
  await render(await response.arrayBuffer(), kind, url.href, name);
}

// Fetching another origin needs that host's permission; file:// needs the browser's file-access switch.
async function blocked(url: URL, error: unknown) {
  if (url.protocol === "file:") {
    return say(
      "无法读取本地文件。请在扩展管理页为感应式查找打开“允许访问文件网址”，然后刷新本页；或者在下方选择这个文件。",
      true,
    );
  }
  const origins = [`${url.origin}/*`];
  if (await browser.permissions.contains({ origins })) {
    return say(
      `无法下载文档（${error instanceof Error ? error.message : String(error)}）。可以先下载到本地，再在下方选择文件。`,
      true,
    );
  }
  say(`读取这个文档需要访问 ${url.hostname}。`, true);
  grant.hidden = false;
  grant.onclick = async () => {
    // permissions.request must be the first await to keep the click's user gesture.
    if (await browser.permissions.request({ origins })) void openUrl(url.href);
  };
}

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file) void openFile(file);
});
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

// Page appearance: "auto" follows the system, otherwise viewer.html's :root[data-theme] forces a side.
// localStorage (not storage.local) so it applies synchronously, before the first paint of the document.
type ViewerTheme = "auto" | "light" | "dark";
const THEME_KEY = "hunch-viewer-theme";
const themeButtons = [...$("theme").querySelectorAll<HTMLButtonElement>("button")];
function applyViewerTheme(theme: ViewerTheme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const button of themeButtons) {
    const on = button.dataset.value === theme;
    button.setAttribute("aria-checked", String(on));
    button.tabIndex = on ? 0 : -1;
  }
}
function setViewerTheme(theme: ViewerTheme) {
  localStorage.setItem(THEME_KEY, theme);
  applyViewerTheme(theme);
  document.dispatchEvent(new CustomEvent("hunch-page-theme"));
}
const savedTheme = localStorage.getItem(THEME_KEY);
applyViewerTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : "auto");
for (const button of themeButtons) {
  button.addEventListener("click", () => setViewerTheme(button.dataset.value as ViewerTheme));
  // Arrow keys move through the radio group, per the ARIA radiogroup pattern.
  button.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const i = themeButtons.indexOf(button);
    const next = themeButtons[(i + step + themeButtons.length) % themeButtons.length]!;
    setViewerTheme(next.dataset.value as ViewerTheme);
    next.focus();
  });
}

const src = params.get("src");
if (src) void openUrl(src);
