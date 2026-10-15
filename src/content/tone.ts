// Whether a hit sits on a dark background, so its highlight can use the dark palette.
// Decided per element rather than per page: light articles often hold dark code blocks.

const DARK = "hunch-dark";

// Parses the rgb()/rgba() strings getComputedStyle returns; other color syntaxes are skipped.
function rgba(color: string): [number, number, number, number] | undefined {
  const m = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (!m) return undefined;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

// Relative luminance per WCAG, 0 (black) to 1 (white).
function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The nearest mostly opaque background behind the element; falls back to its text color,
// since light text implies a dark backdrop (e.g. a background image).
export function isDark(el: Element): boolean {
  const view = el.ownerDocument.defaultView ?? window;
  for (let node: Element | null = el; node; node = node.parentElement) {
    // Our own wash is not the page's background; look past already highlighted elements.
    if (node.classList.contains("hunch-hl")) continue;
    const bg = rgba(view.getComputedStyle(node).backgroundColor);
    if (bg && bg[3] >= 0.5) return luminance(bg) < 0.2;
    if (view.getComputedStyle(node).backgroundImage !== "none") break;
  }
  const fg = rgba(view.getComputedStyle(el).color);
  return fg ? luminance(fg) > 0.5 : false;
}

export function applyTone(el: HTMLElement) {
  el.classList.toggle(DARK, isDark(el));
}

export function clearTone(el: HTMLElement) {
  el.classList.remove(DARK);
}
