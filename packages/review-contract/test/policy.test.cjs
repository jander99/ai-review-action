const { test } = require('node:test');
const assert = require('node:assert');
const {
  applyPolicy,
  DEFAULT_THRESHOLDS,
  resolveSeverity,
  validateThresholds,
  findingId,
  redactSecret,
} = require('../dist/index.cjs');

test('applyPolicy boundaries are inclusive', () => {
  const sev = { blocker: 0, major: 1, minor: 0, nit: 0 };
  assert.equal(applyPolicy({ pSupported: 0.7, severity: sev, duplicate: null }, DEFAULT_THRESHOLDS).verdict, 'keep');
  assert.equal(applyPolicy({ pSupported: 0.3, severity: sev, duplicate: null }, DEFAULT_THRESHOLDS).verdict, 'drop');
  assert.equal(applyPolicy({ pSupported: 0.5, severity: sev, duplicate: null }, DEFAULT_THRESHOLDS).verdict, 'uncertain');
});
test('duplicate wins over keep only at >= keep', () => {
  const sev = { blocker: 0, major: 1, minor: 0, nit: 0 };
  assert.deepEqual(applyPolicy({ pSupported: 0.9, severity: sev, duplicate: { id: 'Fa', p: 0.7 } }, DEFAULT_THRESHOLDS),
    { verdict: 'duplicate', severity: 'major', duplicateOf: 'Fa' });
  assert.equal(applyPolicy({ pSupported: 0.9, severity: sev, duplicate: { id: 'Fa', p: 0.69 } }, DEFAULT_THRESHOLDS).verdict, 'keep');
  assert.equal(applyPolicy({ pSupported: 0.2, severity: sev, duplicate: { id: 'Fa', p: 0.99 } }, DEFAULT_THRESHOLDS).verdict, 'drop');
});
test('resolveSeverity takes argmax or its lower neighbour', () => {
  assert.equal(resolveSeverity({ blocker: 0.6, major: 0.2, minor: 0.1, nit: 0.1 }, 0.5), 'blocker');
  assert.equal(resolveSeverity({ blocker: 0.45, major: 0.3, minor: 0.15, nit: 0.1 }, 0.5), 'major');
  assert.equal(resolveSeverity({ blocker: 0.1, major: 0.1, minor: 0.4, nit: 0.4 }, 0.5), 'nit');
});
test('validateThresholds rejects bad values', () => {
  assert.throws(() => validateThresholds({ keep: 0.3, drop: 0.7, severity: 0.5 }), /drop-threshold must be less than keep-threshold/);
  assert.throws(() => validateThresholds({ keep: 1.2, drop: 0.3, severity: 0.5 }), /keep-threshold must be between 0 and 1/);
});
test('findingId is stable and title-normalized', () => {
  assert.equal(findingId('a.ts', 'Null deref'), findingId('a.ts', '  null   DEREF '));
  assert.match(findingId('a.ts', 'x'), /^F[0-9a-f]{10}$/);
});
test('redactSecret removes every occurrence', () => {
  assert.equal(redactSecret('k=sk-SECRET1 again sk-SECRET1', 'sk-SECRET1'), 'k=[REDACTED] again [REDACTED]');
});
