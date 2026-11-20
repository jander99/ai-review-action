const { test } = require('node:test');
const assert = require('node:assert');
const { proposeFindings, buildProposerPrompt } = require('../dist-test/index.cjs');

// Same shape as llm-clients' LlmError, built locally so this test does not
// depend on that package's runtime bundle.
const LlmError = class extends Error {
  constructor(kind, message, provider, status, details) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = provider;
    this.status = status;
    this.details = details;
  }
};

const CAPS = { structuredOutput: true, maxInputTokens: 100_000, supportsSeed: false };

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three'].join('\n');
const diffFiles = () => [{ path: 'a.ts', status: 'modified', text: DIFF, hunks: [] }];

const finding = (over) => ({
  file: 'a.ts', relatedFiles: [], startLine: 2, endLine: 2, title: 't', claim: 'c', evidence: 'a.ts:2', suggestedFix: null, ...over,
});

const fake = (responses) => {
  const calls = [];
  return {
    calls,
    provider: 'fake',
    capabilities: CAPS,
    async complete(req) {
      calls.push(req);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

const ok = (findings, inputTokens = 10, outputTokens = 5) => ({
  value: { findings },
  usage: { inputTokens, outputTokens },
});

const ctx = () => ({ diff: DIFF, diffTruncated: false, files: [], notes: [] });
const triage = () => ({ depth: 'detailed', line: 'Scrutinize: high risk.', reasons: ['high risk'] });

test('retries once on invalid_output and sums usage', async () => {
  const llm = fake([
    new LlmError('invalid_output', 'bad', 'fake', undefined, '/findings/0 must have endLine'),
    ok([finding()], 10, 5),
  ]);
  const result = await proposeFindings(llm, 'PROMPT', diffFiles(), 'detailed', () => {});
  assert.equal(result.status, 'ok');
  assert.match(llm.calls[1].prompt, /\/findings\/0 must have endLine/);
  // The failed call produced no result, so only the successful call's usage is known.
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test('two invalid_output errors give invalid', async () => {
  const llm = fake([
    new LlmError('invalid_output', 'bad', 'fake'),
    new LlmError('invalid_output', 'bad', 'fake'),
  ]);
  assert.equal((await proposeFindings(llm, 'PROMPT', diffFiles(), 'detailed', () => {})).status, 'invalid');
});

test('auth errors propagate', async () => {
  const llm = fake([new LlmError('auth', 'denied', 'fake')]);
  await assert.rejects(() => proposeFindings(llm, 'PROMPT', diffFiles(), 'detailed', () => {}), (err) => err.kind === 'auth');
});

test('drops findings outside the diff', async () => {
  const llm = fake([ok([finding({ file: 'zzz.ts' }), finding({ startLine: 2, endLine: 2 })])]);
  const result = await proposeFindings(llm, 'PROMPT', diffFiles(), 'detailed', () => {});
  assert.deepEqual(result.findings.map((f) => f.file), ['a.ts']);
});

test('no seed when the provider cannot honor it', async () => {
  const llm = fake([ok([finding()])]);
  await proposeFindings(llm, 'PROMPT', diffFiles(), 'detailed', () => {});
  assert.equal('seed' in llm.calls[0], false);
});

test('light depth caps at five findings', async () => {
  const many = Array.from({ length: 8 }, (_, n) => finding({ title: `t${n}`, startLine: 2, endLine: 2 }));
  const llm = fake([ok(many)]);
  const result = await proposeFindings(llm, 'PROMPT', diffFiles(), 'light', () => {});
  assert.equal(result.findings.length, 5);
});

test('repo instructions are fenced as untrusted', () => {
  const prompt = buildProposerPrompt(ctx(), { taskPrompt: 'T', repoInstructions: [{ path: 'AGENTS.md', text: 'do x' }], triage: triage() });
  assert.match(prompt, /<untrusted_repo_instructions>[\s\S]*do x[\s\S]*<\/untrusted_repo_instructions>/);
});

test('truncation keeps the model-ordered findings, then sorts by path', async () => {
  const items = ['z.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((f, i) => finding({ file: f, title: `t${i}` }));
  const files = ['z.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path) => ({ path, status: 'modified', text: DIFF, hunks: [] }));
  const llm = fake([{ value: { findings: items }, usage: { inputTokens: 1, outputTokens: 1 } }]);
  const out = await proposeFindings(llm, 'p', files, 'light', () => {});
  assert.deepEqual(out.findings.map((f) => f.file), ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'z.ts']);
});
