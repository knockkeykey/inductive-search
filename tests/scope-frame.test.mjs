import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `import { ScopeFrame } from './src/content/scope-frame'; window.ScopeFrame = ScopeFrame;` },
  bundle: true, format: 'iife', write: false,
});

function fixture(t, { left = 0, top = 72, width = 1024, height = 3000, viewport = 1024, clientWidth = viewport } = {}) {
  const dom = new JSDOM(`<article>${'Article text. '.repeat(20)}</article>`, { pretendToBeVisual: true, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.innerWidth = viewport;
  w.innerHeight = 768;
  Object.defineProperty(w.document.documentElement, 'clientWidth', { get: () => clientWidth });
  w.HTMLElement.prototype.checkVisibility = () => true;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  const article = w.document.querySelector('article');
  article.getBoundingClientRect = () => new w.DOMRect(left, top, width, height);
  w.eval(bundle.outputFiles[0].text);
  const frame = new w.ScopeFrame();
  w.document.body.append(frame.root);
  return { w, article, frame };
}

function box(frame) {
  const { left, top, width, height } = frame.root.style;
  return { left: parseFloat(left), top: parseFloat(top), right: parseFloat(left) + parseFloat(width), bottom: parseFloat(top) + parseFloat(height) };
}

test('full-width article keeps both rainbow sides inside the visible page, including scrollbar space', t => {
  const { frame } = fixture(t, { clientWidth: 1009 });
  frame.show('article', []);
  const r = box(frame);
  assert.ok(!frame.root.hidden);
  assert.ok(r.left >= 0, `left side is clipped at ${r.left}`);
  assert.ok(r.right <= 1009, `right side is clipped at ${r.right}`);
  assert.equal(r.top, 66);
  assert.equal(r.bottom, 3078, 'do not pin the article bottom to the viewport');
});

test('narrow articles retain padding and their vertical edges scroll away with the content', async t => {
  const { w, article, frame } = fixture(t, { left: 120, width: 600 });
  frame.show('article', []);
  assert.deepEqual(box(frame), { left: 114, top: 66, right: 726, bottom: 3078 });
  article.getBoundingClientRect = () => new w.DOMRect(120, -300, 600, 3000);
  w.document.dispatchEvent(new w.Event('scroll'));
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  assert.deepEqual(box(frame), { left: 114, top: -306, right: 726, bottom: 2706 });
  assert.ok(!frame.root.hidden);
  article.getBoundingClientRect = () => new w.DOMRect(120, -3100, 600, 3000);
  w.document.dispatchEvent(new w.Event('scroll'));
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  assert.ok(frame.root.hidden, 'fully scrolled-out content has no visible outline');
});

test('selection and page frames also keep their sides inside the page, and offscreen scopes hide', t => {
  const { w, article, frame } = fixture(t, { clientWidth: 1009 });
  frame.show('page', []);
  assert.deepEqual(box(frame), { left: 0, top: 0, right: 1009, bottom: 768 });
  const range = w.document.createRange();
  range.getBoundingClientRect = () => new w.DOMRect(-10, 100, 1040, 40);
  frame.show('selection', [range]);
  assert.deepEqual(box(frame), { left: 0, top: 94, right: 1009, bottom: 146 });
  article.getBoundingClientRect = () => new w.DOMRect(1100, 100, 600, 400);
  frame.show('article', []);
  assert.ok(frame.root.hidden, 'a horizontally offscreen article must not make an inverted frame');
});
