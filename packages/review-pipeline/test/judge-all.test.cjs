const { test } = require('node:test');
const assert = require('node:assert');
const { runPool, judgeAll } = require('../dist-test/index.cjs');

test('runPool caps in flight and preserves input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, n) => n);
  const results = await runPool(items, 3, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight -= 1;
    return item * 2;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak}`);
  assert.deepEqual(results.map((r) => r.value), items.map((n) => n * 2));
});

test('runPool keeps going after one rejection', async () => {
  const items = Array.from({ length: 10 }, (_, n) => n);
  const results = await runPool(items, 3, async (item) => {
    if (item === 4) throw new Error('boom');
    return item;
  });
  assert.equal(results.filter((r) => r.ok).length, 9);
  assert.equal(results[4].ok, false);
  assert.equal(results[9].value, 9);
});

const CAPS = { structuredOutput: false, maxInputTokens: 50, supportsSeed: false };

test('judgeAll refuses findings that cannot fit, without calling the API', async () => {
  let calls = 0;
  const client = {
    provider: 'fake',
    capabilities: CAPS,
    async decide() {
      calls += 1;
      return { answers: {}, usage: { inputTokens: 0 } };
    },
  };
  const finding = { file: 'a.ts', relatedFiles: [], startLine: 1, endLine: 1, title: 't', claim: 'c', evidence: 'e', suggestedFix: null };
  const result = await judgeAll(client, [finding], {
    diffFiles: [{ path: 'a.ts', status: 'modified', text: 'x'.repeat(1000), hunks: [] }],
    fileTexts: new Map([['a.ts', 'x'.repeat(1000)]]),
    priorFindings: [],
  });
  assert.equal(calls, 0);
  assert.equal(result.judged[0].judgement, null);
});

test('a cross-file finding carries both files hunks', async () => {
  let state;
  const client = {
    provider: 'fake',
    capabilities: { structuredOutput: false, maxInputTokens: 100_000, supportsSeed: false },
    async decide(req) {
      state = req.state;
      return { answers: { supported: { type: 'noul', pTrue: 0.9 }, severity: { type: 'choice', probabilities: { minor: 0.5 } } }, usage: { inputTokens: 1 } };
    },
  };
  const finding = { file: 'a.ts', relatedFiles: ['b.ts'], startLine: 1, endLine: 1, title: 't', claim: 'c', evidence: 'e', suggestedFix: null };
  await judgeAll(client, [finding], {
    diffFiles: [
      { path: 'a.ts', status: 'modified', text: 'AAA', hunks: [] },
      { path: 'b.ts', status: 'modified', text: 'BBB', hunks: [] },
    ],
    fileTexts: new Map([['a.ts', 'line a'], ['b.ts', 'line b']]),
    priorFindings: [],
  });
  assert.match(state, /AAA/);
  assert.match(state, /BBB/);
});

test('one decide rejection is reported as a failure', async () => {
  const client = {
    provider: 'fake',
    capabilities: { structuredOutput: false, maxInputTokens: 100_000, supportsSeed: false },
    async decide() {
      throw new Error('nope');
    },
  };
  const finding = { file: 'a.ts', relatedFiles: [], startLine: 1, endLine: 1, title: 't', claim: 'c', evidence: 'e', suggestedFix: null };
  const result = await judgeAll(client, [finding], { diffFiles: [{ path: 'a.ts', status: 'modified', text: 'A', hunks: [] }], fileTexts: new Map(), priorFindings: [] });
  assert.equal(result.failures.length, 1);
});
