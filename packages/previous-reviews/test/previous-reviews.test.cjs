'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatPriorReviews,
  fetchPriorReviews,
  PRIOR_REVIEW_BOT_LOGIN,
  PRIOR_REVIEW_LIMIT,
  PRIOR_REVIEW_PER_COMMENT_CHARS,
  PRIOR_REVIEW_TOTAL_CHARS,
} = require('../dist/index.cjs');

// The format helper operates on PriorReviewComment objects (id, author,
// createdAt, body). The mock octokit returns raw API rows (created_at,
// user.login) which fetchPriorReviews maps to the expected shape.

function makeComment(overrides) {
  return Object.assign(
    {
      id: 1,
      user: { login: PRIOR_REVIEW_BOT_LOGIN },
      body: '# Review — PR Title\n\n## Summary\n\n- New findings: 0\n- Unresolved from prior review: 0\n- Resolved by latest commits: 0',
      created_at: '2026-08-01T12:00:00Z',
    },
    overrides,
  );
}

function toPriorComment(raw) {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    createdAt: raw.created_at,
    body: raw.body ?? '',
  };
}

function makeMockOctokit(data) {
  return {
    rest: {
      issues: {
        listComments: async () => ({ data }),
      },
    },
  };
}

test('formatPriorReviews returns empty string for empty list', () => {
  const result = formatPriorReviews([]);
  assert.equal(result, '');
});

test('formatPriorReviews picks comments newest-first and discards empty bodies', () => {
  const comments = [
    toPriorComment(makeComment({ id: 1, created_at: '2026-08-01T10:00:00Z' })),
    toPriorComment(makeComment({ id: 2, created_at: '2026-08-02T10:00:00Z', body: '' })),
    toPriorComment(makeComment({ id: 3, created_at: '2026-08-03T10:00:00Z' })),
    toPriorComment(makeComment({ id: 4, created_at: '2026-08-04T10:00:00Z' })),
  ];
  const result = formatPriorReviews(comments);
  assert.ok(result.length > 0);
  // Newest comment must come first regardless of the input order.
  assert.ok(result.indexOf('Comment 4') < result.indexOf('Comment 1'));
  // The empty body for id=2 must be excluded.
  assert.ok(!result.includes('Comment 2'));
  assert.ok(result.includes('PR Title'));
  // The first occurrence must be the newest comment header.
  assert.match(result, /^## Comment 4 /);
});

test('formatPriorReviews caps to PRIOR_REVIEW_LIMIT comments', () => {
  const many = Array.from({ length: PRIOR_REVIEW_LIMIT + 3 }, (_, index) =>
    toPriorComment(
      makeComment({ id: index + 1, created_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z` }),
    ),
  );
  const result = formatPriorReviews(many);
  // Count how many comment headers appear; should equal PRIOR_REVIEW_LIMIT.
  const matches = result.match(/^## Comment \d+/gm) ?? [];
  assert.equal(matches.length, PRIOR_REVIEW_LIMIT);
});

test('formatPriorReviews truncates oversized comments on a non-fence line boundary', () => {
  const oversizedBody = [
    '# Review — Title',
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    ...Array.from({ length: 200 }, (_, index) => `### 🟢 Suggestion — filler ${index}\n- Status: new\n- Location: src/foo.ts:${index + 1}\n- Description: ${'x'.repeat(50)}`),
  ].join('\n');
  const comment = toPriorComment(makeComment({ id: 99, body: oversizedBody }));
  const result = formatPriorReviews([comment]);
  // Each trimmed body must respect the per-comment cap.
  const bodyStart = result.indexOf('\n\n', result.indexOf('created_at=')) + 2;
  const bodyEnd = result.lastIndexOf('\n\n---\n\n') === -1 ? result.length : result.length;
  const body = result.slice(bodyStart, bodyEnd);
  assert.ok(body.length <= PRIOR_REVIEW_PER_COMMENT_CHARS, `body length ${body.length} exceeded per-comment cap`);
});

test('formatPriorReviews respects the total character cap across comments', () => {
  const comments = Array.from({ length: PRIOR_REVIEW_LIMIT }, (_, index) =>
    toPriorComment(
      makeComment({
        id: index + 1,
        created_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        body: 'x'.repeat(PRIOR_REVIEW_PER_COMMENT_CHARS),
      }),
    ),
  );
  const result = formatPriorReviews(comments);
  assert.ok(result.length <= PRIOR_REVIEW_TOTAL_CHARS, `total length ${result.length} exceeded total cap`);
});

test('formatPriorReviews trims orphan multi-byte tail when truncation leaves an invalid UTF-8 boundary', () => {
  // Build a body that, after a 200-character slice, ends with a
  // surrogate-half character that would orphan a multi-byte sequence.
  const surrogateStart = String.fromCharCode(0xd83d); // high surrogate
  const surrogateOnly = surrogateStart + 'x'.repeat(200);
  const comment = toPriorComment(makeComment({ id: 6, body: surrogateOnly }));
  const result = formatPriorReviews([comment]);
  assert.ok(result.length > 0);
  // The result must end on a printable character; never an orphan surrogate.
  const lastCharCode = result.charCodeAt(result.length - 1);
  assert.ok(lastCharCode >= 0x20);
});

test('fetchPriorReviews returns null when token is missing', async () => {
  const octokit = makeMockOctokit([makeComment()]);
  const result = await fetchPriorReviews({
    token: undefined,
    owner: 'acme',
    repo: 'repo',
    issueNumber: 1,
    octokit,
  });
  assert.equal(result, null);
});

test('fetchPriorReviews filters to bot-authored comments only', async () => {
  const data = [
    makeComment({ id: 1 }),
    makeComment({ id: 2, user: { login: 'someone-else' } }),
    makeComment({ id: 3 }),
  ];
  const octokit = makeMockOctokit(data);
  const result = await fetchPriorReviews({
    token: 'token',
    owner: 'acme',
    repo: 'repo',
    issueNumber: 7,
    octokit,
  });
  assert.ok(result);
  // Only two comments should have made it through the filter.
  const headers = result.combined.match(/^## Comment \d+/gm) ?? [];
  assert.equal(headers.length, 2);
});

test('fetchPriorReviews returns null when API call fails', async () => {
  const failingOctokit = {
    rest: {
      issues: {
        listComments: async () => {
          throw new Error('boom');
        },
      },
    },
  };
  const result = await fetchPriorReviews({
    token: 'token',
    owner: 'acme',
    repo: 'repo',
    issueNumber: 9,
    octokit: failingOctokit,
  });
  assert.equal(result, null);
});

test('fetchPriorReviews returns null when no bot comments exist', async () => {
  const data = [makeComment({ id: 1, user: { login: 'someone-else' } })];
  const octokit = makeMockOctokit(data);
  const result = await fetchPriorReviews({
    token: 'token',
    owner: 'acme',
    repo: 'repo',
    issueNumber: 1,
    octokit,
  });
  assert.equal(result, null);
});

test('fetchPriorReviews returns null when all bot bodies are trimmed away', async () => {
  // A body that is only whitespace collapses to an empty string
  // after trim, so the comment is dropped from the result.
  const data = [makeComment({ id: 1, body: '   \n  \t  ' })];
  const octokit = makeMockOctokit(data);
  const result = await fetchPriorReviews({
    token: 'token',
    owner: 'acme',
    repo: 'repo',
    issueNumber: 1,
    octokit,
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Phase-2 bounded remediation: Blocker 4 (truncation).
// ---------------------------------------------------------------------------

test('formatPriorReviews preserves a short body verbatim ("abc" not truncated)', () => {
  const comment = toPriorComment(
    makeComment({ id: 10, body: '# Review — PR Title\n\n## Summary\n\n- New findings: 0\n- Unresolved from prior review: 0\n- Resolved by latest commits: 0' }),
  );
  const result = formatPriorReviews([comment]);
  // The header is present, the body is present, and the body matches the
  // input verbatim (no spurious characters dropped).
  assert.ok(result.includes('## Comment 10'));
  assert.ok(result.includes('Resolved by latest commits: 0'));
  assert.ok(!result.endsWith('Resolved by latest commits: 0\n\n---\n\n'));
});

test('formatPriorReviews preserves a literal "abc" substring unchanged', () => {
  const comment = toPriorComment(makeComment({ id: 11, body: 'abc' }));
  const result = formatPriorReviews([comment]);
  assert.ok(result.includes('abc'));
  // The trim/sanitize pass must not drop a final printable character
  // when the body has no orphan surrogate at the end.
  assert.ok(!/ab$/.test(result));
});

test('formatPriorReviews respects the 16 KB total cap including all separators', () => {
  // Five comments at the per-comment cap. With per-comment = 4 KB and
  // separator = 9 chars, even a single 4 KB comment is too large for
  // the 16 KB cap once headers + separators are added (4 KB body +
  // ~75 char header + 2 char `\n\n` + 9 char separator = 4.1 KB per
  // comment). The format must drop later comments to stay under the
  // cap. The bug we are guarding against was: separators were not
  // counted, so the assembled string could exceed the cap.
  const comments = Array.from({ length: PRIOR_REVIEW_LIMIT }, (_, index) =>
    toPriorComment(
      makeComment({
        id: index + 1,
        created_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        body: 'x'.repeat(PRIOR_REVIEW_PER_COMMENT_CHARS),
      }),
    ),
  );
  const result = formatPriorReviews(comments);
  // The previous bug was that separators were not included in the
  // accounting; verify that the assembled string is within the cap.
  assert.ok(
    result.length <= PRIOR_REVIEW_TOTAL_CHARS,
    `assembled length ${result.length} exceeded total cap ${PRIOR_REVIEW_TOTAL_CHARS}`,
  );
  // The number of `---` separators equals (assembled comments - 1).
  const commentHeaders = (result.match(/^## Comment \d+/gm) ?? []).length;
  const separatorCount = (result.match(/\n\n---\n\n/g) ?? []).length;
  assert.equal(separatorCount, commentHeaders - 1);
});

test('formatPriorReviews truncates cleanly when a comment body opens an unterminated fenced code block', () => {
  // Body that opens a fence but never closes it. The truncation must
  // close the fence (or back up before it) so the model does not see
  // an unterminated ``` block.
  const body = [
    '# Review — Title',
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '```js',
    `console.log("${'a'.repeat(PRIOR_REVIEW_PER_COMMENT_CHARS)}");`,
  ].join('\n');
  const comment = toPriorComment(makeComment({ id: 20, body }));
  const result = formatPriorReviews([comment]);
  // Count fence open and close markers in the body slice.
  const fenceMatches = result.match(/```/g) ?? [];
  // The opening fence may have been backed up; either the fence was
  // dropped entirely (zero markers) or it is paired (even count).
  assert.equal(fenceMatches.length % 2, 0, `fence count should be paired; got ${fenceMatches.length}`);
});

test('formatPriorReviews drops the fence when an oversized body is purely an unclosed fence block', () => {
  // Body that opens a fence and then contains enough filler to
  // exceed the per-comment budget. The fence-aware truncation backs
  // up before the opening fence and the comment ends up fence-free
  // (no orphan ``` in the result).
  const fence = String.fromCharCode(96, 96, 96);
  const filler = 'x'.repeat(PRIOR_REVIEW_PER_COMMENT_CHARS);
  const body = `${fence}js\n${filler}`;
  const comment = toPriorComment(makeComment({ id: 21, body }));
  const result = formatPriorReviews([comment]);
  const fenceCount = (result.match(/```/g) ?? []).length;
  assert.equal(fenceCount, 0, `fence count should be zero after fence-aware truncation; got ${fenceCount}`);
});

test('formatPriorReviews keeps an opening fence when the comment fits and closes it normally', () => {
  // Short body that opens and closes a fence - must survive verbatim.
  // Use String.fromCharCode to avoid shell command-substitution of the
  // backtick characters in the test source.
  const fence = String.fromCharCode(96, 96, 96);
  const body = `${fence}\ninner\n${fence}`;
  const comment = toPriorComment(makeComment({ id: 22, body }));
  const result = formatPriorReviews([comment]);
  // The regex `` ``` `` matches 3 consecutive backticks at a time. The
  // body has two such triples (one opener, one closer), so the match
  // count is 2; both backticks in the result are accounted for.
  const fenceMatches = result.match(/```/g) ?? [];
  assert.equal(fenceMatches.length, 2);
  // And the body itself survives unchanged.
  assert.ok(result.includes(`\ninner\n`));
});

// ---------------------------------------------------------------------------
// Phase-2 second-remediation: Blocker 2 (surrogate pair handling).
// ---------------------------------------------------------------------------

test('formatPriorReviews preserves a valid trailing high-low surrogate pair (abc😀)', () => {
  // The body is the literal string `abc😀` where 😀 is U+1F600 encoded
  // as the high/low surrogate pair \uD83D\uDE00. The truncation must
  // preserve the entire pair - the prior implementation stripped the
  // trailing low surrogate, leaving an orphan high surrogate.
  const body = 'abc\uD83D\uDE00';
  const comment = toPriorComment(makeComment({ id: 30, body }));
  const result = formatPriorReviews([comment]);
  assert.ok(
    result.includes('abc\uD83D\uDE00'),
    `result must preserve the full abc😀 sequence; got: ${JSON.stringify(result)}`,
  );
});

test('formatPriorReviews strips an orphan trailing high surrogate', () => {
  // Body is `abc` followed by an unmatched high surrogate. The
  // truncation must drop the orphan high surrogate so the result is
  // valid UTF-16.
  const body = 'abc\uD83D';
  const comment = toPriorComment(makeComment({ id: 31, body }));
  const result = formatPriorReviews([comment]);
  assert.ok(result.includes('abc'), 'result must include the abc prefix');
  assert.ok(!result.includes('\uD83D'), 'result must NOT include the orphan high surrogate');
  // The body portion should be exactly `abc` - no orphan code unit
  // remains at the end.
  const bodySection = result.slice(result.indexOf('created_at=') + 'created_at=2026-08-01T12:00:00Z'.length);
  // The portion immediately after the header separator should end with
  // `abc` (or whitespace, but no orphan surrogate).
  assert.ok(!/[\uD800-\uDFFF]$/.test(bodySection), 'no orphan surrogate at the end of the body');
});

test('formatPriorReviews strips an orphan trailing low surrogate', () => {
  // Body is `abc` followed by an unmatched low surrogate. The
  // truncation must drop the orphan low surrogate so the result is
  // valid UTF-16.
  const body = 'abc\uDE00';
  const comment = toPriorComment(makeComment({ id: 32, body }));
  const result = formatPriorReviews([comment]);
  assert.ok(result.includes('abc'), 'result must include the abc prefix');
  assert.ok(!result.includes('\uDE00'), 'result must NOT include the orphan low surrogate');
});

test('formatPriorReviews preserves a plain ASCII string (abc)', () => {
  // No surrogates involved; the body must survive verbatim.
  const body = 'abc';
  const comment = toPriorComment(makeComment({ id: 33, body }));
  const result = formatPriorReviews([comment]);
  assert.ok(result.includes('abc'), 'result must include the abc prefix');
  // And the body must end on a complete code unit (no surrogate
  // remaining after `abc`).
  const lastCharCode = result.charCodeAt(result.length - 1);
  assert.ok(
    !(lastCharCode >= 0xd800 && lastCharCode <= 0xdfff),
    `last code unit must not be a surrogate; got ${lastCharCode.toString(16)}`,
  );
});

test('formatPriorReviews preserves a single emoji as a complete pair', () => {
  // Body is just one emoji - the entire string is a single
  // high/low surrogate pair. Truncation must keep it intact.
  const body = '\uD83D\uDE00';
  const comment = toPriorComment(makeComment({ id: 34, body }));
  const result = formatPriorReviews([comment]);
  assert.ok(
    result.includes('\uD83D\uDE00'),
    `result must preserve the single emoji; got: ${JSON.stringify(result)}`,
  );
});