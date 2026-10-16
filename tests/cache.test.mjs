import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(path.join(tmpdir(), "hunch-cache-"));
const outfile = path.join(temp, "cache.mjs");
await build({
  stdin: {
    contents: `export * from "./src/shared/cache"; export * from "./src/background/answer"; export * from "./src/shared/api";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  plugins: [{
    name: "mock-browser",
    setup(build) {
      build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: "browser", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: `export default { storage: { local: {
          get: async (key) => ({ [key]: structuredClone(globalThis.hunchCacheStorage[key]) }),
          set: async (value) => { Object.assign(globalThis.hunchCacheStorage, structuredClone(value)); },
          remove: async (key) => { delete globalThis.hunchCacheStorage[key]; },
        } } };`,
      }));
    },
  }],
});
const { answer, refine, cacheEnabled, setCacheEnabled, normalizeQuery, readCache, writeCache, defaultSettings, CACHE_MAX_ENTRIES } =
  await import(pathToFileURL(outfile).href);
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  delete globalThis.hunchCacheStorage;
  await rm(temp, { recursive: true, force: true });
});
beforeEach(() => {
  globalThis.hunchCacheStorage = {};
});

const settings = { ...defaultSettings("custom"), apiKey: "dummy-test-key", model: "jev-1.13.0", baseURL: "https://relay.example.com" };
const search = {
  url: "https://example.com/article#top",
  title: "Example",
  query: "有什么优点？",
  blocks: [{ id: "B000", text: "续航很长，屏幕也很亮。" }],
};
const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
let calls = 0;
const mockFetch = (noul = 0.8) => {
  calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul }]));
    return json({ answers, model: settings.model, usage: { input_tokens: 1, output_tokens: 1 } });
  };
};
const run = async (req, s = settings, cache = true) => {
  const progress = [];
  await answer(req, s, new AbortController().signal, (p) => progress.push(p), cache);
  return progress.at(-1);
};

test("questions match after trimming spaces, case and trailing punctuation", () => {
  assert.equal(normalizeQuery("  What   ARE the pros?? "), "what are the pros");
  assert.equal(normalizeQuery("有什么优点？"), normalizeQuery("有什么优点"));
  assert.notEqual(normalizeQuery("有什么优点"), normalizeQuery("有什么缺点"));
});

test("the same page and question are answered from the cache without calling the API", async () => {
  mockFetch(0.8);
  assert.equal((await run(search)).scores.B000, 0.8);
  assert.equal(calls, 1);
  mockFetch(0.1);
  const cached = await run({ ...search, url: "https://example.com/article", query: " 有什么优点 " });
  assert.equal(calls, 0);
  assert.equal(cached.scores.B000, 0.8);
  assert.equal(cached.done, cached.total);
  assert.equal(cached.failed, 0);
  assert.ok(!JSON.stringify(globalThis.hunchCacheStorage).includes("续航"), "page text is never stored");
});

test("a changed page, question, model or a disabled cache misses", async () => {
  mockFetch();
  await run(search);
  for (const [req, s] of [
    [{ ...search, blocks: [{ id: "B000", text: "续航很长。" }] }, settings],
    [{ ...search, url: "https://example.com/other" }, settings],
    [{ ...search, query: "有什么缺点" }, settings],
    [search, { ...settings, model: "jev-1.13.0:stable" }],
    [search, { ...settings, baseURL: "https://other-relay.example.com" }],
    [{ ...search, mode: "conditions", conditions: ["有什么优点"] }, settings],
  ]) {
    mockFetch();
    await run(req, s);
    assert.equal(calls, 1);
  }
  mockFetch();
  await run(search, settings, false);
  assert.equal(calls, 1);
});

test("searches with failed batches are not cached", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 400 });
  await assert.rejects(run(search));
  mockFetch();
  await run(search);
  assert.equal(calls, 1);
});

test("sentence scores are cached per paragraph", async () => {
  const req = {
    type: "refine",
    url: search.url,
    title: search.title,
    query: search.query,
    paragraphs: [{ id: "B001", sentences: [{ id: "S001", text: "One." }, { id: "S002", text: "Two." }] }],
  };
  mockFetch(0.7);
  const first = await refine(req, settings, undefined, true);
  mockFetch(0.2);
  assert.deepEqual(await refine(req, settings, undefined, true), first);
  assert.equal(calls, 0);
});

test("turning the cache off clears it; the oldest unused entries go past the limit", async () => {
  assert.equal(await cacheEnabled(), true);
  mockFetch();
  await run(search);
  await setCacheEnabled(false);
  assert.equal(await cacheEnabled(), false);
  assert.equal(globalThis.hunchCacheStorage.searchCache, undefined);

  await writeCache(Array.from({ length: CACHE_MAX_ENTRIES }, (_, i) => ({ key: `k${i}`, value: i })));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await readCache("k0"), 0);
  await writeCache([{ key: "new", value: "x" }]);
  const keys = Object.keys(globalThis.hunchCacheStorage.searchCache);
  assert.equal(keys.length, CACHE_MAX_ENTRIES);
  assert.ok(keys.includes("k0") && keys.includes("new") && !keys.includes("k1"));
});
