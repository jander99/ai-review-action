'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  sanitizeModelText,
  extractReviewDocument,
  validateReviewDocument,
  mergeReviewDocuments,
  MAX_CHARS,
  renderDocument,
  REVIEW_AGENT_PROMPT_TEMPLATE,
  SYNTHESIS_AGENT_PROMPT_TEMPLATE,
  VALIDATOR_AGENT_PROMPT_TEMPLATE,
  CANONICAL_FIELD_ORDER_TEXT,
} = require('../dist/index.cjs');

const TITLE = 'My Pull Request';

const CLEAN_DOCUMENT = [
  `# Review — ${TITLE}`,
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

test('sanitizeModelText strips orphan tags', () => {
  const raw = 'response preamble <think>internal</think> body <!--comment--> tail';
  const sanitized = sanitizeModelText(raw);
  assert.equal(sanitized, 'response preamble internal body comment tail');
});

test('missing Status field is invalid', () => {
  const doc = [
    `# Review — ${TITLE}`,
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
  const doc = `# Review — ${TITLE}\n\n## Summary\n\n- New findings: 0\n- Unresolved from prior review: 0\n- Resolved by latest commits: 0\n${big}`;
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
