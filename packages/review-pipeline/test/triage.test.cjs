const { test } = require('node:test');
const assert = require('node:assert');
const { decideTriage, buildTriageRequest } = require('../dist-test/index.cjs');
const { DEFAULT_THRESHOLDS } = require('@jander99/ai-review-review-contract');

const answers = (map) => ({
  answers: Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, typeof v === 'number' ? { type: 'noul', pTrue: v } : { type: 'choice', probabilities: v }]),
  ),
  usage: { inputTokens: 0 },
});

test('light when confident and small', () => {
  const r = decideTriage(answers({ risk: { low: 0.9, medium: 0.05, high: 0.05 }, matches_intent: 0.9, touches_security: 0.1, touches_concurrency: 0.1, touches_public_api: 0.1 }), 40, true, DEFAULT_THRESHOLDS);
  assert.deepEqual([r.depth, r.line], ['light', 'Safe to skim: low risk, 40 changed lines, matches the stated intent.']);
});

test('detailed reasons in fixed order', () => {
  const r = decideTriage(answers({ risk: { low: 0.1, medium: 0.2, high: 0.7 }, matches_intent: 0.4, touches_security: 0.8, touches_concurrency: 0.5, touches_public_api: 0.1 }), 250, true, DEFAULT_THRESHOLDS);
  assert.equal(r.line, 'Scrutinize: high risk, may not match the stated intent, touches security, may touch concurrency, large (250 changed lines).');
});

test('no intent question without title or body', () => {
  assert.equal('matches_intent' in buildTriageRequest({ diff: 'd' }, 100_000).questions, false);
});
