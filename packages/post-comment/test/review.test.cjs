const { test } = require('node:test');
const assert = require('node:assert');
const { planReviewComments, postReview } = require('../dist-test/index.cjs');

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,5 +1,5 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  ' four',
  ' five',
  'diff --git a/gone.ts b/gone.ts',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
].join('\n');

const postable = (over) => ({
  finding: { id: 'F1', file: 'a.ts', relatedFiles: [], startLine: 3, endLine: 3, title: 't', claim: 'c', evidence: 'a.ts:3', suggestedFix: null, ...over },
  severity: 'Warning',
  judgeSeverity: 'major',
  pSupported: 0.9,
  note: '',
});

test('single-line finding anchors with line only', () => {
  const { inline } = planReviewComments([postable()], DIFF);
  assert.equal(inline.length, 1);
  assert.deepEqual([inline[0].line, inline[0].side, inline[0].start_line], [3, 'RIGHT', undefined]);
});

test('in-hunk range sets start_line and start_side', () => {
  const { inline } = planReviewComments([postable({ startLine: 2, endLine: 4 })], DIFF);
  assert.deepEqual([inline[0].start_line, inline[0].start_side, inline[0].line], [2, 'RIGHT', 4]);
});

test('a range across two hunks is body-only', () => {
  const twoHunks = DIFF.replace('@@ -1,5 +1,5 @@', '@@ -1,2 +1,2 @@').replace(' four', '@@ -4,2 +4,2 @@\n four');
  const finding = postable({ startLine: 2, endLine: 5 });
  const { inline, bodyOnly } = planReviewComments([finding], twoHunks);
  assert.equal(inline.length, 0);
  assert.equal(bodyOnly.length, 1);
});

test('a file not in the diff is body-only', () => {
  const { inline, bodyOnly } = planReviewComments([postable({ file: 'other.ts' })], DIFF);
  assert.equal(inline.length, 0);
  assert.deepEqual(bodyOnly.map((f) => f.finding.id), ['F1']);
});

test('a deleted file is body-only', () => {
  const { inline, bodyOnly } = planReviewComments([postable({ file: 'gone.ts', startLine: 1, endLine: 1 })], DIFF);
  assert.equal(inline.length, 0);
  assert.equal(bodyOnly.length, 1);
});

test('a fix with a triple backtick gets a 4-backtick suggestion fence inline', () => {
  const { inline } = planReviewComments([postable({ suggestedFix: 'x = ```y```' })], DIFF);
  assert.match(inline[0].body, /````suggestion/);
});

const fakeOctokit = (calls) => ({
  rest: {
    pulls: {
      createReview: async (params) => {
        calls.push(params);
        if (calls.length === 1) throw Object.assign(new Error('unprocessable'), { status: 422 });
        return { data: { html_url: 'https://github.com/o/r/pull/1#review-2' } };
      },
    },
  },
});

test('postReview retries a 422 as a body-only review containing every finding', async () => {
  const calls = [];
  const findings = [postable(), postable({ id: 'F2', title: 'second', startLine: 4, endLine: 4 })];
  const result = await postReview(
    { token: 't', postComment: true, body: 'summary', findings, diff: DIFF, commitSha: 'sha', event: 'COMMENT', maxChars: 65000 },
    { owner: 'o', repo: 'r', pullNumber: 1 },
    () => fakeOctokit(calls),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].comments.length, 0);
  assert.match(calls[1].body, /second/);
  assert.match(calls[1].body, /Findings not on changed lines/);
  assert.equal(result.reviewUrl, 'https://github.com/o/r/pull/1#review-2');
});

test('postComment false makes no API call', async () => {
  const calls = [];
  await postReview(
    { token: 't', postComment: false, body: 'b', findings: [postable()], diff: DIFF, commitSha: 'sha', event: 'COMMENT', maxChars: 65000 },
    { owner: 'o', repo: 'r', pullNumber: 1 },
    () => fakeOctokit(calls),
  );
  assert.equal(calls.length, 0);
});
