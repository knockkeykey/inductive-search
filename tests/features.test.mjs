import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const temp = await mkdtemp(path.join(tmpdir(), 'hunch-features-'));
globalThis.hunchFeatureStorage = {};
const outfile = path.join(temp, 'features.mjs');
await build({
  stdin: { resolveDir: process.cwd(), contents: `export * from './src/shared/questions'; export * from './src/shared/excerpts'; export * from './src/background/excerpts'; export * from './src/background/answer'; export * from './src/content/blocks'; export * from './src/content/hits';` },
  bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'storage', setup(build) {
    build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: 'browser', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export default { storage: { local: {
      get: async key => ({ [key]: structuredClone(globalThis.hunchFeatureStorage[key]) }),
      set: async value => { Object.assign(globalThis.hunchFeatureStorage, structuredClone(value)); }
    } } };` }));
  }}],
});
const api = await import(pathToFileURL(outfile).href);
const widgetBundle = await build({ entryPoints: ['src/content.ts'], bundle: true, format: 'iife', write: false,
  plugins: [{ name: 'widget-browser', setup(build) {
    build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: 'browser', namespace: 'widget' }));
    build.onLoad({ filter: /.*/, namespace: 'widget' }, () => ({ contents: 'export default window.hunchTestBrowser;' }));
  }}],
});


const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; delete globalThis.hunchFeatureStorage; await rm(temp, { recursive: true, force: true }); });
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const settings = { provider: 'openlux', model: 'jev-1.13.0', apiKey: 'dummy-test-key' };
const request = { url: 'https://example.com/article', title: 'Test', query: 'test', blocks: [{ id: 'B001', text: 'Test evidence.' }] };

test('condition mode evaluates each condition and applies all/any without inventing a joint probability', async () => {
  assert.deepEqual(api.parseConditions(' 有数据\n\n实测\n有数据 '), ['有数据', '实测']);
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body.questions), ['B001_C1', 'B001_C2']);
    assert.equal(body.questions.B001_C1.instructions.condition, '有数据');
    return json({ answers: { B001_C1: { type: 'noul', noul: .8 }, B001_C2: { type: 'noul', noul: .2 } } });
  };
  for (const [combination, expected] of [['all', .2], ['any', .8]]) {
    const progress = [];
    await api.answer({ ...request, mode: 'conditions', conditions: ['有数据', '实测'], combination }, settings, new AbortController().signal, p => progress.push(p));
    assert.equal(progress.at(-1).scores.B001, expected);
    assert.deepEqual(progress.at(-1).conditionScores.B001, [.8, .2]);
  }
});

test('condition requests respect the per-request question budget', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.ok(Object.keys(body.questions).length <= 40);
    return json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: .9 }])) });
  };
  const blocks = Array.from({ length: 17 }, (_, i) => ({ id: `B${i}`, text: 'Evidence.' }));
  const progress = [];
  await api.answer({ ...request, blocks, mode: 'conditions', conditions: ['A', 'B', 'C', 'D', 'E'] }, settings, new AbortController().signal, p => progress.push(p));
  assert.equal(calls, 3);
  assert.equal(Object.keys(progress.at(-1).scores).length, 17);
  await assert.rejects(api.answer({ ...request, mode: 'conditions', conditions: [] }, settings, new AbortController().signal, () => {}), /between 1 and 5/);
});

const draft = { title: 'Test [source]', url: 'https://example.com/article', text: 'Original quote\nwith two lines.', heading: 'Evidence', query: 'find evidence', conditions: ['has data'], combination: 'all', scope: 'article' };
test('parallel excerpt saves preserve both records, deduplicate, survive reload and delete only the selected record', async () => {
  globalThis.hunchFeatureStorage = {};
  const results = await Promise.all([api.handleExcerpts({ type: 'excerpt-save', excerpt: draft }), api.handleExcerpts({ type: 'excerpt-save', excerpt: { ...draft, text: 'Another quote' } })]);
  assert.ok(results.every(result => result.ok));
  let result = await api.handleExcerpts({ type: 'excerpt-save', excerpt: draft });
  assert.equal(result.excerpts.length, 2);
  result = await api.handleExcerpts({ type: 'excerpt-list' });
  assert.equal(result.excerpts.length, 2);
  assert.equal(result.excerpts[0].url, draft.url);
  assert.deepEqual(result.excerpts[0].conditions, ['has data']);
  const markdown = api.excerptsMarkdown(result.excerpts);
  assert.match(markdown, /https:\/\/example.com\/article/);
  assert.ok(markdown.includes('> Original quote\n> with two lines.'));
  assert.ok(markdown.includes('全部满足'));
  assert.ok(markdown.includes('Test \\[source\\]'));
  result = await api.handleExcerpts({ type: 'excerpt-delete', id: result.excerpts[0].id });
  assert.equal(result.excerpts.length, 1);
  assert.equal((await api.handleExcerpts({ type: 'excerpt-save', excerpt: { ...draft, url: 'javascript:alert(1)' } })).ok, false);
});

function domFixture() {
  const dom = new JSDOM(`<!doctype html><style>span,a,strong { display:inline } hunch-ui { display:none } nav,article,p,h1 {display:block}</style>
    <nav><p>Navigation menu containing words.</p></nav><article><h1>正文标题</h1><p id="one">开头文字 <strong>selected evidence</strong> 结尾文字。</p><p id="duplicate">Repeated paragraph for testing.</p><p>Repeated paragraph for testing.</p><div contenteditable="">Private draft that must never be extracted.</div></article><footer><p>Footer content should be excluded.</p></footer>`, { url: 'https://example.com/article', pretendToBeVisual: true, runScripts: 'outside-only' });
  const window = dom.window;
  Object.defineProperty(window.HTMLElement.prototype, 'checkVisibility', { value() { return window.getComputedStyle(this).display !== 'none'; } });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  for (const name of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'location']) globalThis[name] = name === 'window' ? window : window[name];
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  return dom;
}

test('page/article/selection scopes keep their boundaries and repeated occurrences', () => {
  const dom = domFixture();
  assert.ok(api.extractBlocks('page').some(block => block.text.includes('Navigation')));
  assert.ok(api.extractBlocks('page').every(block => !block.text.includes('Private draft')));
  const article = api.extractBlocks('article');
  assert.ok(article.every(block => !block.text.includes('Navigation') && !block.text.includes('Footer')));
  assert.equal(article.filter(block => block.text === 'Repeated paragraph for testing.').length, 2);
  assert.ok(article.some(block => block.text === '正文标题'));
  const node = document.querySelector('strong').firstChild;
  const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 8);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  const selected = api.extractBlocks('selection', api.captureSelection());
  assert.equal(selected.length, 1);
  assert.equal(selected[0].text, 'selected');
  assert.equal(selected[0].heading, '正文标题');
  dom.window.close();
});

test('find bar submits two-character queries, renders evidence, saves source and aborts without a delayed search', async () => {
  const dom = domFixture(); const w = dom.window;
  const requests = [];
  let toggle; let shadow;
  w.ResizeObserver = class { observe() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.localName === 'hunch-ui') shadow = root; return root; };
  w.hunchTestBrowser = { runtime: {
    getURL: () => 'https://example.com/ui.css', onMessage: { addListener(callback) { toggle = callback; } },
    sendMessage: message => api.handleExcerpts(message),
    connect() {
      let receive;
      return {
        onMessage: { addListener(callback) { receive = callback; } }, onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(req) {
          requests.push(req);
          queueMicrotask(() => receive({ type: 'progress', scores: Object.fromEntries(req.blocks.map(b => [b.id, .9])), conditionScores: req.mode === 'conditions' ? Object.fromEntries(req.blocks.map(b => [b.id, [.9]])) : undefined, done: 1, total: 1, failed: 0, ms: 25 }));
        },
      };
    },
  } };
  w.eval(widgetBundle.outputFiles[0].text);
  toggle({ type: 'toggle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('hunch-ui').shadowRoot, null, 'saved excerpts must use a closed shadow root');
  const frame = shadow.querySelector('.hunch-scope');
  assert.ok(!frame.hidden && frame.textContent.includes('整页'), 'the search range is outlined by default while the bar is open');
  const scopeToggle = shadow.querySelector('[aria-label="标出搜索范围"]');
  scopeToggle.click();
  assert.ok(frame.hidden && scopeToggle.getAttribute('aria-pressed') === 'false');
  scopeToggle.click();
  assert.ok(!frame.hidden);
  const host = document.querySelector('hunch-ui');
  const themeToggle = shadow.querySelector('.hunch-theme-toggle');
  themeToggle.click(); assert.equal(host.dataset.theme, 'light');
  themeToggle.click(); assert.equal(host.dataset.theme, 'dark');
  themeToggle.click(); assert.equal(host.dataset.theme, undefined, 'third click returns to following the system');
  const input = shadow.querySelector('input');
  input.value = '退款'; input.dispatchEvent(new w.Event('input'));
  assert.equal(requests.length, 0, 'typing alone must not spend an API request');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(requests.length, 0, 'IME confirmation must not submit');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].query, '退款');
  assert.ok(shadow.querySelector('.hunch-peek-hit').textContent.includes('语义'));
  assert.ok(!shadow.querySelector('.hunch-sidebar'), 'results must not open a sidebar');
  const saveButton = shadow.querySelector('.hunch-peek-hit [aria-label="保存摘录"]');
  saveButton.click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(shadow.querySelector('.hunch-peek-hit [aria-label="已保存"]').disabled);
  shadow.querySelector('[aria-label="已存摘录"]').click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(shadow.querySelector('.hunch-peek-saved:not([hidden]) .hunch-saved'), 'saved excerpts open in the card above the bar');
  assert.ok(globalThis.hunchFeatureStorage.excerpts.some(e => e.query === '退款' && e.url === 'https://example.com/article'));
  const scope = shadow.querySelector('[aria-label="搜索范围"]');
  scope.value = 'article'; scope.dispatchEvent(new w.Event('change'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests[1].blocks.every(block => !block.text.includes('Navigation')));
  const selectedNode = document.querySelector('strong').firstChild;
  const range = document.createRange(); range.setStart(selectedNode, 0); range.setEnd(selectedNode, 8);
  w.getSelection().removeAllRanges(); w.getSelection().addRange(range);
  document.dispatchEvent(new w.Event('selectionchange'));
  scope.value = 'selection'; scope.dispatchEvent(new w.Event('change'));
  const mode = shadow.querySelector('[aria-label="查找方式"]');
  mode.querySelector('[data-value="conditions"]').click();
  assert.equal(mode.querySelector('[data-value="conditions"]').getAttribute('aria-checked'), 'true');
  assert.ok(!shadow.querySelector('textarea'), 'conditions are separate rows, not a free-form textarea');
  const first = shadow.querySelector('.hunch-condition-input'); first.value = '有证据';
  first.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.equal(requests.length, 2, 'Enter on a filled condition adds a row instead of searching');
  const rows = shadow.querySelectorAll('.hunch-condition-input');
  assert.equal(rows.length, 2);
  assert.equal(shadow.activeElement, rows[1]);
  rows[1].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Backspace' }));
  assert.equal(shadow.querySelectorAll('.hunch-condition-input').length, 1, 'Backspace on an empty row removes it');
  assert.ok(shadow.querySelector('.hunch-grabber'), 'the dock has a drag handle');
  const combination = shadow.querySelector('[aria-label="条件组合"]'); combination.value = 'any';
  shadow.querySelector('.hunch-submit').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[2].blocks[0].text, 'selected');
  assert.equal(requests[2].mode, 'conditions');
  assert.equal(requests[2].combination, 'any');
  assert.equal(JSON.stringify(requests[2].conditions), '["有证据"]');
  assert.ok(shadow.querySelector('.hunch-condition-evidence').textContent.includes('有证据'));
  input.value = '新搜索'; input.dispatchEvent(new w.Event('input'));
  toggle({ type: 'toggle' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(requests.length, 3, 'closing must not allow delayed searches');
  assert.ok(frame.hidden, 'the range outline goes away with the bar');
  dom.window.close();
});
