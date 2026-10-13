import { type Block, blockId, type SearchScope } from "../shared/protocol";
import { MAX_BLOCK_CHARS, MIN_BLOCK_CHARS } from "../shared/questions";

export interface PageBlock extends Block {
  el: HTMLElement;
  heading: string;
}

type Candidate = { text: string; el: HTMLElement };
const EXCLUDED =
  "hunch-ui,script,style,noscript,input,textarea,select,[contenteditable]:not([contenteditable='false'])";
const CHROME = "nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo']";
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export function captureSelection(): Range[] {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return [];
  const ranges: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const parent =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if ((parent instanceof HTMLElement && parent.isContentEditable) || parent?.closest(EXCLUDED)) continue;
    if (document.body.contains(range.commonAncestorContainer)) ranges.push(range.cloneRange());
  }
  return ranges;
}

export function extractBlocks(scope: SearchScope = "page", ranges: readonly Range[] = []): PageBlock[] {
  const candidates =
    scope === "selection"
      ? selectionBlocks(ranges)
      : textBlocks(scope === "article" ? articleRoot() : document.body, scope === "article");
  const headings = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].filter(visible);
  return candidates
    .filter((c) => c.text.length >= (scope === "selection" || /^H[1-6]$/.test(c.el.tagName) ? 1 : MIN_BLOCK_CHARS))
    .flatMap((c) => splitAtBlockLimit(c.text).map((text) => ({ text, el: c.el })))
    .map((c, i) => ({ id: blockId(i + 1), ...c, heading: headingFor(c.el, headings) }));
}

function visible(el: HTMLElement): boolean {
  if (el.isContentEditable || el.closest(EXCLUDED)) return false;
  const style = getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    (style.display === "contents" || el.checkVisibility())
  );
}

function articleRoot(): HTMLElement {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      "article,main,[role='main'],#content,#article,.article-content,.post-content,.entry-content",
    ),
  ].filter(visible);
  // Prefer a focused article when it has useful content, otherwise choose the largest main region.
  const articles = candidates.filter((el) => el.tagName === "ARTICLE" && (el.innerText?.length ?? 0) >= 80);
  const pool = articles.length ? articles : candidates;
  return pool.sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))[0] ?? document.body;
}

function textBlocks(el: HTMLElement, article: boolean): Candidate[] {
  if (!visible(el) || (article && el.matches(CHROME))) return [];
  const display = getComputedStyle(el).display;
  if (display === "table-row")
    return [{ text: normalize([...el.children].map(fullText).filter(Boolean).join(" | ")), el }];
  const children = [...el.children].filter(isHtml).flatMap((child) => textBlocks(child, article));
  const isBlock = !display.startsWith("inline") && display !== "contents";
  return isBlock ? [{ text: ownText(el), el }, ...children] : children;
}

function selectionBlocks(ranges: readonly Range[]): Candidate[] {
  const groups = new Map<HTMLElement, string[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && visible(parent)) {
      for (const range of ranges) {
        if (!range.intersectsNode(node)) continue;
        const text = node.textContent ?? "";
        const start = range.startContainer === node ? range.startOffset : 0;
        const end = range.endContainer === node ? range.endOffset : text.length;
        const clipped = text.slice(start, end);
        if (!clipped) continue;
        let block = parent;
        while (block.parentElement && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
        const parts = groups.get(block) ?? [];
        parts.push(clipped);
        groups.set(block, parts);
      }
    }
    node = walker.nextNode();
  }
  return [...groups].map(([el, parts]) => ({ el, text: normalize(parts.join("")) }));
}

function headingFor(el: HTMLElement, headings: HTMLElement[]): string {
  const heading = [...headings]
    .reverse()
    .find((h) => h === el || Boolean(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  return heading ? normalize(heading.textContent ?? "") : "";
}

function splitAtBlockLimit(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_BLOCK_CHARS) {
    const space = rest.lastIndexOf(" ", MAX_BLOCK_CHARS);
    const cut = space > MAX_BLOCK_CHARS / 2 ? space : MAX_BLOCK_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const fullText = (el: Element) => normalize(el.textContent ?? "");
function ownText(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    else if (node instanceof HTMLElement && visible(node) && getComputedStyle(node).display.startsWith("inline"))
      text += node.textContent ?? "";
  }
  return normalize(text);
}
const isHtml = (el: Element): el is HTMLElement => el instanceof HTMLElement;
