'use strict';

/**
 * Tests for `parseValidatorResponse`, the helper that turns a raw
 * validator LLM response into a `{ status, reason }` pair.
 *
 * Background: the validator prompt instructs the model to reply with
 * exactly one line (`VALID` or `INVALID <reason>`). In practice the
 * model sometimes emits a `<think>...</think>` chain-of-thought block
 * before the verdict. The parser must tolerate that warmup and still
 * accept the first non-empty content line.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseValidatorResponse } = require('../dist-test/index.cjs');

test('parseValidatorResponse accepts a plain VALID verdict (regression check)', () => {
  const result = parseValidatorResponse('VALID');
  assert.deepEqual(result, { status: 'valid', reason: '' });
});

test('parseValidatorResponse strips a leading <think> block and accepts VALID', () => {
  const text = '<think>The user asked me to validate a review. Let me check the structure.\n\nIt looks good.\n</think>\nVALID';
  const result = parseValidatorResponse(text);
  assert.deepEqual(result, { status: 'valid', reason: '' });
});

test('parseValidatorResponse strips a leading <think> block and accepts INVALID with reason', () => {
  const text = '<think>Reviewing...\n\nThe summary is missing.\n</think>\nINVALID missing summary';
  const result = parseValidatorResponse(text);
  assert.deepEqual(result, { status: 'invalid', reason: 'missing summary' });
});

test('parseValidatorResponse handles INVALID without a reason', () => {
  const text = 'INVALID';
  const result = parseValidatorResponse(text);
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'unspecified');
});

test('parseValidatorResponse flags garbage that does not start with VALID or INVALID', () => {
  const result = parseValidatorResponse('I am not sure what you mean.');
  assert.equal(result.status, 'invalid');
  assert.ok(result.reason.startsWith('validator response did not start with VALID or INVALID'));
});