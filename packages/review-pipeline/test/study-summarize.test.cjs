const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeRuns } = require('../dist-test/index.cjs');

test('summarizeRuns counts flips and uncertainty', () => {
  const runs = [
    { fixture: 'a', findingId: 'F1', pSupported: 0.8, verdict: 'keep' },
    { fixture: 'a', findingId: 'F1', pSupported: 0.2, verdict: 'drop' },
    { fixture: 'a', findingId: 'F2', pSupported: 0.5, verdict: 'uncertain' },
    { fixture: 'a', findingId: 'F2', pSupported: 0.5, verdict: 'uncertain' },
  ];
  const r = summarizeRuns(runs, { 'a/F1': 'supported', 'a/F2': 'borderline' });
  assert.equal(r.keepDropFlipRate, 0.5);
  assert.equal(r.uncertainRate, 0.5);
  const stats = r.findings[0].pSupported;
  assert.deepEqual({ mean: stats.mean, min: stats.min, max: stats.max }, { mean: 0.5, min: 0.2, max: 0.8 });
  assert.ok(Math.abs(stats.sd - 0.3) < 1e-9, `sd ${stats.sd}`);
});

test('pairwiseOverlap measures finding-set overlap across runs', () => {
  const { pairwiseOverlap } = require('../dist-test/index.cjs');
  const A = { file: 'a.ts', startLine: 1, endLine: 3 };
  const B = { file: 'b.ts', startLine: 1, endLine: 3 };
  assert.equal(pairwiseOverlap([[A], [A]]), 1);
  assert.equal(pairwiseOverlap([[A], []]), 0);
  assert.equal(pairwiseOverlap([[A, B], [A]]), 0.5);
  assert.equal(pairwiseOverlap([[], []]), 1);
  // overlapping (not identical) ranges on the same file match
  assert.equal(pairwiseOverlap([[A], [{ file: 'a.ts', startLine: 3, endLine: 5 }]]), 1);
  // one-to-one: two findings cannot both match a single one
  assert.equal(pairwiseOverlap([[A, { file: 'a.ts', startLine: 2, endLine: 2 }], [A]]), 0.5);
});
