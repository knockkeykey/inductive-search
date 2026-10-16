import browser from "webextension-polyfill";
import type { Progress, Refine, RefineResult, Search } from "./protocol";
import type { Settings } from "./settings";

// Results of finished searches, keyed by a hash of the page and the question. Only hashes and
// scores are stored; the page text itself never is.
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 200;
const ENTRIES_KEY = "searchCache";
const ENABLED_KEY = "cacheEnabled";

interface Entry {
  created: number;
  used: number;
  value: unknown;
}
type Entries = Record<string, Entry>;

export async function cacheEnabled(): Promise<boolean> {
  const stored = (await browser.storage.local.get(ENABLED_KEY)) as { cacheEnabled?: boolean };
  return stored.cacheEnabled !== false;
}

// Turning the cache off also forgets everything it held.
export async function setCacheEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [ENABLED_KEY]: enabled });
  if (!enabled) await clearCache();
}

export async function clearCache(): Promise<void> {
  await enqueue(() => browser.storage.local.remove(ENTRIES_KEY));
}

// Same question, written a little differently: spacing, letter case and a trailing ？/。/! don't matter.
export const normalizeQuery = (query: string) =>
  query
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[\s?？。.!！~～]+$/u, "");

const pageKey = (url: string) => url.replace(/#.*$/, "");

const question = (req: Pick<Search, "query" | "mode" | "conditions" | "combination">) =>
  req.mode === "conditions" || req.conditions?.length
    ? { conditions: (req.conditions ?? []).map(normalizeQuery), combination: req.combination ?? "all" }
    : { query: normalizeQuery(req.query) };

const model = (settings: Settings) => ({
  provider: settings.provider,
  model: settings.model,
  ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
});

export const searchKey = (req: Search, settings: Settings) =>
  hash({
    kind: "search",
    url: pageKey(req.url),
    scope: req.scope ?? "page",
    ...model(settings),
    ...question(req),
    blocks: req.blocks.map((b) => [b.id, b.text]),
  });

export const paragraphKey = (req: Refine, paragraph: Refine["paragraphs"][number], settings: Settings) =>
  hash({
    kind: "refine",
    url: pageKey(req.url),
    ...model(settings),
    ...question(req),
    sentences: paragraph.sentences.map((s) => [s.id, s.text]),
  });

export type CachedSearch = Pick<Progress, "scores" | "conditionScores" | "total">;
export type CachedSentences = NonNullable<RefineResult["scores"][keyof RefineResult["scores"]]>;

export async function readCache<T>(key: string): Promise<T | undefined> {
  const entries = await load();
  const entry = entries[key];
  if (!entry) return undefined;
  const now = Date.now();
  if (now - entry.created > CACHE_TTL_MS) {
    void enqueue(async () => {
      const latest = await load();
      delete latest[key];
      await save(latest);
    });
    return undefined;
  }
  void enqueue(async () => {
    const latest = await load();
    if (latest[key]) latest[key].used = now;
    await save(latest);
  });
  return entry.value as T;
}

export async function writeCache(items: { key: string; value: unknown }[]): Promise<void> {
  if (!items.length) return;
  await enqueue(async () => {
    const entries = await load();
    const now = Date.now();
    for (const { key, value } of items) entries[key] = { created: now, used: now, value };
    for (const [key, entry] of Object.entries(entries)) {
      if (now - entry.created > CACHE_TTL_MS) delete entries[key];
    }
    // Over the limit: drop the entries used least recently.
    const keys = Object.keys(entries);
    if (keys.length > CACHE_MAX_ENTRIES) {
      const stale = keys.sort((a, b) => entries[a]!.used - entries[b]!.used).slice(0, keys.length - CACHE_MAX_ENTRIES);
      for (const key of stale) delete entries[key];
    }
    await save(entries);
  });
}

async function load(): Promise<Entries> {
  const stored = (await browser.storage.local.get(ENTRIES_KEY)) as { searchCache?: Entries };
  return stored.searchCache ?? {};
}
const save = (entries: Entries) => browser.storage.local.set({ [ENTRIES_KEY]: entries });

// Read-modify-write of one storage key; serialise them so concurrent searches don't lose entries.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
