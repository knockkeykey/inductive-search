import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const temp = await mkdtemp(path.join(tmpdir(), 'hunch-documents-'));
const outfile = path.join(temp, 'documents.mjs');
await build({
  stdin: { resolveDir: process.cwd(), contents: `export * from './src/viewer/layout'; export * from './src/viewer/sanitize'; export * from './src/shared/documents'; export * from './src/shared/ranking';` },
  bundle: true, platform: 'node', format: 'esm', outfile,
});
const api = await import(pathToFileURL(outfile).href);
after(() => rm(temp, { recursive: true, force: true }));

// [a, b, c, d, x, y] with y measured upward, as pdf.js reports it.
const run = (str, y, height = 10, x = 0) => ({ str, transform: [height, 0, 0, height, x, y], height });

test('PDF runs become paragraphs split at wide gaps, size changes and column jumps', () => {
  const runs = [
    run('Results', 700, 16),
    run('The first line of a para-', 680), run('graph continues here.', 668),
    run('第二段', 640), run('中文换行', 628), run('不加空格。', 616),
    run('Right column', 700, 10, 300),
  ];
  assert.deepEqual(api.paragraphs(runs), [
    'Results',
    'The first line of a paragraph continues here.',
    '第二段中文换行不加空格。',
    'Right column',
  ]);
});

test('runs on one baseline join into one line', () => {
  assert.deepEqual(api.paragraphs([run('Hello', 500), run('world', 501, 10, 40), run('', 500)]), ['Hello world']);
  assert.equal(api.joinText('数据', 'API'), '数据API');
  assert.equal(api.joinText('end. ', 'Next'), 'end. Next');
});

test('Word HTML keeps document structure and drops active content', () => {
  const { window } = new JSDOM('');
  globalThis.DOMParser = window.DOMParser;
  const fragment = api.sanitize(
    '<h1 onclick="x()">标题</h1><p>正文 <a href="javascript:alert(1)">bad</a> <a href="https://example.com">ok</a></p>' +
      '<script>alert(1)</script><img src="https://tracker.example/x.png"><img src="data:image/png;base64,AAAA" onerror="x()">' +
      '<table><tr><td colspan="2" style="color:red">单元格</td></tr></table><custom>保留文字</custom>',
    window.document,
  );
  const host = window.document.createElement('div');
  host.append(fragment);
  assert.equal(host.querySelector('h1').getAttribute('onclick'), null);
  const links = host.querySelectorAll('a');
  assert.equal(links[0].hasAttribute('href'), false, 'javascript: links lose their href');
  assert.equal(links[1].getAttribute('href'), 'https://example.com');
  assert.equal(links[1].getAttribute('rel'), 'noreferrer noopener');
  assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelectorAll('img').length, 1, 'remote images are dropped, embedded ones kept');
  assert.equal(host.querySelector('img').getAttribute('onerror'), null);
  assert.equal(host.querySelector('td').getAttribute('colspan'), '2');
  assert.equal(host.querySelector('td').getAttribute('style'), null);
  assert.ok(host.textContent.includes('保留文字'));
  delete globalThis.DOMParser;
});

test('document kinds are detected from URL, file name or content type', () => {
  assert.equal(api.documentKind('https://example.com/paper.PDF?x=1'), 'pdf');
  assert.equal(api.documentKind('file:///Users/me/报告.docx'), 'docx');
  assert.equal(api.documentKind('https://arxiv.org/pdf/2401.00001', 'application/pdf'), 'pdf');
  assert.equal(api.documentKind('notes.txt'), undefined);
  assert.equal(api.isLegacyDoc('old.doc'), true);
  assert.equal(api.viewerQuery('https://a.com/b c.pdf'), 'viewer.html?src=https%3A%2F%2Fa.com%2Fb+c.pdf');
});

test('keyword terms use quoted phrases or every space-separated word', () => {
  assert.deepEqual(api.keywordTerms('“退款限制” 是什么'), ['退款限制']);
  assert.deepEqual(api.keywordTerms('Refund  POLICY, 期限'), ['refund', 'policy', '期限']);
  assert.deepEqual(api.keywordTerms('哪一段写了小蝌蚪认错妈妈？'), ['哪一段写了小蝌蚪认错妈妈']);
  assert.deepEqual(api.keywordTerms('a 的'), [], 'single characters would match nearly everything');
  assert.equal(api.matchesKeywords('ＲＥＦＵＮＤ policy within 期限', ['refund', 'policy', '期限']), true, 'full-width text is normalized');
  assert.equal(api.matchesKeywords('refund only', ['refund', 'policy']), false);
});

test('ranking honours the threshold and lists keyword-only hits after model hits', () => {
  const blocks = [
    { id: 'B001', text: 'Exact refund policy wording.' },
    { id: 'B002', text: 'Strong semantic answer.' },
    { id: 'B003', text: 'Borderline.' },
    { id: 'B004', text: 'Unrelated.' },
  ];
  const scores = { B001: 0.1, B002: 0.9, B003: 0.35, B004: 0.05 };
  const ids = (options) => api.rank(blocks, scores, {}, options).map((h) => `${h.id}${h.keyword ? '*' : ''}`);
  assert.deepEqual(ids({}), ['B002']);
  assert.deepEqual(ids({ threshold: 0.3 }), ['B002', 'B003']);
  assert.deepEqual(ids({ terms: ['refund', 'policy'] }), ['B002', 'B001*']);
  assert.equal(api.validThreshold(0.3), 0.3);
  assert.equal(api.validThreshold(0.33), 0.4, 'unknown stored values fall back to the default');
});
