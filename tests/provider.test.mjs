import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(path.join(tmpdir(), "hunch-tests-"));
const outfile = path.join(temp, "integration.mjs");
await build({
  stdin: {
    contents: `export * from "./src/shared/api";
      export * from "./src/shared/settings";
      export * from "./src/background/answer";`,
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
        contents: `export default {
          storage: { local: {
            get: async () => structuredClone(globalThis.hunchStorage),
            set: async (value) => { globalThis.hunchStorage = structuredClone(value); }
          } },
          permissions: {
            contains: async (origin) => { globalThis.hunchPermission = origin; return true; },
            request: async (origin) => { globalThis.hunchPermission = origin; return true; },
            remove: async (origin) => { globalThis.hunchRemoved = origin; return true; }
          }
        };`,
      }));
    },
  }],
});
const { answer, refine, retryFor, createClient, defaultSettings, hasApiAccess, listModels, loadSettings, normalizeBaseURL, releaseApiAccess, requestApiAccess, saveSettings, testConnection } =
  await import(pathToFileURL(outfile).href);
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  delete globalThis.hunchStorage;
  delete globalThis.hunchPermission;
  delete globalThis.hunchRemoved;
  await rm(temp, { recursive: true, force: true });
});

const search = {
  url: "https://example.com/article",
  title: "Example",
  query: "remote install",
  blocks: [{ id: "B000", text: "Install the system remotely over SSH." }],
};
const relay = { ...defaultSettings("custom"), apiKey: "relay-test-key", model: "jev-1.13.0", baseURL: "https://relay.example.com" };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

test("old official settings migrate and provider keys remain isolated", async () => {
  globalThis.hunchStorage = { settings: { apiKey: "official-test-key", model: "jev-1.13" } };
  assert.deepEqual(await loadSettings(), { provider: "typesafe", apiKey: "official-test-key", model: "jev-1.13" });
  assert.equal((await loadSettings("openrouter")).apiKey, "");
  await saveSettings({ ...defaultSettings("openrouter"), apiKey: "router-test-key" });
  assert.equal((await loadSettings()).provider, "openrouter");
  assert.equal((await loadSettings("typesafe")).apiKey, "official-test-key");
  await saveSettings(await loadSettings("typesafe"));
  assert.equal((await loadSettings("openrouter")).apiKey, "router-test-key");
  await saveSettings({ ...relay, model: "jev-1.13.0:stable" });
  assert.equal((await loadSettings()).provider, "custom");
  assert.equal((await loadSettings()).model, "jev-1.13.0:stable");
  assert.equal((await loadSettings()).baseURL, "https://relay.example.com");
  assert.equal((await loadSettings("openrouter")).apiKey, "router-test-key");
  assert.equal((await loadSettings("typesafe")).apiKey, "official-test-key");
  await saveSettings(await loadSettings("openrouter"));
  assert.equal((await loadSettings("custom")).apiKey, "relay-test-key");
  assert.equal((await loadSettings("openrouter")).baseURL, undefined);
  // Relays name their models differently, so a new relay starts without one.
  assert.equal(defaultSettings("custom").model, "");
});

test("a provider that is no longer built in falls back to TypeSafe", async () => {
  globalThis.hunchStorage = { settings: { provider: "retired", profiles: { typesafe: { apiKey: "official-test-key", model: "jev-latest" } } } };
  assert.deepEqual(await loadSettings(), { provider: "typesafe", apiKey: "official-test-key", model: "jev-latest" });
});

test("relay addresses are normalized to their root and must be https", () => {
  assert.equal(normalizeBaseURL(" https://relay.example.com/ "), "https://relay.example.com");
  assert.equal(normalizeBaseURL("https://relay.example.com/v1"), "https://relay.example.com");
  assert.equal(normalizeBaseURL("https://relay.example.com/v1/systemone"), "https://relay.example.com");
  assert.equal(normalizeBaseURL("https://relay.example.com/proxy/jev/v1/"), "https://relay.example.com/proxy/jev");
  assert.equal(normalizeBaseURL("http://localhost:8787"), "http://localhost:8787");
  assert.throws(() => normalizeBaseURL(""), /请填写中转站地址/);
  assert.throws(() => normalizeBaseURL("relay.example.com"), /地址无效/);
  assert.throws(() => normalizeBaseURL("http://relay.example.com"), /https/);
  assert.throws(() => normalizeBaseURL("https://user:pw@relay.example.com"), /不能包含/);
  assert.throws(() => normalizeBaseURL("https://relay.example.com/?key=1"), /不能包含/);
});

test("permissions target the selected host", async () => {
  await hasApiAccess(defaultSettings("openrouter"));
  assert.deepEqual(globalThis.hunchPermission, { origins: ["https://openrouter.ai/*"] });
  await requestApiAccess(defaultSettings("typesafe"));
  assert.deepEqual(globalThis.hunchPermission, { origins: ["https://api.typesafe.ai/*"] });
  await requestApiAccess({ ...relay, baseURL: "https://relay.example.com/proxy" });
  assert.deepEqual(globalThis.hunchPermission, { origins: ["https://relay.example.com/*"] });
  // No address yet: nothing to ask for, and no access.
  globalThis.hunchPermission = undefined;
  assert.equal(await hasApiAccess(defaultSettings("custom")), false);
  assert.equal(globalThis.hunchPermission, undefined);
});

test("moving the relay gives up the old host only", async () => {
  globalThis.hunchRemoved = undefined;
  await releaseApiAccess(relay, { ...relay, baseURL: "https://relay.example.com/other" });
  assert.equal(globalThis.hunchRemoved, undefined);
  await releaseApiAccess(defaultSettings("custom"), relay);
  assert.equal(globalThis.hunchRemoved, undefined);
  await releaseApiAccess(relay, { ...relay, baseURL: "https://new-relay.example.com" });
  assert.deepEqual(globalThis.hunchRemoved, { origins: ["https://relay.example.com/*"] });
  globalThis.hunchRemoved = undefined;
  await releaseApiAccess({ ...relay, baseURL: "https://openrouter.ai/api" }, relay);
  assert.equal(globalThis.hunchRemoved, undefined);
});

test("search sends each provider's key and Jev model to its own System One endpoint", async () => {
  for (const provider of ["typesafe", "openrouter", "custom"]) {
    const settings = { ...defaultSettings(provider), apiKey: `${provider}-test-key` };
    if (provider === "custom") Object.assign(settings, { baseURL: "https://relay.example.com", model: "jev-1.13.0" });
    const expectedURL = {
      typesafe: "https://api.typesafe.ai/v1/systemone",
      openrouter: "https://openrouter.ai/api/v1/systemone",
      custom: "https://relay.example.com/v1/systemone",
    }[provider];
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, expectedURL);
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${settings.apiKey}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, settings.model);
      assert.equal(body.questions.B000.type, "noul");
      assert.equal(body.state.page_text, "B000| Install the system remotely over SSH.");
      return json({ answers: { B000: { type: "noul", noul: 0.91 } }, model: settings.model, usage: { input_tokens: 100, output_tokens: 1 } });
    };
    const progress = [];
    await answer(search, settings, new AbortController().signal, (p) => progress.push(p));
    assert.equal(calls, 1);
    assert.equal(progress.at(-1).scores.B000, 0.91);
    assert.equal(progress.at(-1).failed, 0);
    assert.equal(createClient(settings).baseURL, expectedURL.replace("/v1/systemone", ""));
  }
});

test("a relay route keeps the relay key and the supplied model suffix", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://relay.example.com/v1/systemone");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer relay-test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-1.13.0:stable");
    assert.equal(body.messages, undefined);
    return json({ model: "jev-1.13.0", answers: { B000: { type: "noul", noul: 0.87 } }, usage: { input_tokens: 100, output_tokens: 1 } });
  };
  const progress = [];
  await answer(search, { ...relay, model: "jev-1.13.0:stable" }, new AbortController().signal, p => progress.push(p));
  assert.equal(progress.at(-1).scores.B000, 0.87);
});

test("relay model discovery accepts both list shapes and keeps only Jev models", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://relay.example.com/v1/models");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer relay-test-key");
    return json({ data: [{ id: "jev-1.13.0" }, { id: "jev-1.13.0:stable" }, { id: "gpt-test" }] });
  };
  assert.deepEqual((await listModels(relay)).map(m => m.name), ["jev-1.13.0", "jev-1.13.0:stable"]);
  globalThis.fetch = async () => json({ models: [{ name: "jev-latest", description: "Jev" }] });
  assert.deepEqual((await listModels(relay)).map(m => m.name), ["jev-latest"]);
  globalThis.fetch = async () => json({ data: [{ id: "gpt-test" }] });
  await assert.rejects(listModels(relay), /没有 Jev 模型/);
  globalThis.fetch = async () => json({}, 404);
  await assert.rejects(listModels(relay), /relay\.example\.com 模型列表加载失败（HTTP 404）/);
});

test("a relay splits long pages into smaller requests and accumulates all scores", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.ok(Object.keys(body.questions).length <= 40);
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.7 }]));
    return json({ answers, model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 1 } });
  };
  const blocks = Array.from({ length: 85 }, (_, i) => ({ id: `B${String(i).padStart(3, "0")}`, text: "A relevant paragraph." }));
  const progress = [];
  await answer({ ...search, blocks }, relay, new AbortController().signal, p => progress.push(p));
  assert.equal(calls, 3);
  assert.equal(Object.keys(progress.at(-1).scores).length, 85);
  assert.equal(progress.at(-1).total, 3);
});

test("a relay rejects chat responses, missing answers and invalid probabilities", async () => {
  for (const response of [
    { choices: [{ message: { content: "Hello" } }] },
    { answers: {} },
    { answers: { B000: { type: "noul", noul: 1.5 } } },
    { answers: { B000: { type: "noul", noul: "0.9" } } },
  ]) {
    globalThis.fetch = async () => json(response);
    await assert.rejects(
      answer(search, relay, new AbortController().signal, () => {}),
      /relay\.example\.com 返回了无效的 Jev 概率/,
    );
  }
});

test("the connection test sends fixed sample text once and reports the answering model", async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://relay.example.com/v1/systemone");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer relay-test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-1.13.0");
    assert.equal(body.state.url, "about:blank");
    assert.deepEqual(Object.keys(body.questions), ["B000"]);
    return json({ model: "jev-1.13.0", answers: { B000: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 10, output_tokens: 1 } });
  };
  const result = await testConnection(relay);
  assert.equal(calls, 1);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(typeof result.ms, "number");
});

test("the connection test explains failures and never retries", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ error: { message: "当前令牌下该模型暂无可用渠道" } }, 503);
  };
  await assert.rejects(testConnection(relay), /relay\.example\.com 返回 HTTP 503/);
  assert.equal(calls, 1);
  globalThis.fetch = async () => json({ error: { message: "当前令牌下该模型暂无可用渠道" } }, 404);
  await assert.rejects(testConnection(relay), /HTTP 404.*模型或接口不存在.*暂无可用渠道/);
  globalThis.fetch = async () => json({ choices: [{ message: { content: "Hello" } }] });
  await assert.rejects(testConnection(relay), /不是 Jev System One 的结果/);
});

test("model discovery adapts OpenRouter's shape and excludes chat models", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    assert.equal(init.headers, undefined);
    return json({ data: [{ id: "typesafe/jev-1.13", name: "Jev" }, { id: "typesafe/jev-router", name: "Chat router" }, { id: "openai/gpt-test", name: "Chat" }] });
  };
  assert.deepEqual(await listModels(defaultSettings("openrouter")), [
    { name: "~typesafe/jev-latest", description: "最新 Jev" },
    { name: "typesafe/jev-1.13", description: "Jev" },
  ]);
  globalThis.fetch = async () => json({ models: [{ name: "jev-1.13", description: "Jev" }] });
  assert.equal((await listModels({ ...defaultSettings(), apiKey: "official-test-key" }))[0].name, "jev-1.13");
});

test("documented decision models remain available when the public catalog only has Jev Router", async () => {
  globalThis.fetch = async () => json({ data: [{ id: "typesafe/jev-router", name: "Chat router" }] });
  assert.deepEqual((await listModels(defaultSettings("openrouter"))).map((m) => m.name), [
    "~typesafe/jev-latest", "typesafe/jev-1.13",
  ]);
});

test("authentication failure reaches the caller instead of becoming an absent answer", async () => {
  globalThis.fetch = async () => json({ error: { message: "Invalid API key", code: 401 } }, 401);
  await assert.rejects(
    answer(search, { ...defaultSettings("openrouter"), apiKey: "invalid-test-key" }, new AbortController().signal, () => {}),
    /401|Invalid API key/,
  );
});

test("a failed batch reports the provider's status, message and request id", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
      status: 402, headers: { "Content-Type": "application/json", "x-typesafe-request-id": "req_123" },
    });
  const progress = [];
  await assert.rejects(
    answer(search, { ...defaultSettings("openrouter"), apiKey: "router-test-key" }, new AbortController().signal, (p) => progress.push(p)),
    /OpenRouter 返回 HTTP 402：账户余额或额度不足。原始信息：Insufficient credits（请求 ID：req_123）/,
  );
  assert.equal(progress.at(-1).failed, 1);
  assert.match(progress.at(-1).error, /HTTP 402.*Insufficient credits/);
});

test("closing a search cancels the provider request without emitting more progress", async () => {
  const controller = new AbortController();
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    controller.abort();
  });
  const progress = [];
  await answer(search, { ...defaultSettings("openrouter"), apiKey: "router-test-key" }, controller.signal, (p) => progress.push(p));
  assert.deepEqual(progress, []);
});

test("large batches are not retried after a timeout; small ones are", () => {
  assert.deepEqual(retryFor([{ id: "B001", text: "x".repeat(20_000) }]), { apiTimeoutError: false });
  assert.deepEqual(retryFor([{ id: "B001", text: "short paragraph" }]), { apiTimeoutError: true });
});

test("refine scores each paragraph in its own request, never showing it the other paragraphs", async () => {
  const pages = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    pages.push(body.state.page_text);
    const text = body.state.page_text;
    // The B004 paragraph comes back invalid: only that paragraph loses its sentence scores.
    const answers = text.includes("Three.")
      ? { S001: { type: "noul", noul: 2 } }
      : { S001: { type: "noul", noul: 0.2 }, S002: { type: "noul", noul: 0.9 } };
    assert.deepEqual(Object.keys(body.questions), Object.keys(answers));
    return json({ answers, model: "jev-1.13", usage: { input_tokens: 100, output_tokens: 1 } });
  };
  const result = await refine(
    {
      type: "refine",
      url: search.url,
      title: search.title,
      query: search.query,
      paragraphs: [
        { id: "B001", sentences: [{ id: "S001", text: "One." }, { id: "S002", text: "Two." }] },
        { id: "B004", sentences: [{ id: "S001", text: "Three." }] },
      ],
    },
    { ...defaultSettings(), apiKey: "official-test-key" },
  );
  assert.deepEqual(pages.sort(), ["S001| One.\nS002| Two.", "S001| Three."]);
  assert.deepEqual(result, { scores: { B001: { S001: 0.2, S002: 0.9 } } });
});

test("condition refine asks each sentence once per condition and combines like paragraph scores", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body.questions).sort(), ["S001_C1", "S001_C2", "S002_C1", "S002_C2"]);
    const answers = {
      S001_C1: { type: "noul", noul: 0.9 },
      S001_C2: { type: "noul", noul: 0.1 },
      S002_C1: { type: "noul", noul: 0.6 },
      S002_C2: { type: "noul", noul: 0.7 },
    };
    return json({ answers, model: "jev-1.13", usage: { input_tokens: 100, output_tokens: 1 } });
  };
  const paragraphs = [{ id: "B001", sentences: [{ id: "S001", text: "One." }, { id: "S002", text: "Two." }] }];
  const settings = { ...defaultSettings(), apiKey: "official-test-key" };
  for (const [combination, expected] of [["all", { S001: 0.1, S002: 0.6 }], ["any", { S001: 0.9, S002: 0.7 }]]) {
    const result = await refine(
      { type: "refine", url: search.url, title: search.title, query: "A；B", conditions: ["A", "B"], combination, paragraphs },
      settings,
    );
    assert.deepEqual(result, { scores: { B001: expected } });
  }
});
