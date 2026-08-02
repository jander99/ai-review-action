'use strict';

/**
 * Tests for the rejected-document preview helper that lives on the
 * pure run-reviews API surface.
 *
 * The helper powers the diagnostics surfaced on
 * `RunReviewsResult.rejectedDocuments`: when the deterministic
 * contract validator rejects a model response, the orchestration
 * layer emits one `core.warning` per entry carrying the model name,
 * the validation reason, and a sanitized, line-bounded preview of
 * the offending document.
 *
 * These tests verify the pure helper end-to-end via the
 * `dist-test/index.cjs` bundle so they stay independent of the
 * `@actions/core` I/O the root action adds.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRejectedDocumentPreview,
  REJECTED_DOCUMENT_CAP,
  REJECTED_DOCUMENT_PREVIEW_MAX_CHARS,
} = require('../dist-test/index.cjs');

const MAX_CHARS = REJECTED_DOCUMENT_PREVIEW_MAX_CHARS;

test('buildRejectedDocumentPreview returns the input verbatim when shorter than the cap', () => {
  const text = 'Short preamble that fits in the preview budget.\n';
  assert.equal(buildRejectedDocumentPreview(text, MAX_CHARS), text);
});

test('buildRejectedDocumentPreview strips orphan tags before truncating', () => {
  const text =
    '<think>internal reasoning</think>' +
    '<tool_call>foo</tool_call>' +
    '<!--comment-->' +
    'real content that should remain after sanitization';
  const result = buildRejectedDocumentPreview(text, MAX_CHARS);
  assert.ok(!result.includes('<think>'), 'think tag must be stripped');
  assert.ok(!result.includes('<tool_call>'), 'tool_call tag must be stripped');
  assert.ok(!result.includes('<!--'), 'comment tag must be stripped');
  assert.ok(result.includes('real content'), 'non-orphan content must survive');
});

test('buildRejectedDocumentPreview truncates at a line boundary when possible', () => {
  // Build a string that exceeds the cap and has a newline near the
  // end of the cap window so the helper should break on it.
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(`line ${i.toString().padStart(3, '0')} ${'x'.repeat(10)}`);
  }
  const text = lines.join('\n');
  const preview = buildRejectedDocumentPreview(text, MAX_CHARS);
  assert.ok(preview.length <= MAX_CHARS, `preview must be <= ${MAX_CHARS} chars (got ${preview.length})`);
  // The preview must end on a line boundary so the last content
  // line is intact, not chopped mid-token.
  assert.ok(
    /^line \d{3} x{10}$/.test(preview.split('\n').pop()),
    'preview must end on a complete line, not chop a line mid-token',
  );
  // The preview must be strictly shorter than the original
  // because the cap truncated it.
  assert.ok(preview.length < text.length, 'preview must be shorter than the original');
});

test('buildRejectedDocumentPreview hard-truncates when no newline fits in the cap', () => {
  // A single huge line with no newlines anywhere.
  const text = 'y'.repeat(MAX_CHARS * 2);
  const preview = buildRejectedDocumentPreview(text, MAX_CHARS);
  assert.equal(preview.length, MAX_CHARS, `preview must equal the cap when no newline exists (got ${preview.length})`);
  assert.equal(preview, 'y'.repeat(MAX_CHARS), 'preview must be the first maxChars chars verbatim');
});

test('buildRejectedDocumentPreview honors an explicit smaller cap', () => {
  const text = 'a'.repeat(500);
  const preview = buildRejectedDocumentPreview(text, 100);
  assert.ok(preview.length <= 100, `preview must respect explicit cap (got ${preview.length})`);
});

test('REJECTED_DOCUMENT_CAP is 3 (diagnostics bound)', () => {
  assert.equal(REJECTED_DOCUMENT_CAP, 3, 'orchestration assumes a cap of 3 entries');
});