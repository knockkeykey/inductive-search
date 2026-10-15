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
  stdin: { resolveDir: process.cwd(), contents: `export * from './src/shared/questions'; export * from './src/background/answer'; export * from './src/content/blocks'; export * from './src/content/hits';` },
  bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'storage', setup(build) {
    build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: 'browser', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export default { runtime: { getURL: path => 'chrome-extension://test/' + path }, storage: { local: {
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
    // Each condition is asked exactly like a 按问题 search for that text.
    assert.deepEqual(body.questions.B001_C1, api.questionsFor('有数据', ['B001']).B001);
    assert.deepEqual(body.questions.B001_C2, api.questionsFor('实测', ['B001']).B001);
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
  await api.answer({ ...request, blocks, mode: 'conditions', conditions: ['A', 'B', 'C'] }, settings, new AbortController().signal, p => progress.push(p));
  assert.equal(calls, 2);
  assert.equal(Object.keys(progress.at(-1).scores).length, 17);
  await assert.rejects(api.answer({ ...request, mode: 'conditions', conditions: [] }, settings, new AbortController().signal, () => {}), /请输入 1 至 3 个条件/);
  await assert.rejects(api.answer({ ...request, mode: 'conditions', conditions: ['A', 'B', 'C', 'D'] }, settings, new AbortController().signal, () => {}), /请输入 1 至 3 个条件/);
});

// jsdom never fetches stylesheets; the widget waits for ui.css before it first opens.
const stylesLoaded = (shadow, w) => shadow.querySelector('link[rel="stylesheet"]').dispatchEvent(new w.Event('load'));

function domFixture() {
  const dom = new JSDOM(`<!doctype html><style>span,a,strong { display:inline } hunch-ui { display:none } nav,article,p,h1 {display:block}</style>
    <nav><p>Navigation menu containing words.</p></nav><article><h1>正文标题</h1><p id="one">开头文字 <strong>selected evidence</strong> 结尾文字。</p><p id="duplicate">Repeated paragraph for testing.</p><p>Repeated paragraph for testing.</p><div contenteditable="">Private draft that must never be extracted.</div></article><footer><p>Footer content should be excluded.</p></footer>`, { url: 'https://example.com/article', pretendToBeVisual: true, runScripts: 'outside-only' });
  const window = dom.window;
  Object.defineProperty(window.HTMLElement.prototype, 'checkVisibility', { value() { return window.getComputedStyle(this).display !== 'none'; } });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  // jsdom has no layout; ranges report an empty box like an off-screen selection.
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 0, 0);
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

test('find bar submits two-character queries, shows results only on the page and aborts without a delayed search', async () => {
  const dom = domFixture(); const w = dom.window;
  document.querySelector('article').getBoundingClientRect = () => new w.DOMRect(20, 30, 600, 400);
  const requests = [];
  let toggle; let shadow;
  w.ResizeObserver = class { observe() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.localName === 'hunch-ui') shadow = root; return root; };
  w.hunchTestBrowser = { runtime: {
    getURL: () => 'https://example.com/ui.css', onMessage: { addListener(callback) { toggle = callback; } },
    sendMessage: async () => undefined,
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
  stylesLoaded(shadow, w);
  toggle({ type: 'toggle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('hunch-ui').shadowRoot, null, 'the search UI uses a closed shadow root');
  const frame = shadow.querySelector('.hunch-scope');
  assert.ok(!frame.hidden && frame.textContent.includes('正文'), 'the article search range is outlined by default while the bar is open');
  assert.equal(shadow.querySelector('[aria-label="搜索范围"]').value, 'article');
  assert.ok(shadow.querySelector('.hunch-status').hidden, 'idle state does not show the total block count');
  const scopeToggle = shadow.querySelector('[aria-label="标出搜索范围"]');
  scopeToggle.click();
  assert.ok(frame.hidden && scopeToggle.getAttribute('aria-pressed') === 'false');
  scopeToggle.click();
  assert.ok(!frame.hidden);
  const host = document.querySelector('hunch-ui');
  const gear = shadow.querySelector('.hunch-settings-toggle');
  const panel = shadow.querySelector('.hunch-settings');
  assert.ok(panel.hidden, 'settings start closed');
  gear.click();
  assert.ok(!panel.hidden && gear.getAttribute('aria-expanded') === 'true', 'the gear opens the settings panel');
  const help = panel.querySelector('.hunch-help');
  assert.ok(help.hidden);
  panel.querySelector('.hunch-help-toggle').click();
  assert.ok(!help.hidden && help.textContent.includes('段落阈值'), 'the question mark explains the judging rules');
  panel.querySelector('[data-value="light"]').click(); assert.equal(host.dataset.theme, 'light');
  panel.querySelector('[data-value="dark"]').click(); assert.equal(host.dataset.theme, 'dark');
  panel.querySelector('[data-value="auto"]').click(); assert.equal(host.dataset.theme, 'dark', 'auto contrasts with the light page background, not the system');
  const refineSwitch = panel.querySelector('.hunch-switch');
  assert.ok(refineSwitch.checked, 'in-paragraph locating is on by default');
  const sentenceRow = panel.querySelector('.hunch-setting-child');
  assert.ok(sentenceRow.querySelector('[aria-label="句子阈值"]'), 'the sentence threshold is nested under the switch');
  assert.equal(sentenceRow.parentElement, refineSwitch.closest('.hunch-setting-group'));
  refineSwitch.click();
  assert.ok(sentenceRow.hasAttribute('data-disabled') && sentenceRow.querySelector('input').disabled, 'turning the switch off disables its child');
  refineSwitch.click();
  assert.ok(!sentenceRow.hasAttribute('data-disabled'));
  panel.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(panel.hidden, 'Escape closes the settings panel');
  const input = shadow.querySelector('input');
  const arrow = (target, key, extra = {}) => {
    const event = new w.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(arrow(input, 'ArrowDown').defaultPrevented, false, 'no results leaves arrow keys alone');
  input.value = '退款'; input.dispatchEvent(new w.Event('input'));
  assert.equal(requests.length, 0, 'typing alone must not spend an API request');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(requests.length, 0, 'IME confirmation must not submit');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].query, '退款');
  assert.ok(requests[0].blocks.every(block => !block.text.includes('Navigation') && !block.text.includes('Footer')));
  assert.ok(document.querySelector('.hunch-current'), 'the first result is highlighted on the page');
  const counter = shadow.querySelector('.hunch-counter');
  const total = Number(counter.textContent.split('/')[1].trim());
  assert.ok(total > 1);
  const firstHit = document.querySelector('.hunch-current');
  input.focus();
  assert.ok(arrow(input, 'ArrowDown').defaultPrevented, 'down navigates from the search input and prevents page scrolling');
  assert.equal(counter.textContent, `2 / ${total}`, 'closed shadow root key events step exactly once');
  assert.notEqual(document.querySelector('.hunch-current'), firstHit);
  assert.equal(shadow.activeElement, input, 'navigation preserves input focus');
  arrow(input, 'ArrowUp');
  assert.equal(document.querySelector('.hunch-current'), firstHit);
  assert.equal(counter.textContent, `1 / ${total}`);
  assert.ok(arrow(input, 'Enter').defaultPrevented);
  assert.equal(counter.textContent, `2 / ${total}`, 'Enter advances instead of repeating the search');
  arrow(input, 'Enter', { shiftKey: true });
  assert.equal(counter.textContent, `1 / ${total}`, 'Shift+Enter still goes backwards');
  arrow(document.body, 'Enter');
  assert.equal(counter.textContent, `2 / ${total}`, 'Enter works with focus on the page');
  arrow(document.body, 'Enter', { shiftKey: true });
  assert.equal(counter.textContent, `1 / ${total}`);
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(arrow(input, 'Enter', extra).defaultPrevented, false);
  }
  for (const target of [shadow.querySelector('select'), shadow.querySelector('.hunch-submit')]) {
    assert.equal(arrow(target, 'Enter').defaultPrevented, false, 'native Enter actions remain available');
  }
  assert.equal(requests.length, 1, 'Enter navigation and IME confirmation do not send requests');
  document.body.focus();
  assert.ok(arrow(document.body, 'ArrowUp').defaultPrevented);
  assert.equal(counter.textContent, `${total} / ${total}`, 'up wraps to the last result');
  arrow(document.body, 'ArrowDown');
  assert.equal(counter.textContent, `1 / ${total}`, 'down wraps to the first result');
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    assert.equal(arrow(input, 'ArrowDown', extra).defaultPrevented, false, 'IME and modified keys are preserved');
  }
  for (const target of [
    shadow.querySelector('select'),
    shadow.querySelector('.hunch-setting-child input'),
    shadow.querySelector('.hunch-grabber'),
    shadow.querySelector('.hunch-condition-input'),
    document.querySelector('[contenteditable]'),
  ]) {
    arrow(target, 'ArrowDown');
    assert.equal(counter.textContent, `1 / ${total}`, 'editing and control arrow keys do not navigate results');
  }
  const pageInput = document.createElement('input');
  document.body.append(pageInput);
  assert.equal(arrow(pageInput, 'ArrowDown').defaultPrevented, false);
  pageInput.remove();
  input.addEventListener('keydown', event => event.preventDefault(), { once: true });
  arrow(input, 'ArrowDown');
  assert.equal(counter.textContent, `1 / ${total}`, 'already handled keys are left alone');
  assert.equal(requests.length, 1, 'result navigation never submits a new search');
  assert.ok(!shadow.querySelector('.hunch-sidebar, .hunch-peek'), 'results are not repeated in a card above the bar');
  assert.ok(!shadow.querySelector('[aria-label="已存摘录"], [aria-label="导出结果"]'), 'no excerpt or export controls');
  const scope = shadow.querySelector('[aria-label="搜索范围"]');
  scope.value = 'article'; scope.dispatchEvent(new w.Event('change'));
  input.value = '新问题'; input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].query, '新问题', 'Enter submits the edited query after invalidating old results');
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
  input.value = '新搜索'; input.dispatchEvent(new w.Event('input'));
  toggle({ type: 'toggle' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(requests.length, 3, 'closing must not allow delayed searches');
  assert.ok(frame.hidden, 'the range outline goes away with the bar');
  assert.equal(arrow(document.body, 'ArrowDown').defaultPrevented, false, 'closing restores normal page arrow keys');
  dom.window.close();
});

test('long Chinese blocks split at sentence ends instead of mid-sentence', () => {
  const sentence = '这是一个用于测试分块的中文句子，没有任何空格。';
  const parts = api.splitAtBlockLimit(sentence.repeat(120));
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 1500 && part.endsWith('。')), 'every part ends on a full stop');
  assert.equal(parts.join(''), sentence.repeat(120));
  const unbroken = api.splitAtBlockLimit('字'.repeat(3200));
  assert.deepEqual(unbroken.map(part => part.length), [1500, 1500, 200], 'text without any break still has a hard limit');
});

test('extraction reads open shadow roots, slotted text and same-origin iframes in rendered order', () => {
  const dom = domFixture(); const w = dom.window;
  const host = document.createElement('div'); host.id = 'widget';
  host.innerHTML = '<p slot="body">Slotted light DOM paragraph text.</p>';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<h2>Shadow heading</h2><p>Shadow paragraph lives inside the component.</p><slot name="body"></slot>';
  document.querySelector('article').append(host);
  const frame = document.createElement('iframe');
  document.querySelector('article').append(frame);
  const inner = frame.contentDocument;
  inner.body.innerHTML = '<h3>Frame heading</h3><p>Iframe paragraph from the same origin.</p>';
  for (const win of [frame.contentWindow]) Object.defineProperty(win.HTMLElement.prototype, 'checkVisibility', { value() { return true; } });
  const blocks = api.extractBlocks('page');
  const texts = blocks.map(block => block.text);
  const at = text => texts.indexOf(text);
  assert.ok(at('Shadow paragraph lives inside the component.') > at('Repeated paragraph for testing.'));
  assert.ok(at('Slotted light DOM paragraph text.') > at('Shadow paragraph lives inside the component.'), 'slots render after preceding shadow content');
  assert.equal(texts.filter(text => text === 'Slotted light DOM paragraph text.').length, 1, 'slotted text is not read twice');
  assert.equal(blocks.find(block => block.text.startsWith('Shadow paragraph')).heading, 'Shadow heading');
  const framed = blocks.find(block => block.text === 'Iframe paragraph from the same origin.');
  assert.ok(framed, 'same-origin iframe text is extracted');
  assert.equal(framed.heading, 'Frame heading');
  api.paint([{ ...framed, p: .9, conditionScores: [] }]);
  assert.ok(framed.el.classList.contains('hunch-hl'));
  assert.equal(framed.el.dataset.hunchCond, undefined, 'semantic hits carry no condition hue');
  api.paint([{ ...framed, p: .9, conditionScores: [.3, .9, .5] }]);
  assert.equal(framed.el.dataset.hunchCond, '2', 'condition hits take the hue of their strongest condition');
  assert.equal(framed.el.dataset.hunchP, '0.90', 'the combined score is unchanged');
  assert.ok(inner.head.querySelector('link[href$="content.css"]'), 'highlight styles are injected into the frame');
  api.clearPaint();
  assert.ok(!framed.el.classList.contains('hunch-hl'), 'clearing reaches highlights outside the top document');
  dom.window.close();
});

test('content added after a search is offered as a follow-up search of only the new blocks', async () => {
  const dom = domFixture(); const w = dom.window;
  const requests = [];
  let onMessage; let shadow;
  w.ResizeObserver = class { observe() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.localName === 'hunch-ui') shadow = root; return root; };
  w.hunchTestBrowser = { runtime: {
    getURL: path => `https://example.com/${path}`, onMessage: { addListener(callback) { onMessage = callback; } },
    connect() {
      let receive;
      return {
        onMessage: { addListener(callback) { receive = callback; } }, onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(req) {
          requests.push(req);
          queueMicrotask(() => receive({ type: 'progress', scores: Object.fromEntries(req.blocks.map(b => [b.id, .9])), done: 1, total: 1, failed: 0, ms: 5 }));
        },
      };
    },
  } };
  w.eval(widgetBundle.outputFiles[0].text);
  stylesLoaded(shadow, w);
  onMessage({ type: 'toggle' });
  await new Promise(resolve => setImmediate(resolve));
  const input = shadow.querySelector('input');
  input.value = '证据'; input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(resolve => setImmediate(resolve));
  const firstCount = requests[0].blocks.length;
  const refresh = shadow.querySelector('.hunch-refresh');
  assert.ok(refresh.hidden);
  const added = document.createElement('p'); added.textContent = 'Lazy loaded paragraph after scrolling.';
  document.querySelector('article').append(added);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(requests.length, 1, 'page growth alone must not spend an API request');
  assert.ok(!refresh.hidden && refresh.textContent.includes('新增 1'));
  refresh.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[1].blocks.map(b => b.text)), '["Lazy loaded paragraph after scrolling."]');
  assert.ok(!requests[0].blocks.some(b => b.id === requests[1].blocks[0].id), 'new blocks get fresh ids');
  assert.ok(shadow.querySelector('.hunch-counter').textContent.endsWith(`/ ${firstCount + 1}`), 'old and new hits are ranked together');
  assert.ok(refresh.hidden);
  dom.window.close();
});

test('failed batches can be retried alone, the threshold re-ranks locally and keyword matches are kept', async () => {
  const dom = domFixture(); const w = dom.window;
  const requests = [];
  let onMessage; let shadow;
  w.ResizeObserver = class { observe() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.localName === 'hunch-ui') shadow = root; return root; };
  // First request: the batch holding the repeated paragraphs fails. Later requests succeed.
  const score = text => text.includes('selected evidence') ? 0.1 : text.startsWith('Repeated') ? 0.35 : 0.9;
  w.hunchTestBrowser = { runtime: {
    getURL: path => `https://example.com/${path}`, onMessage: { addListener(callback) { onMessage = callback; } },
    sendMessage: async () => undefined,
    connect() {
      let receive;
      return {
        onMessage: { addListener(callback) { receive = callback; } }, onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(req) {
          requests.push(req);
          const first = requests.length === 1;
          const scored = req.blocks.filter(b => !(first && b.text.startsWith('Repeated')));
          queueMicrotask(() => receive({ type: 'progress', scores: Object.fromEntries(scored.map(b => [b.id, score(b.text)])), done: 2, total: 2, failed: first ? 1 : 0, ms: 5 }));
        },
      };
    },
  } };
  w.eval(widgetBundle.outputFiles[0].text);
  stylesLoaded(shadow, w);
  onMessage({ type: 'toggle' });
  await new Promise(resolve => setImmediate(resolve));
  const input = shadow.querySelector('input');
  input.value = '"selected evidence"'; input.dispatchEvent(new w.Event('input'));
  const scope = shadow.querySelector('[aria-label="搜索范围"]');
  scope.value = 'page'; scope.dispatchEvent(new w.Event('change'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(resolve => setImmediate(resolve));

  const counter = () => shadow.querySelector('.hunch-counter').textContent;
  assert.ok(document.getElementById('one').classList.contains('hunch-hl'), 'a literal match is shown despite its low score');
  // Page scope: navigation, heading and footer score 0.9; the keyword paragraph ranks after them.
  assert.equal(counter(), '1 / 4', 'three model hits plus one keyword-only hit');
  const retry = shadow.querySelector('.hunch-retry');
  assert.ok(!retry.hidden && retry.textContent.includes('重试 2'), 'the two unscored blocks are offered for retry');

  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[1].blocks.map(b => b.text)), JSON.stringify(['Repeated paragraph for testing.', 'Repeated paragraph for testing.']));
  assert.ok(retry.hidden, 'the retry chip clears once every block has a score');
  assert.ok(counter().endsWith('/ 4'), '0.35 is still below the default threshold');

  const threshold = shadow.querySelector('[aria-label="相关度阈值"]');
  assert.equal(threshold.type, 'range', 'the paragraph threshold is a slider');
  threshold.value = '0.3'; threshold.dispatchEvent(new w.Event('input'));
  assert.ok(counter().endsWith('/ 6'), 'lowering the threshold shows the borderline blocks');
  assert.equal(requests.length, 2, 'changing the threshold never sends a request');
  dom.window.close();
});

test('a finished search closes its port, so a later worker shutdown is not reported as a disconnect', async () => {
  const dom = domFixture(); const w = dom.window;
  const ports = [];
  let onMessage; let shadow;
  w.ResizeObserver = class { observe() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.localName === 'hunch-ui') shadow = root; return root; };
  w.hunchTestBrowser = { runtime: {
    id: 'test', getURL: path => `https://example.com/${path}`, onMessage: { addListener(callback) { onMessage = callback; } },
    sendMessage: async () => undefined,
    connect() {
      const port = { closed: false, disconnect() { port.closed = true; }, onMessage: { addListener(callback) { port.receive = callback; } }, onDisconnect: { addListener(callback) { port.drop = callback; } }, postMessage(req) { port.req = req; } };
      ports.push(port);
      return port;
    },
  } };
  w.eval(widgetBundle.outputFiles[0].text);
  stylesLoaded(shadow, w);
  onMessage({ type: 'toggle' });
  await new Promise(resolve => setImmediate(resolve));
  const input = shadow.querySelector('input');
  const verdict = () => shadow.querySelector('.hunch-verdict');
  input.value = '证据'; input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  const [first] = ports;
  first.receive({ type: 'progress', scores: Object.fromEntries(first.req.blocks.map(b => [b.id, .9])), done: 1, total: 1, failed: 0, ms: 5 });
  assert.ok(first.closed, 'the content script closes the port after the last batch');
  first.drop();
  assert.ok(!verdict().classList.contains('hunch-error'), 'a disconnect after the search finished is not an error');
  assert.ok(verdict().textContent.includes('找到'));

  shadow.querySelector('.hunch-submit').click();
  const second = ports[1];
  const [scored, ...rest] = second.req.blocks;
  second.receive({ type: 'progress', scores: { [scored.id]: .9 }, done: 1, total: 2, failed: 0, ms: 5 });
  second.drop();
  assert.ok(verdict().classList.contains('hunch-error'), 'a disconnect mid-search is reported');
  assert.ok(verdict().textContent.includes('重试'));
  const retry = shadow.querySelector('.hunch-retry');
  assert.ok(!retry.hidden && retry.textContent.includes(`重试 ${rest.length}`), 'only blocks without a score are retried');
  assert.ok(!shadow.querySelector('.hunch-status').hidden, 'the message remains visible');
  assert.equal(shadow.querySelector('.hunch-status').parentElement, shadow.querySelector('.hunch-toolbar'), 'the message is inside the toolbar');
  dom.window.close();
});
