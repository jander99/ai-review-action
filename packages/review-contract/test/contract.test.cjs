'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  stripSentinelBoundary,
  extractReviewDocument,
  validateReviewDocument,
  mergeReviewDocuments,
  MAX_CHARS,
  renderDocument,
  formatLocations,
  REVIEW_DONE_SENTINEL,
  REVIEW_AGENT_PROMPT_TEMPLATE,
  SYNTHESIS_AGENT_PROMPT_TEMPLATE,
  VALIDATOR_AGENT_PROMPT_TEMPLATE,
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

test('extraction strips preamble', () => {
  const raw = [
    'reasoning preamble here',
    '   ',
    'still thinking...',
    `${'# Review — '}${TITLE}`,
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
  const extracted = extractReviewDocument(raw);
  assert.ok(extracted);
  assert.ok(extracted.startsWith(`# Review — ${TITLE}`));
  assert.ok(!extracted.includes('reasoning preamble'));
});

test('extraction ignores heading inside fenced code block', () => {
  const raw = [
    '```',
    `# Review — fake heading on purpose`,
    '```',
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
  const extracted = extractReviewDocument(raw);
  assert.ok(extracted);
  assert.ok(extracted.startsWith(`# Review — ${TITLE}`));
  assert.ok(!extracted.includes('fake heading on purpose'));
});

test('extraction returns null when no strict heading exists', () => {
  const raw = 'no heading here at all';
  assert.equal(extractReviewDocument(raw), null);
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

test('fusion-style merged output validates', () => {
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
    '### 🔴 Critical — Fused finding',
    '- Status: new',
    '- Location: src/foo.ts:42',
    '- Description: Fused.',
  ].join('\n');
  const fused = mergeReviewDocuments([original], TITLE);
  const validation = validateReviewDocument(fused);
  assert.equal(validation.valid, true, validation.reason);
  assert.equal(validation.document.findings[0].severity, 'Critical');
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

test('all three prompt templates reference the canonical field order text', () => {
  for (const [name, template] of [
    ['REVIEW_AGENT_PROMPT_TEMPLATE', REVIEW_AGENT_PROMPT_TEMPLATE],
    ['SYNTHESIS_AGENT_PROMPT_TEMPLATE', SYNTHESIS_AGENT_PROMPT_TEMPLATE],
    ['VALIDATOR_AGENT_PROMPT_TEMPLATE', VALIDATOR_AGENT_PROMPT_TEMPLATE],
  ]) {
    assert.ok(
      template.includes(CANONICAL_FIELD_ORDER_TEXT),
      `${name} must reference the canonical field order text: "${CANONICAL_FIELD_ORDER_TEXT}"`,
    );
  }
});

test('review agent and synthesis agent prompts share a "no prose outside this shape" rule', () => {
  for (const [name, template] of [
    ['REVIEW_AGENT_PROMPT_TEMPLATE', REVIEW_AGENT_PROMPT_TEMPLATE],
    ['SYNTHESIS_AGENT_PROMPT_TEMPLATE', SYNTHESIS_AGENT_PROMPT_TEMPLATE],
  ]) {
    assert.match(template, /No prose outside this shape/, `${name} must declare the no-prose rule`);
  }
});

test('review agent prompt declares the heading-first reply constraint', () => {
  // Bound the regression where the model emitted preamble prose /
  // tool-call XML before the '# Review — <title-or-ref>' heading.
  // The constraint must appear near the top of the prompt so the
  // model sees it before any other guidance.
  assert.match(
    REVIEW_AGENT_PROMPT_TEMPLATE,
    /Your final reply MUST begin with the heading "# Review — <title-or-ref>" on the very first line; emit no preamble, no explanation, and no tool-call XML before the heading\./,
    'REVIEW_AGENT_PROMPT_TEMPLATE must declare the heading-first reply constraint',
  );
  // The constraint must appear before any other rule. Locate the
  // "Runtime context:" header and assert the constraint precedes it.
  const constraintIdx = REVIEW_AGENT_PROMPT_TEMPLATE.indexOf(
    'Your final reply MUST begin with the heading',
  );
  const runtimeContextIdx = REVIEW_AGENT_PROMPT_TEMPLATE.indexOf('Runtime context:');
  assert.ok(constraintIdx >= 0, 'constraint must be present');
  assert.ok(runtimeContextIdx >= 0, 'Runtime context: header must be present');
  assert.ok(
    constraintIdx < runtimeContextIdx,
    `constraint must precede the Runtime context: header (constraint=${constraintIdx}, runtime=${runtimeContextIdx})`,
  );
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

test('all three prompt templates declare the comma-separated multi-location grammar', () => {
  for (const [name, template] of [
    ['REVIEW_AGENT_PROMPT_TEMPLATE', REVIEW_AGENT_PROMPT_TEMPLATE],
    ['SYNTHESIS_AGENT_PROMPT_TEMPLATE', SYNTHESIS_AGENT_PROMPT_TEMPLATE],
    ['VALIDATOR_AGENT_PROMPT_TEMPLATE', VALIDATOR_AGENT_PROMPT_TEMPLATE],
  ]) {
    assert.match(
      template,
      /comma-separated/i,
      `${name} must mention the comma-separated multi-location grammar`,
    );
    // The model must also be steered AWAY from natural-language
    // connectors. Each template either spells out the literal
    // connector tokens (`and` / `or` / `&`) or warns about
    // semicolons / markdown links / bullets. Match any of those.
    assert.match(
      template,
      /(and|or|&|semicolon|markdown|bullets?)/i,
      `${name} must steer the model away from natural-language connectors`,
    );
  }
});

// -----------------------------------------------------------------------------
// Phase-7 bounded implementation: completion sentinel.
//
// The review and synthesis models may emit
//   <!-- AI_REVIEW_DONE -->
// as the final line of their reply. The deterministic parser strips
// the sentinel plus everything after it (outside a fenced code
// block) before structural validation, so post-review scratch prose
// never breaks downstream validation. The sentinel is OPTIONAL -
// absence never causes rejection.
// -----------------------------------------------------------------------------

const SENTINEL = '<!-- AI_REVIEW_DONE -->';

test('REVIEW_DONE_SENTINEL is exported and uses the exact approved token', () => {
  assert.equal(REVIEW_DONE_SENTINEL, SENTINEL);
});

test('valid review + sentinel + trailing prose extracts to the review with no sentinel and no trailing prose', () => {
  const doc = [
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
    '',
    SENTINEL,
    'extra scratch prose the model emitted after completion',
    'second line of scratch prose that must also be discarded',
  ].join('\n');

  const extracted = extractReviewDocument(doc);
  assert.ok(extracted, 'extractor must return a non-null document');
  assert.ok(extracted.startsWith(`# Review — ${TITLE}`), 'extracted text must begin with the canonical heading');
  assert.ok(!extracted.includes(SENTINEL), `extracted text must not contain the sentinel; got: ${JSON.stringify(extracted)}`);
  assert.ok(
    !extracted.includes('extra scratch prose'),
    'extracted text must not contain post-sentinel scratch prose',
  );
  assert.ok(
    !extracted.includes('second line of scratch prose'),
    'extracted text must not contain the second scratch-prose line',
  );

  // The extracted document must also pass deterministic validation
  // end-to-end (summary zero, no findings).
  const result = validateReviewDocument(extracted);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.findings.length, 0);
});

test('sentinel with trailing prose and a finding still validates and yields the finding', () => {
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
    '### 🔴 Critical — Bug',
    '- Status: new',
    '- Location: src/foo.ts:1',
    '- Description: d',
    '',
    SENTINEL,
    'junk that must be discarded',
  ].join('\n');

  const extracted = extractReviewDocument(doc);
  assert.ok(extracted);
  const result = validateReviewDocument(extracted);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.document.findings.length, 1);
  assert.equal(result.document.findings[0].title, 'Bug');
  assert.ok(!extracted.includes(SENTINEL));
  assert.ok(!extracted.includes('junk that must be discarded'));
});

test('text without a sentinel preserves existing behavior (input passes through unchanged)', () => {
  const doc = [
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

  const extracted = extractReviewDocument(doc);
  assert.ok(extracted);
  // No sentinel in the input -> the extracted body must equal what
  // the heading extractor would produce on its own.
  const validation = validateReviewDocument(extracted);
  assert.equal(validation.valid, true, validation.reason);
});

test('sentinel inside a fenced code block is ignored', () => {
  const doc = [
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
    '',
    '```markdown',
    SENTINEL,
    'inside a code block - must NOT trigger sentinel slicing',
    '```',
    '',
    'after the fence: still part of the document',
  ].join('\n');

  const extracted = extractReviewDocument(doc);
  assert.ok(extracted);
  // The extractor discards preamble before the heading, but the
  // sentinel inside the fence should NOT have triggered slicing.
  // Concretely: 'after the fence: still part of the document' is on
  // a blank-after-findings document so it would itself trigger the
  // 'unexpected content after final finding' rejection if it were
  // preserved. We assert the rejection fires so we know the
  // sentinel did NOT truncate the document prematurely.
  const validation = validateReviewDocument(extracted);
  assert.equal(validation.valid, false, 'document must remain intact (sentinel inside fence is ignored)');
  assert.match(
    validation.reason,
    /after final finding|unexpected content/i,
    `expected a post-finding content rejection; got: ${validation.reason}`,
  );
});

test('first eligible sentinel wins when more than one exists', () => {
  // First sentinel (before the second prose block) is eligible and
  // must win. The second sentinel (inside the post-prose) is never
  // reached.
  const doc = [
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
    '',
    SENTINEL,
    'prose between the two sentinels',
    SENTINEL,
    'prose after the second sentinel',
  ].join('\n');

  const extracted = extractReviewDocument(doc);
  assert.ok(extracted);
  assert.ok(extracted.startsWith(`# Review — ${TITLE}`));
  assert.ok(!extracted.includes(SENTINEL), 'both sentinels must be stripped');
  assert.ok(
    !extracted.includes('prose between the two sentinels'),
    'prose between the two sentinels must be stripped (first eligible wins)',
  );
  assert.ok(
    !extracted.includes('prose after the second sentinel'),
    'prose after the second sentinel must also be stripped',
  );
});

test('stripSentinelBoundary is a pure no-op when the token is absent', () => {
  const text = 'just some prose\nno sentinel here\n';
  assert.equal(stripSentinelBoundary(text), text);
});

test('stripSentinelBoundary preserves everything before the sentinel and discards the rest', () => {
  const before = 'first line\nsecond line';
  const after = SENTINEL;
  const text = `${before}\n${after}\ntail`;
  assert.equal(stripSentinelBoundary(text), before);
});

test('stripSentinelBoundary inside a fenced code block is ignored', () => {
  const before = 'first line\n```\n' + SENTINEL + '\n```\nlast line';
  assert.equal(stripSentinelBoundary(before), before);
});

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
test('REVIEW and SYNTHESIS templates require the final-line sentinel; VALIDATOR template does not', () => {
  // Both model templates must instruct the model to emit the exact
  // token on its own line and treat it as a stand-alone completion
  // marker. The exact token MUST appear in each prompt so the model
  // does not invent a near-miss variant.
  for (const [name, template] of [
    ['REVIEW_AGENT_PROMPT_TEMPLATE', REVIEW_AGENT_PROMPT_TEMPLATE],
    ['SYNTHESIS_AGENT_PROMPT_TEMPLATE', SYNTHESIS_AGENT_PROMPT_TEMPLATE],
  ]) {
    assert.ok(
      template.includes(SENTINEL),
      `${name} must embed the exact sentinel token "${SENTINEL}"`,
    );
    assert.match(
      template,
      /own line|last line/i,
      `${name} must instruct the model to put the sentinel on its own / as the last line`,
    );
    // The model must be told the sentinel is OPTIONAL so absence
    // doesn't accidentally produce an INVALID verdict.
    assert.match(
      template,
      /OPTIONAL|absence/i,
      `${name} must declare the sentinel as OPTIONAL (absence accepted)`,
    );
  }

  // The validator template MUST NOT mention the sentinel - the
  // validator replies with VALID / INVALID, not review Markdown.
  assert.ok(
    !VALIDATOR_AGENT_PROMPT_TEMPLATE.includes(SENTINEL),
    'VALIDATOR_AGENT_PROMPT_TEMPLATE must NOT mention the sentinel',
  );
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
