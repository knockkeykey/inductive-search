// Turns pdf.js text items into readable paragraphs. PDFs store positioned glyph runs, not
// paragraphs, so lines are rebuilt from baselines and split where the vertical gap widens.

export interface TextRun {
  str: string;
  // pdf.js transform: [a, b, c, d, x, y]; y grows upward in PDF space.
  transform: number[];
  height: number;
  hasEOL?: boolean;
}

const CJK = /[　-鿿가-힯＀-￯]/;

// Joins two pieces of text the way a reader would: no space between CJK characters,
// a hyphenated line break rejoins the word, otherwise one space.
export function joinText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/[A-Za-z]-$/.test(left) && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  if (CJK.test(left.at(-1)!) || CJK.test(right[0]!)) return left + right;
  return `${left} ${right}`;
}

interface Line {
  y: number;
  height: number;
  text: string;
}

export function paragraphs(runs: readonly TextRun[]): string[] {
  const lines: Line[] = [];
  for (const run of runs) {
    if (!run.str) continue;
    const y = run.transform[5] ?? 0;
    const height = Math.abs(run.height || run.transform[3] || 10);
    const last = lines.at(-1);
    // Runs on the same baseline (within a third of the text height) belong to one line.
    if (last && Math.abs(last.y - y) < Math.max(last.height, height) / 3) {
      last.text = joinText(last.text, run.str);
      last.height = Math.max(last.height, height);
    } else {
      lines.push({ y, height, text: run.str });
    }
  }

  const out: string[] = [];
  let current = "";
  let previous: Line | undefined;
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (previous) {
      const gap = previous.y - line.y;
      // A gap well beyond normal line spacing, a jump upward (new column) or a size change
      // (heading) starts a new paragraph.
      const lineHeight = Math.max(previous.height, line.height);
      const breaks = gap > lineHeight * 1.8 || gap < 0 || Math.abs(previous.height - line.height) > lineHeight * 0.25;
      if (breaks && current) {
        out.push(current);
        current = "";
      }
    }
    current = joinText(current, text);
    previous = line;
  }
  if (current) out.push(current);
  return out;
}
