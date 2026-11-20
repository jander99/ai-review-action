const { test } = require('node:test');
const assert = require('node:assert');
const { renderFindingComment, parsePriorFindings, suggestionFence } = require('../dist/index.cjs');

const postable = {
  finding: {
    id: 'Fabc1234567',
    file: 'src/a.ts',
    relatedFiles: [],
    startLine: 12,
    endLine: 14,
    title: 'Off by one',
    claim: 'The loop skips the last element.',
    evidence: 'src/a.ts:12 — `for (i = 0; i < n - 1; i++)`',
    suggestedFix: 'for (let i = 0; i < n; i++) {}',
  },
  severity: 'Warning',
  judgeSeverity: 'major',
  pSupported: 0.91,
  note: '',
};

test('a rendered finding comment parses back to its identity', () => {
  const body = renderFindingComment(postable, { suggestion: true });
  assert.deepEqual(parsePriorFindings(body), [
    { id: postable.finding.id, file: 'src/a.ts', line: 12, title: 'Off by one' },
  ]);
});

test('suggestion fence grows past a triple backtick in the fix', () => {
  assert.equal(suggestionFence('a ``` b'), '````');
});

test('a fix containing a triple backtick still round-trips', () => {
  const tricky = { ...postable, finding: { ...postable.finding, suggestedFix: '```\ncode\n```' } };
  const body = renderFindingComment(tricky, { suggestion: true });
  assert.deepEqual(parsePriorFindings(body).map((f) => f.title), ['Off by one']);
});

test('no suggestion block without a fix or without the option', () => {
  const noFix = { ...postable, finding: { ...postable.finding, suggestedFix: null } };
  assert.doesNotMatch(renderFindingComment(noFix, { suggestion: true }), /```suggestion/);
  assert.doesNotMatch(renderFindingComment(postable, { suggestion: false }), /```suggestion/);
});

test('fallback fills a marker with no file or line', () => {
  const body = '**🟡 Warning (major) — bare**\n\n<!-- ai-review-finding id=F1 -->';
  assert.deepEqual(parsePriorFindings(body, { path: 'x.ts', line: 7 }), [{ id: 'F1', file: 'x.ts', line: 7, title: 'bare' }]);
});
