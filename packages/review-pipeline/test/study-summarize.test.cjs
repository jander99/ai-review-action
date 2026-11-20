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
