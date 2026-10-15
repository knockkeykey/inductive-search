import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temp = await mkdtemp(path.join(tmpdir(), 'hunch-sentences-'));
const outfile = path.join(temp, 'sentences.mjs');
await build({ entryPoints: ['src/shared/sentences.ts'], bundle: true, platform: 'node', format: 'esm', outfile });
const api = await import(pathToFileURL(outfile).href);
after(() => rm(temp, { recursive: true, force: true }));

const BEIYING = '我说道：“爸爸，你走吧。”他望车外看了看，说：“我买几个橘子去。你就在此地，不要走动。”我看那边月台的栅栏外有几个卖东西的等着顾客。';

test('splits Chinese text at sentence ends and keeps closing quotes with their sentence', () => {
  const sentences = api.splitSentences(BEIYING);
  assert.deepEqual(sentences.map(s => s.text), [
    '我说道：“爸爸，你走吧。”',
    '他望车外看了看，说：“我买几个橘子去。',
    '你就在此地，不要走动。”',
    '我看那边月台的栅栏外有几个卖东西的等着顾客。',
  ]);
  for (const s of sentences) assert.equal(BEIYING.slice(s.start, s.end), s.text, 'offsets point back into the block');
  assert.deepEqual(sentences.map(s => s.id), ['S001', 'S002', 'S003', 'S004']);
});

test('cuts overlong sentences again at commas', () => {
  const long = '他用两手攀着上面，两脚再向上缩，他肥胖的身子向左微倾，显出努力的样子，这时我看见他的背影，我的泪很快地流下来了，我赶紧拭干了泪，怕他看见，也怕别人看见。';
  assert.ok(long.length > api.MAX_SENTENCE_CHARS);
  const parts = api.splitSentences(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.text.length <= api.MAX_SENTENCE_CHARS));
  assert.equal(parts.map(p => p.text).join(''), long);
});

test('handles English sentence ends without splitting decimals', () => {
  const parts = api.splitSentences('Version 1.5 shipped. It is faster! Why? Because.');
  assert.deepEqual(parts.map(p => p.text), ['Version 1.5 shipped.', 'It is faster!', 'Why?', 'Because.']);
});

test('short blocks and blocks with few sentences are not refined', () => {
  assert.deepEqual(api.refinableSentences('我买几个橘子去。你就在此地。'), []);
  assert.deepEqual(api.refinableSentences('这是一个很长但是只有一句话的段落'.repeat(6)), []);
  assert.equal(api.refinableSentences(BEIYING.repeat(2)).length, 8);
});

test('marks at most two sentences at or above the threshold, in reading order', () => {
  const sentences = api.splitSentences(BEIYING);
  const scores = { S001: 0.2, S002: 0.95, S003: 0.8, S004: 0.75 };
  assert.deepEqual(api.pickSentences(sentences, scores, 0.7).map(s => s.id), ['S002', 'S003']);
  assert.deepEqual(api.pickSentences(sentences, scores, 0.9).map(s => s.id), ['S002']);
  assert.deepEqual(api.pickSentences(sentences, {}, 0.5), [], 'a failed request marks nothing');
});

test('sentence threshold is snapped to the slider range', () => {
  assert.equal(api.validSentenceThreshold(undefined), 0.7);
  assert.equal(api.validSentenceThreshold(0.83), 0.85);
  assert.equal(api.validSentenceThreshold(0.1), 0.5);
  assert.equal(api.validSentenceThreshold(2), 0.95);
});
