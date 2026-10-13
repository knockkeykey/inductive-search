import { type Block, blockId, type SearchScope } from "../shared/protocol";
import { MAX_BLOCK_CHARS, MIN_BLOCK_CHARS } from "../shared/questions";

export interface PageBlock extends Block {
  el: HTMLElement;
  heading: string;
}

type Candidate = { text: string; el: HTMLElement; heading: string };
const EXCLUDED =
  "hunch-ui,script,style,noscript,input,textarea,select,[contenteditable]:not([contenteditable='false'])";
const CHROME = "nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo']";
const HEADING = /^H[1-6]$/;
const XHTML = "http://www.w3.org/1999/xhtml";
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

// Elements from same-origin iframes belong to another realm, so `instanceof HTMLElement` fails for them.
const isHtml = (node: Node | null | undefined): node is HTMLElement =>
  node?.nodeType === 1 && (node as Element).namespaceURI === XHTML;

// Resolve styles in the element's own window; iframe content has its own viewport and media queries.
export const computed = (el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el);

// Children in rendered order: an open shadow root replaces the light DOM, and slots pull in assigned nodes.
function renderedChildren(el: HTMLElement): Node[] {
  if (el.localName === "slot") {
    const assigned = (el as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
    if (assigned.length) return assigned;
  }
  return [...(el.shadowRoot ?? el).childNodes];
}

// Same-origin frames are readable; cross-origin ones return null and stay out of scope.
function frameBody(el: HTMLElement): HTMLElement | undefined {
  if (el.localName !== "iframe" && el.localName !== "frame") return undefined;
  try {
    return (el as HTMLIFrameElement).contentDocument?.body ?? undefined;
  } catch {
    return undefined;
  }
}

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
  return candidates
    .filter((c) => c.text.length >= (scope === "selection" || HEADING.test(c.el.tagName) ? 1 : MIN_BLOCK_CHARS))
    .flatMap((c) => splitAtBlockLimit(c.text).map((text) => ({ ...c, text })))
    .map((c, i) => ({ id: blockId(i + 1), ...c }));
}

function visible(el: HTMLElement): boolean {
  if (el.isContentEditable || el.closest(EXCLUDED)) return false;
  const style = computed(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    (style.display === "contents" || el.checkVisibility())
  );
}

export function articleRoot(): HTMLElement {
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

// One pass in rendered order. The latest heading seen so far labels every following block,
// which also works inside shadow trees and iframes where document-wide queries can't reach.
function textBlocks(root: HTMLElement, article: boolean): Candidate[] {
  const out: Candidate[] = [];
  let heading = root === document.body ? "" : precedingHeading(root);
  const walk = (el: HTMLElement) => {
    if (!visible(el) || (article && el.matches(CHROME))) return;
    const frame = frameBody(el);
    if (frame) return walk(frame);
    if (HEADING.test(el.tagName)) heading = normalize(el.textContent ?? "");
    const display = computed(el).display;
    if (display === "table-row") {
      const cells = renderedChildren(el).filter(isHtml).map(fullText).filter(Boolean);
      out.push({ text: normalize(cells.join(" | ")), el, heading });
      return;
    }
    if (!display.startsWith("inline") && display !== "contents") out.push({ text: ownText(el), el, heading });
    for (const child of renderedChildren(el)) if (isHtml(child)) walk(child);
  };
  walk(root);
  return out;
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
        while (block.parentElement && computed(block).display.startsWith("inline")) block = block.parentElement;
        const parts = groups.get(block) ?? [];
        parts.push(clipped);
        groups.set(block, parts);
      }
    }
    node = walker.nextNode();
  }
  return [...groups].map(([el, parts]) => ({ el, text: normalize(parts.join("")), heading: precedingHeading(el) }));
}

// Nearest heading at or before `el` in the top document. Only used for small inputs.
function precedingHeading(el: HTMLElement): string {
  const headings = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].filter(visible);
  const heading = headings
    .reverse()
    .find((h) => h === el || Boolean(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  return heading ? normalize(heading.textContent ?? "") : "";
}

const SENTENCE_END = /[。！？；…!?;]/;
const endsSentence = (text: string, i: number) =>
  SENTENCE_END.test(text[i - 1] ?? "") || (text[i - 1] === "." && /\s/.test(text[i] ?? ""));

// Cut long blocks at a sentence end when possible, then at a space, and only then mid-text.
// Chinese has no spaces between words, so a space-only rule would split it mid-sentence.
export function splitAtBlockLimit(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_BLOCK_CHARS) {
    let cut = 0;
    for (let i = MAX_BLOCK_CHARS; i > MAX_BLOCK_CHARS / 2 && !cut; i--) if (endsSentence(rest, i)) cut = i;
    if (!cut) {
      const space = rest.lastIndexOf(" ", MAX_BLOCK_CHARS);
      cut = space > MAX_BLOCK_CHARS / 2 ? space : MAX_BLOCK_CHARS;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const fullText = (el: Element) => normalize(el.textContent ?? "");

// Text that renders inline inside this block. `display: contents` wrappers (including slots)
// pass their inline content through; nested blocks are collected separately by textBlocks.
function ownText(el: HTMLElement): string {
  let text = "";
  const collect = (parent: HTMLElement) => {
    for (const node of renderedChildren(parent)) {
      if (node.nodeType === 3) text += node.textContent ?? "";
      else if (isHtml(node) && visible(node)) {
        const display = computed(node).display;
        if (display === "contents" || (display.startsWith("inline") && node.shadowRoot)) collect(node);
        else if (display.startsWith("inline")) text += node.textContent ?? "";
      }
    }
  };
  collect(el);
  return normalize(text);
}

export interface TextPositions {
  // Same string as the block's normalized own text.
  text: string;
  // DOM position of each character of `text`.
  at: [Text, number][];
}

// Walks the same text nodes as ownText, in the same order, so offsets into a block's text
// can be turned back into DOM Ranges. Whitespace is collapsed and trimmed exactly like normalize.
export function textPositions(el: HTMLElement): TextPositions {
  const nodes: Text[] = [];
  const all = (root: Node) => {
    const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  };
  const collect = (parent: HTMLElement) => {
    for (const node of renderedChildren(parent)) {
      if (node.nodeType === 3) nodes.push(node as Text);
      else if (isHtml(node) && visible(node)) {
        const display = computed(node).display;
        if (display === "contents" || (display.startsWith("inline") && node.shadowRoot)) collect(node);
        else if (display.startsWith("inline")) all(node);
      }
    }
  };
  collect(el);
  let text = "";
  const at: [Text, number][] = [];
  let space = false;
  for (const node of nodes) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i]!)) {
        if (space) continue;
        space = true;
        text += " ";
      } else {
        space = false;
        text += data[i];
      }
      at.push([node, i]);
    }
  }
  const lead = text.startsWith(" ") ? 1 : 0;
  const trail = text.length > lead && text.endsWith(" ") ? 1 : 0;
  return { text: text.slice(lead, text.length - trail), at: at.slice(lead, at.length - trail) };
}
