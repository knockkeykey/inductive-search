export type SentenceId = `S${string}`;

export interface Sentence {
  id: SentenceId;
  text: string;
  // Character offsets into the block text, end exclusive.
  start: number;
  end: number;
}

export const sentenceId = (i: number): SentenceId => `S${String(i).padStart(3, "0")}`;

// Sentences longer than this are cut again at commas so one hit can't cover a whole run-on sentence.
export const MAX_SENTENCE_CHARS = 60;
// Shorter blocks are already precise enough; the paragraph highlight stays as it is.
export const MIN_REFINE_CHARS = 80;
export const MIN_REFINE_SENTENCES = 3;
export const REFINE_TOP = 3;
export const MAX_MARKED_SENTENCES = 2;

export const SENTENCE_THRESHOLD = 0.7;
export const SENTENCE_THRESHOLD_MIN = 0.5;
export const SENTENCE_THRESHOLD_MAX = 0.95;
export const SENTENCE_THRESHOLD_STEP = 0.05;
export const validSentenceThreshold = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return SENTENCE_THRESHOLD;
  const snapped = Math.round(value / SENTENCE_THRESHOLD_STEP) * SENTENCE_THRESHOLD_STEP;
  return Number(Math.min(SENTENCE_THRESHOLD_MAX, Math.max(SENTENCE_THRESHOLD_MIN, snapped)).toFixed(2));
};

const END = /[。！？；…!?;\n]/;
const COMMA = /[，,、：:]/;
// Closing quotes and brackets belong to the sentence they end: “……去。”
const CLOSER = /[”’"'」』）)】》\s]/;

function cut(text: string, start: number, end: number, boundary: RegExp, out: [number, number][]) {
  let from = start;
  for (let i = start; i < end; i++) {
    const ch = text[i]!;
    const english = ch === "." && (i + 1 >= end || /\s/.test(text[i + 1]!));
    if (!boundary.test(ch) && !(boundary === END && english)) continue;
    let to = i + 1;
    while (to < end && CLOSER.test(text[to]!)) to++;
    out.push([from, to]);
    from = to;
    i = to - 1;
  }
  if (from < end) out.push([from, end]);
}

// Splits block text into sentences at 。！？； and line breaks, then cuts overlong ones at commas.
export function splitSentences(text: string): Sentence[] {
  const coarse: [number, number][] = [];
  cut(text, 0, text.length, END, coarse);
  const fine: [number, number][] = [];
  for (const [start, end] of coarse) {
    if (end - start > MAX_SENTENCE_CHARS) cut(text, start, end, COMMA, fine);
    else fine.push([start, end]);
  }
  const out: Sentence[] = [];
  for (let [start, end] of fine) {
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    // Stray punctuation on its own is not worth a question.
    if (!/[\p{L}\p{N}]/u.test(text.slice(start, end))) continue;
    out.push({ id: sentenceId(out.length + 1), text: text.slice(start, end), start, end });
  }
  return out;
}

// Sentences to score for a block, or none when the block is too short to refine.
export function refinableSentences(text: string): Sentence[] {
  if (text.length < MIN_REFINE_CHARS) return [];
  const sentences = splitSentences(text);
  return sentences.length >= MIN_REFINE_SENTENCES ? sentences : [];
}

// Up to two sentences at or above the threshold, highest scores first, returned in reading order.
export function pickSentences(
  sentences: readonly Sentence[],
  scores: Partial<Record<SentenceId, number>>,
  threshold = SENTENCE_THRESHOLD,
  max = MAX_MARKED_SENTENCES,
): Sentence[] {
  return sentences
    .filter((s) => (scores[s.id] ?? 0) >= threshold)
    .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))
    .slice(0, max)
    .sort((a, b) => a.start - b.start);
}
