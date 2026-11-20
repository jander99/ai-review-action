'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateReviewDocument,
  mergeReviewDocuments,
  MAX_CHARS,
  renderDocument,
  formatLocations,
  CANONICAL_FIELD_ORDER_TEXT,
} = require('../dist/index.cjs');

const TITLE = 'My Pull Request';

const CLEAN_DOCUMENT = [
  `# Review — ${TITLE}`,
  '',
  '## Scope',
  '- Reviewed test fixture',
  '',
  '## Summary',
  '',
  '- New findings: 0',
  '- Unresolved from prior review: 0',
  '- Resolved by latest commits: 0',
].join('\n');

const STANDARD_FINDING_DOCUMENT = [
  `# Review — ${TITLE}`,
  '',
  '## Scope',
  '- Reviewed test fixture',
  '',
  '## Summary',
  '',
  '- New findings: 1',
  '- Unresolved from prior review: 0',
  '- Resolved by latest commits: 0',
  '',
  '## Findings',
  '',
  '### 🔴 Critical — Missing input validation',
  '- Status: new',
  '- Location: src/foo.ts:42',
  '- Description: The function accepts untrusted input without validation.',
].join('\n');

test('BROKEN/no-findings document is valid', () => {
  const result = validateReviewDocument(CLEAN_DOCUMENT);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.title, TITLE);
  assert.deepEqual(result.document.summary, { new: 0, unresolved: 0, resolved: 0 });
  assert.equal(result.document.findings.length, 0);
});

test('standard finding document is valid', () => {
  const result = validateReviewDocument(STANDARD_FINDING_DOCUMENT);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.findings.length, 1);
  assert.equal(result.document.findings[0].severity, 'Critical');
  assert.equal(result.document.findings[0].status, 'new');
  assert.equal(result.document.findings[0].location, 'src/foo.ts:42');
});

test('wrong section order is invalid', () => {
  const reordered = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Missing input validation',
    '- Status: new',
    '- Location: src/foo.ts:42',
    '- Description: x',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(reordered);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Summary/);
});

test('loose `# Review plan` heading is invalid', () => {
  const loose = [
    '# Review plan',
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(loose);
  assert.equal(result.valid, false);
  assert.match(result.reason, /heading/);
});




test('missing Status field is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Missing input validation',
    '- Location: src/foo.ts:42',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Status|status/);
});

test('duplicate Status field is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Missing input validation',
    '- Status: new',
    '- Status: new',
    '- Location: src/foo.ts:42',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /duplicate/);
});

test('invalid Status value is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Missing input validation',
    '- Status: banana',
    '- Location: src/foo.ts:42',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Status/);
});

test('invalid Location (no line) is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Missing input validation',
    '- Status: new',
    '- Location: src/foo.ts',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Location/);
});

test('Location accepting line range is valid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🟡 Warning — Range reference',
    '- Status: new',
    '- Location: src/foo.ts:10-20',
    '- Description: range is acceptable',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, true, result.reason);
});

test('mismatched severity emoji is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🟢 Critical — Emoji mismatch',
    '- Status: new',
    '- Location: src/foo.ts:42',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
});

test('count mismatch is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 99',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🟢 Suggestion — Mismatch',
    '- Status: new',
    '- Location: src/foo.ts:1',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /count mismatch/);
});

test('arbitrary extra prose after final finding is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🟢 Suggestion — Last finding',
    '- Status: new',
    '- Location: src/foo.ts:1',
    '- Description: x',
    '',
    'Trailing prose that should not be here.',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /after final finding|inside finding block/);
});

test('document exceeding char cap is invalid', () => {
  const big = 'a'.repeat(MAX_CHARS + 1);
  const doc = `# Review — ${TITLE}\n\n## Scope\n- Reviewed test fixture\n\n## Summary\n\n- New findings: 0\n- Unresolved from prior review: 0\n- Resolved by latest commits: 0\n${big}`;
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /chars/);
});

test('legacy `# PR #N` heading is invalid (new contract is strict)', () => {
  const doc = [
    `# PR #42 Review — ${TITLE}`,
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
});

test('mergeReviewDocuments dedupes and recomputes counts', () => {
  const a = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 2',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Bug',
    '- Status: new',
    '- Location: src/a.ts:1',
    '- Description: d',
    '',
    '### 🟡 Warning — Bug 2',
    '- Status: new',
    '- Location: src/b.ts:2',
    '- Description: d',
  ].join('\n');

  const b = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 2',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Bug',
    '- Status: new',
    '- Location: src/a.ts:1',
    '- Description: d',
    '',
    '### 🟢 Suggestion — Bug 3',
    '- Status: new',
    '- Location: src/c.ts:3',
    '- Description: d',
  ].join('\n');

  const merged = mergeReviewDocuments([a, b], TITLE);
  const validation = validateReviewDocument(merged);
  assert.equal(validation.valid, true, validation.reason);
  assert.equal(validation.document.findings.length, 3);
  assert.equal(validation.document.summary.new, 3);
  assert.equal(validation.document.summary.unresolved, 0);
  assert.equal(validation.document.summary.resolved, 0);
});

test('mergeReviewDocuments counts new variant as New', () => {
  const a = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🟢 Suggestion — Variant',
    '- Status: new variant',
    '- Location: src/a.ts:1',
    '- Description: d',
  ].join('\n');

  const merged = mergeReviewDocuments([a], TITLE);
  const validation = validateReviewDocument(merged);
  assert.equal(validation.valid, true, validation.reason);
  assert.equal(validation.document.summary.new, 1);
});

test('mergeReviewDocuments handles unresolved and resolved statuses', () => {
  const a = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 1',
    '- Resolved by latest commits: 1',
    '',
    '## Findings',
    '',
    '### 🟢 Suggestion — New',
    '- Status: new',
    '- Location: src/a.ts:1',
    '- Description: d',
    '',
    '### 🟢 Suggestion — Unresolved',
    '- Status: unresolved',
    '- Location: src/b.ts:2',
    '- Description: d',
    '',
    '### 🟢 Suggestion — Resolved',
    '- Status: resolved',
    '- Location: src/c.ts:3',
    '- Description: d',
  ].join('\n');

  const merged = mergeReviewDocuments([a], TITLE);
  const validation = validateReviewDocument(merged);
  assert.equal(validation.valid, true, validation.reason);
  assert.equal(validation.document.summary.new, 1);
  assert.equal(validation.document.summary.unresolved, 1);
  assert.equal(validation.document.summary.resolved, 1);
});

test('mergeReviewDocuments flattens nested Scope bullets so the merged document round-trips through validateReviewDocument', () => {
  // Regression: before the flatten-on-merge fix, two valid documents
  // whose Scope sections contained nested bullets (which the validator's
  // nested-bullet fold accepts by appending '\n  sub-item' to the parent)
  // produced a merged document whose scope items had embedded newlines.
  // renderDocument emitted each as one bullet, the re-validation's outer
  // loop then saw the indented continuation as 'unexpected content
  // between heading and ## Summary', and the merge was rejected. Merge
  // must normalize scope items to single-line bullets so the round-trip
  // is stable.
  const docWithNested = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed file A',
    '  - sub item A1',
    '  - sub item A2',
    '- Reviewed file B',
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');

  const merged = mergeReviewDocuments([docWithNested, docWithNested], TITLE);
  const validation = validateReviewDocument(merged);
  assert.equal(validation.valid, true, validation.reason);
  for (const item of validation.document.scope || []) {
    assert.ok(!item.includes('\n'), `scope item must be flat (no embedded newlines), got: ${JSON.stringify(item)}`);
  }
});

test('deterministic merge output validates', () => {
  const original = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Merged finding',
    '- Status: new',
    '- Location: src/foo.ts:42',
    '- Description: Merged.',
  ].join('\n');
  const merged = mergeReviewDocuments([original], TITLE);
  const validation = validateReviewDocument(merged);
  assert.equal(validation.valid, true, validation.reason);
  assert.equal(validation.document.findings[0].severity, 'Critical');
});

test('mergeReviewDocuments throws when merged output exceeds MAX_CHARS', () => {
  // Regression: the merge must enforce the 256 KB contract cap on the
  // combined output. Two inputs near the cap can sum past the limit; the
  // merge itself throws so direct programmatic callers cannot silently
  // receive an invalid oversized document. Scope items must differ
  // across inputs so the deterministic dedup does not collapse them
  // back to a single item.
  const bigDoc = (suffix) => [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    `- ${'a'.repeat(MAX_CHARS / 2 + 100)}${suffix}`,
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');

  assert.throws(
    () => mergeReviewDocuments([bigDoc('1'), bigDoc('2')], TITLE),
    /exceeds \d+ chars/,
  );
});

test('renderDocument emits canonical shape', () => {
  const rendered = renderDocument({
    title: TITLE,
    scope: ['Reviewed test fixture'],
    summary: { new: 1, unresolved: 0, resolved: 0 },
    findings: [
      {
        severity: 'Critical',
        emoji: '🔴',
        title: 'Sample',
        status: 'new',
        location: 'src/foo.ts:1',
        description: 'desc',
      },
    ],
  });
  const validation = validateReviewDocument(rendered);
  assert.equal(validation.valid, true, validation.reason);
  assert.match(rendered, /^# Review — /);
  assert.match(rendered, /\n## Summary\n/);
  assert.match(rendered, /\n## Findings\n/);
  assert.match(rendered, /\n### 🔴 Critical — Sample\n/);
});

// -----------------------------------------------------------------------------
// Phase 1 bounded-remediation tests
// -----------------------------------------------------------------------------

test('empty `## Findings` section after the heading is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /## Findings section is present but contains no blocks/);
});

test('Description before Status in a block is invalid (out of order)', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Out of order',
    '- Description: description first',
    '- Status: new',
    '- Location: src/foo.ts:1',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /out of order/);
});

test('Location before Status in a block is invalid (out of order)', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '## Summary',
    '',
    '- New findings: 1',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Findings',
    '',
    '### 🔴 Critical — Out of order',
    '- Location: src/foo.ts:1',
    '- Status: new',
    '- Description: x',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /out of order/);
});

test('unterminated fenced block containing Summary is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed test fixture',
    '',
    '```markdown',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /malformed fenced code block before ## Summary/);
});





test('review-contract project.json declares a test target that runs node --test', () => {
  const projectPath = path.join(__dirname, '..', 'project.json');
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const testTarget = project.targets && project.targets.test;
  assert.ok(testTarget, 'review-contract project.json must declare a test target');
  assert.equal(testTarget.executor, 'nx:run-commands', 'test target executor must be nx:run-commands');
  assert.deepEqual(testTarget.dependsOn, ['build'], 'test target must depend on build');
  assert.equal(testTarget.options.cwd, 'packages/review-contract', 'test target must set cwd to the package');
  assert.match(
    testTarget.options.command,
    /node --test/,
    'test target command must run node --test on test/*.test.cjs',
  );
  assert.match(
    testTarget.options.command,
    /test\/\*\.test\.cjs/,
    'test target command must include the test glob',
  );
});

// -----------------------------------------------------------------------------
// Phase-6 bounded implementation: canonical multi-location support.
//
// The contract previously accepted only one `<path>:<line>(-<line>)` per
// finding. Cross-file findings (e.g. the real rejected example from
// AI Review run 30748322243) needed a way to cite multiple locations on
// one line. The grammar is now a comma-separated list of items, each
// independently matching the original path+line(/range) grammar.
// -----------------------------------------------------------------------------

const MULTI_LOCATION_PROLOGUE = [
  `# Review — ${TITLE}`,
  '',
  '## Scope',
  '- Reviewed test fixture',
  '',
  '## Summary',
  '',
  '- New findings: 1',
  '- Unresolved from prior review: 0',
  '- Resolved by latest commits: 0',
  '',
  '## Findings',
  '',
];

function buildDocument(locationLine) {
  return [
    ...MULTI_LOCATION_PROLOGUE,
    '### 🔴 Critical — Cross-file regression',
    '- Status: new',
    `- Location: ${locationLine}`,
    '- Description: helper called from two files',
    '',
  ].join('\n');
}

test('single-location finding remains valid (canonical grammar preserves one-location validity)', () => {
  const doc = buildDocument('src/foo.ts:42');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.findings.length, 1);
  assert.equal(result.document.findings[0].location, 'src/foo.ts:42');
});

test('comma-separated multi-location is valid and stored canonically', () => {
  const doc = buildDocument('a.ts:1, b.ts:2-3');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.findings.length, 1);
  // Canonical form: items trimmed, joined with ", ".
  assert.equal(result.document.findings[0].location, 'a.ts:1, b.ts:2-3');
});

test('multi-location with three or more items is valid', () => {
  const doc = buildDocument('a.ts:1, b.ts:2-3, c/d.ts:99');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.findings[0].location, 'a.ts:1, b.ts:2-3, c/d.ts:99');
});

test('real rejected example with natural-language "and" connector is invalid', () => {
  // Reproduces the AI Review run that motivated this fix: the model
  // emitted `Location: packages/run-reviews/src/agent-definition.ts:114
  // and packages/run-reviews/src/prompt-composer.ts:51`. The
  // deterministic validator must reject the "and" connector with a
  // useful reason referencing comma separation.
  const doc = buildDocument(
    'packages/run-reviews/src/agent-definition.ts:114 and packages/run-reviews/src/prompt-composer.ts:51',
  );
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false, 'natural-language "and" connector must be rejected');
  assert.match(
    result.reason,
    /comma/i,
    `invalid reason must reference comma-separated grammar; got: ${result.reason}`,
  );
});

test('natural-language connectors "or" and "&" are rejected', () => {
  for (const connector of ['or', '&']) {
    const doc = buildDocument(`a.ts:1 ${connector} b.ts:2`);
    const result = validateReviewDocument(doc);
    assert.equal(result.valid, false, `connector "${connector}" must be rejected`);
    assert.match(result.reason, /comma/i, `reason must reference comma-separated grammar; got: ${result.reason}`);
  }
});

test('semicolon delimiter is rejected', () => {
  const doc = buildDocument('a.ts:1; b.ts:2');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false, 'semicolon delimiter must be rejected');
  assert.match(result.reason, /comma/i, `reason must reference comma-separated grammar; got: ${result.reason}`);
});

test('trailing comma is rejected (empty item)', () => {
  const doc = buildDocument('a.ts:1,');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false, 'trailing comma must be rejected');
  assert.match(result.reason, /empty|trailing|comma/i, `reason must reference empty item / trailing comma; got: ${result.reason}`);
});

test('leading comma is rejected (empty item)', () => {
  const doc = buildDocument(', a.ts:1');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false, 'leading comma must be rejected');
  assert.match(result.reason, /empty|trailing|comma/i, `reason must reference empty item / trailing comma; got: ${result.reason}`);
});

test('malformed second item is rejected with a useful reason', () => {
  const doc = buildDocument('a.ts:1, not-a-valid-location');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false, 'malformed second item must be rejected');
  assert.match(
    result.reason,
    /not-a-valid-location|item/i,
    `reason must reference the malformed item; got: ${result.reason}`,
  );
});

test('empty Location field is rejected', () => {
  const doc = buildDocument('');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false, 'empty Location must be rejected');
  assert.match(result.reason, /Location/i, `reason must mention Location; got: ${result.reason}`);
});

test('round-trip: rendered multi-location document validates and re-canonicalizes', () => {
  // Build a ParsedDocument with a multi-location finding, render it
  // to canonical markdown, and confirm the rendered form re-validates
  // and yields the same canonical location string. This is the
  // round-trip guarantee the prompt-template changes depend on.
  const rendered = renderDocument({
    title: TITLE,
    scope: ['Reviewed test fixture'],
    summary: { new: 1, unresolved: 0, resolved: 0 },
    findings: [
      {
        severity: 'Critical',
        emoji: '🔴',
        title: 'Cross-file',
        status: 'new',
        location: 'a.ts:1, b.ts:2-3',
        description: 'desc',
      },
    ],
  });
  const revalidation = validateReviewDocument(rendered);
  assert.equal(revalidation.valid, true, revalidation.reason);
  assert.equal(revalidation.document.findings[0].location, 'a.ts:1, b.ts:2-3');
});

test('formatLocations emits canonical comma-space joined form', () => {
  assert.equal(formatLocations(['a.ts:1']), 'a.ts:1');
  assert.equal(formatLocations(['a.ts:1', 'b.ts:2-3']), 'a.ts:1, b.ts:2-3');
  assert.equal(
    formatLocations(['a.ts:1', 'b.ts:2-3', 'c/d.ts:99']),
    'a.ts:1, b.ts:2-3, c/d.ts:99',
  );
});

test('mergeReviewDocuments dedupes by canonical multi-location string', () => {
  const a = buildDocument('a.ts:1, b.ts:2-3');
  const b = buildDocument('a.ts:1, b.ts:2-3');
  const merged = mergeReviewDocuments([a, b], TITLE);
  const validation = validateReviewDocument(merged);
  assert.equal(validation.valid, true, validation.reason);
  assert.equal(validation.document.findings.length, 1, 'identical multi-location findings must dedupe to one');
  assert.equal(validation.document.summary.new, 1);
});


// -----------------------------------------------------------------------------
// Phase-7 bounded implementation: completion sentinel.
//
// The review model may emit
//   <!-- AI_REVIEW_DONE -->
// as the final line of their reply. The deterministic parser strips
// the sentinel plus everything after it (outside a fenced code
// block) before structural validation, so post-review scratch prose
// never breaks downstream validation. The sentinel is OPTIONAL -
// absence never causes rejection.
// -----------------------------------------------------------------------------

const SENTINEL = '<!-- AI_REVIEW_DONE -->';










test('Scope section with bullet lines validates before Summary', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- packages/review-contract/src/index.ts',
    '- Validator ordering and rendering',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.deepEqual({ valid: result.valid, reason: result.reason }, { valid: true, reason: '' });
  assert.deepEqual(result.document.scope, [
    'packages/review-contract/src/index.ts',
    'Validator ordering and rendering',
  ]);
});

test('Scope section with no bullets is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /## Scope section is present but contains no bullets/);
});

test('duplicate Scope sections are invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- First area',
    '',
    '## Scope',
    '- Second area',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /duplicate ## Scope section/);
});

test('Scope after Summary is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
    '',
    '## Scope',
    '- Reviewed X',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
});

test('unexpected heading between Scope and Summary is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed X',
    '',
    '## Random',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /unexpected content between heading and ## Summary/);
});

test('renderDocument renders required Scope before Summary', () => {
  const rendered = renderDocument({
    title: TITLE,
    scope: ['Reviewed X'],
    summary: { new: 0, unresolved: 0, resolved: 0 },
    findings: [],
  });
  assert.match(rendered, /^# Review — My Pull Request\n\n## Scope\n- Reviewed X\n\n## Summary\n/);
  assert.equal(validateReviewDocument(rendered).valid, true);
});

test('document without a Scope section is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Summary',
    '',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing ## Scope section/);
});

test('Scope without Summary remains invalid with the missing Summary reason', () => {
  const doc = [
    `# Review — ${TITLE}`,
    '',
    '## Scope',
    '- Reviewed the change.',
  ].join('\n');
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing ## Summary section/);
});
const TRIAGE_DOC = `# Review — triage

> Triage: Scrutinize: high risk.

## Scope

- a.ts

## Summary

- New findings: 1
- Unresolved from prior review: 0
- Resolved by latest commits: 0
- Uncertain (not confirmed): 1

## Findings

### 🔴 Critical — boom
- Status: new
- Location: a.ts:1-1
- Description: it breaks

## Uncertain

<details><summary>1 finding the judge could not confirm</summary>

### 🟢 Suggestion — maybe
- Status: new
- Location: a.ts:3-4
- Description: unclear (P(supported)=0.52)

</details>
`;

test('triage line, fourth summary bullet and uncertain section round-trip', () => {
  const parsed = validateReviewDocument(TRIAGE_DOC);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.document.triage, 'Scrutinize: high risk.');
  assert.equal(parsed.document.summary.uncertain, 1);
  assert.equal(parsed.document.uncertain.length, 1);
  const rendered = renderDocument(parsed.document);
  const validated = validateReviewDocument(rendered);
  assert.equal(validated.valid, true);
  assert.equal(validated.document.uncertain.length, 1);
});

test('uncertain section before findings is invalid', () => {
  const bad = TRIAGE_DOC.replace('## Findings', '## X').replace('## Uncertain', '## Findings').replace('## X', '## Uncertain');
  assert.equal(validateReviewDocument(bad).valid, false);
});

test('a document without the new sections still validates', () => {
  const plain = `# Review — plain

## Scope

- a.ts

## Summary

- New findings: 0
- Unresolved from prior review: 0
- Resolved by latest commits: 0
`;
  assert.equal(validateReviewDocument(plain).valid, true);
});

test('validates a review whose findings are all uncertain', () => {
  const { renderDocument, validateReviewDocument } = require('../dist/index.cjs');
  const finding = { severity: 'Warning', emoji: '🟡', title: 't', status: 'new', location: 'a.ts:2', description: 'd' };
  const doc = renderDocument({
    title: 'x', scope: ['s'], summary: { new: 0, unresolved: 0, resolved: 0, uncertain: 1 }, findings: [], uncertain: [finding],
  });
  const result = validateReviewDocument(doc);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.uncertain.length, 1);
});

test('validates a review that counts duplicates of prior findings without rendering them', () => {
  const { renderDocument, validateReviewDocument } = require('../dist/index.cjs');
  const finding = { severity: 'Warning', emoji: '🟡', title: 't', status: 'new', location: 'a.ts:2', description: 'd' };
  const kept = renderDocument({ title: 'x', scope: ['s'], summary: { new: 1, unresolved: 2, resolved: 0 }, findings: [finding] });
  assert.equal(validateReviewDocument(kept).valid, true);
  const none = renderDocument({ title: 'x', scope: ['s'], summary: { new: 0, unresolved: 2, resolved: 0 }, findings: [] });
  assert.equal(validateReviewDocument(none).valid, true);
  // blocks still cannot outnumber the summary
  const bad = renderDocument({ title: 'x', scope: ['s'], summary: { new: 0, unresolved: 0, resolved: 0 }, findings: [{ ...finding, status: 'unresolved' }] });
  assert.equal(validateReviewDocument(bad).valid, false);
});
