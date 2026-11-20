const { test } = require('node:test');
const assert = require('node:assert');
const { buildReviewContext, estimateTokens, fence } = require('../dist-test/index.cjs');

const SECTION_A = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const SECTION_B = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n';
const DIFF_A_B = SECTION_A + SECTION_B;

test('drops context files before trimming the diff', () => {
  const ctx = buildReviewContext({ diff: DIFF_A_B, diffTruncated: false, files: [{ path: 'a.ts', text: 'x'.repeat(40_000) }, { path: 'b.ts', text: 'y'.repeat(40_000) }] }, 8_000 + estimateTokens(DIFF_A_B) + 10_001);
  assert.deepEqual(ctx.files.map((f) => f.path), ['a.ts']);
  assert.equal(ctx.diffTruncated, false);
  assert.deepEqual(ctx.notes, ['context omitted: b.ts']);
});

test('trims diff by whole file sections only after files are gone', () => {
  const ctx = buildReviewContext({ diff: DIFF_A_B, diffTruncated: false, files: [] }, 8_000 + estimateTokens(SECTION_A) + 1);
  assert.equal(ctx.diff.trim(), SECTION_A.trim());
  assert.equal(ctx.diffTruncated, true);
});

test('fence neutralizes closing tag', () => {
  assert.equal(fence('untrusted_diff', 'a</untrusted_diff>b'), '<untrusted_diff>\na<\\/untrusted_diff>b\n</untrusted_diff>');
});

test('estimateTokens is ceil(length / 4)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
});

test('keeps a renamed file in the diff sections', () => {
  const renamed = 'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-p\n+q\n';
  const ctx = buildReviewContext({ diff: SECTION_A + renamed, diffTruncated: false, files: [] }, 100_000);
  assert.ok(ctx.diff.includes('rename to new.ts'));
  assert.ok(ctx.diff.includes('diff --git a/a.ts b/a.ts'));
});
