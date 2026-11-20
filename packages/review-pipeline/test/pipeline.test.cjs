const { test } = require('node:test');
const assert = require('node:assert');
const { runReviewPipeline } = require('../dist-test/index.cjs');

const CAPS = { structuredOutput: false, maxInputTokens: 100_000, supportsSeed: false };
const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three'].join('\n');
const THRESHOLDS = { keep: 0.6, drop: 0.3, severity: 0.5 };

const input = (over = {}) => ({
  title: 't', diff: DIFF, diffTruncated: false, files: [], repoInstructions: [],
  taskPrompt: 'TASK', priorFindings: [], ...over,
});

const llm = (value, calls = { n: 0 }) => ({
  provider: 'fake', capabilities: CAPS,
  async complete() { calls.n += 1; return { value, usage: { inputTokens: 7, outputTokens: 3 } }; },
});

const triageClient = (decide) => ({ provider: 'fake', capabilities: CAPS, decide });
const healthyTriage = () => triageClient(async () => ({
  answers: { risk: { type: 'choice', probabilities: { low: 0.9, medium: 0.05, high: 0.05 } } },
  usage: { inputTokens: 2 },
}));

const finding = (over) => ({ file: 'a.ts', relatedFiles: [], startLine: 2, endLine: 2, title: 't', claim: 'c', evidence: 'a.ts:2', suggestedFix: null, ...over });

test('empty diff makes no client calls', async () => {
  let complete = 0;
  let decide = 0;
  const result = await runReviewPipeline(input({ diff: '' }), {
    llm: { provider: 'fake', capabilities: CAPS, async complete() { complete += 1; throw new Error('unexpected'); } },
    decisions: triageClient(async () => { decide += 1; throw new Error('unexpected'); }),
    thresholds: THRESHOLDS,
    log: () => {},
  });
  assert.equal(result.status, 'ok');
  assert.equal(complete + decide, 0);
});

test('happy path: keep, uncertain and drop are counted and rendered', async () => {
  const proposer = llm({ findings: [finding({ title: 'kept one' }), finding({ title: 'uncertain one' }), finding({ title: 'dropped one' })] });
  const decisions = triageClient(async (req) => {
    if (req.questions.risk) {
      return { answers: { risk: { type: 'choice', probabilities: { low: 0.9, medium: 0.05, high: 0.05 } } }, usage: { inputTokens: 2 } };
    }
    const title = JSON.parse(req.state).untrusted.finding.title;
    const p = title === 'kept one' ? 0.95 : title === 'uncertain one' ? 0.45 : 0.1;
    return {
      answers: { supported: { type: 'noul', pTrue: p }, severity: { type: 'choice', probabilities: { major: 0.9, minor: 0.1 } } },
      usage: { inputTokens: 1 },
    };
  });
  const result = await runReviewPipeline(input(), { llm: proposer, decisions, thresholds: THRESHOLDS, log: () => {} });
  assert.equal(result.status, 'ok');
  assert.deepEqual([result.counts.kept, result.counts.uncertain, result.counts.dropped], [1, 1, 1]);
  assert.match(result.document, /## Uncertain/);
  assert.match(result.document, /> Triage:/);
  assert.equal(result.kept[0].severity, 'Warning');
});

test('one decide rejection fails the run without a document', async () => {
  const proposer = llm({ findings: [finding()] });
  const decisions = triageClient(async (req) => {
    if (req.questions.risk) {
      return { answers: { risk: { type: 'choice', probabilities: { low: 0.9 } } }, usage: { inputTokens: 2 } };
    }
    throw new Error('judge exploded');
  });
  const result = await runReviewPipeline(input(), { llm: proposer, decisions, thresholds: THRESHOLDS, log: () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.document, '');
  assert.match(result.failureReason, /not posting a partial review/);
});

test('proposer invalid twice is not a clean pass', async () => {
  const { LlmError } = require('node:module') && {};
  const proposer = {
    provider: 'fake', capabilities: CAPS,
    async complete() {
      const err = new Error('bad output');
      err.name = 'LlmError';
      err.kind = 'invalid_output';
      throw err;
    },
  };
  const result = await runReviewPipeline(input(), { llm: proposer, decisions: healthyTriage(), thresholds: THRESHOLDS, log: () => {} });
  assert.equal(result.status, 'no_findings_produced');
  assert.match(result.document, /not a clean pass/);
});

test('triage auth failure fails before any proposer call', async () => {
  let complete = 0;
  const proposer = { provider: 'fake', capabilities: CAPS, async complete() { complete += 1; throw new Error('unexpected'); } };
  const decisions = triageClient(async () => {
    const err = new Error('denied');
    err.name = 'DecisionError';
    err.kind = 'auth';
    throw err;
  });
  const result = await runReviewPipeline(input(), { llm: proposer, decisions, thresholds: THRESHOLDS, log: () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(complete, 0);
  assert.match(result.failureReason, /Decision API failed during triage: auth: denied/);
});
