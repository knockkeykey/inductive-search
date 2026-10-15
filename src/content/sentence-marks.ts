import type { Sentence } from "../shared/sentences";
import { textPositions } from "./blocks";

const NAME = "hunch-sentence";
// The few characters right behind the moving pen, drawn a shade deeper like fresh ink.
const TIP = "hunch-sentence-tip";
const TIP_CHARS = 2;
// A stroke takes longer for a longer sentence, within limits so short ones still read as a sweep.
const MS_PER_CHAR = 22;
const MIN_MS = 260;
const MAX_MS = 900;

type View = Window & typeof globalThis;

interface Stroke {
  range: Range;
  view: View;
  // Text positions the pen steps through; the highlight grows to cover one more each step.
  stops: [Text, number][];
  started: number;
  duration: number;
}

const registries = new Set<HighlightRegistry>();
// Sentences already drawn, so a repaint (new scores, threshold change) doesn't redraw them.
const drawn = new Set<string>();
let strokes: Stroke[] = [];
// Sentences shown in full.
let settled: Range[] = [];
let frame = 0;

// Ranges for sentences of one block. The block may be one piece of a long element,
// so its offsets are shifted to where that piece sits in the element's text.
export function sentenceRanges(el: HTMLElement, blockText: string, sentences: readonly Sentence[]): Range[] {
  if (!sentences.length || !el.isConnected) return [];
  const { text, at } = textPositions(el);
  const base = text.indexOf(blockText);
  if (base < 0) return [];
  const ranges: Range[] = [];
  for (const s of sentences) {
    const first = at[base + s.start];
    const last = at[base + s.end - 1];
    if (!first || !last) continue;
    const range = el.ownerDocument.createRange();
    range.setStart(first[0], first[1]);
    range.setEnd(last[0], last[1] + 1);
    ranges.push(range);
  }
  return ranges;
}

// Draws the marked sentences with the CSS Custom Highlight API; the page DOM is not modified.
// A newly marked sentence is swept in left to right, like a highlighter pen across the line.
export function paintSentences(ranges: readonly Range[]) {
  const keys = new Set<string>();
  const done: Range[] = [];
  const next: Stroke[] = [];
  const now = performance.now();
  for (const range of ranges) {
    const view = range.startContainer.ownerDocument?.defaultView as View | null;
    if (!view) continue;
    const key = keyOf(range);
    keys.add(key);
    const running = strokes.find((s) => keyOf(s.range) === key);
    if (running) next.push(running);
    else if (drawn.has(key) || reducedMotion(view)) done.push(range);
    else {
      const stops = stopsOf(range);
      next.push({
        range,
        view,
        stops,
        started: now,
        duration: Math.min(MAX_MS, Math.max(MIN_MS, stops.length * MS_PER_CHAR)),
      });
    }
  }
  for (const key of drawn) if (!keys.has(key)) drawn.delete(key);
  for (const range of done) drawn.add(keyOf(range));
  strokes = next;
  settled = done;
  render();
}

export function clearSentences() {
  cancelAnimationFrame(frame);
  frame = 0;
  strokes = [];
  settled = [];
  drawn.clear();
  for (const registry of registries) {
    registry.delete(NAME);
    registry.delete(TIP);
  }
  registries.clear();
}

function render() {
  cancelAnimationFrame(frame);
  frame = 0;
  const now = performance.now();
  const body = new Map<View, Range[]>();
  const tips = new Map<View, Range[]>();
  const add = (map: Map<View, Range[]>, view: View, range: Range) => map.set(view, [...(map.get(view) ?? []), range]);
  for (const range of settled) {
    const view = range.startContainer.ownerDocument?.defaultView as View | null;
    if (view) add(body, view, range);
  }
  const running: Stroke[] = [];
  for (const stroke of strokes) {
    const t = Math.min(1, (now - stroke.started) / stroke.duration);
    // Ease out: the pen starts fast and slows as it lifts off the end of the sentence.
    const reach = Math.ceil((1 - (1 - t) ** 2.2) * stroke.stops.length);
    if (t >= 1 || reach >= stroke.stops.length) {
      drawn.add(keyOf(stroke.range));
      settled.push(stroke.range);
      add(body, stroke.view, stroke.range);
      continue;
    }
    running.push(stroke);
    if (reach <= 0) continue;
    const doc = stroke.range.startContainer.ownerDocument!;
    const end = stroke.stops[reach - 1]!;
    const part = doc.createRange();
    part.setStart(stroke.range.startContainer, stroke.range.startOffset);
    part.setEnd(end[0], end[1] + 1);
    add(body, stroke.view, part);
    const tipStart = stroke.stops[Math.max(0, reach - TIP_CHARS)]!;
    const tip = doc.createRange();
    tip.setStart(tipStart[0], tipStart[1]);
    tip.setEnd(end[0], end[1] + 1);
    add(tips, stroke.view, tip);
  }
  strokes = running;
  for (const registry of registries) {
    registry.delete(NAME);
    registry.delete(TIP);
  }
  registries.clear();
  for (const view of new Set([...body.keys(), ...tips.keys()])) {
    const registry = view.CSS?.highlights;
    if (!registry || typeof view.Highlight !== "function") continue;
    const list = body.get(view);
    if (list?.length) registry.set(NAME, new view.Highlight(...list));
    const tipList = tips.get(view);
    if (tipList?.length) registry.set(TIP, new view.Highlight(...tipList));
    registries.add(registry);
  }
  if (strokes.length) frame = requestAnimationFrame(render);
}

// Each non-space character position inside the range, in reading order.
function stopsOf(range: Range): [Text, number][] {
  const stops: [Text, number][] = [];
  const root = range.commonAncestorContainer;
  const doc = range.startContainer.ownerDocument!;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = root.nodeType === 3 ? [root as Text] : [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    for (let i = from; i < to; i++) if (!/\s/.test(node.data[i]!)) stops.push([node, i]);
  }
  return stops;
}

const ids = new WeakMap<Node, number>();
let nextId = 0;
const idOf = (node: Node) => {
  let id = ids.get(node);
  if (id === undefined) {
    id = ++nextId;
    ids.set(node, id);
  }
  return id;
};
const keyOf = (r: Range) => `${idOf(r.startContainer)}:${r.startOffset}:${idOf(r.endContainer)}:${r.endOffset}`;

const reducedMotion = (view: View) => view.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
