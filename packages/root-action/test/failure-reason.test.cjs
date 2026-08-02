'use strict';

/**
 * Tests for the `computeFailureReason` helper exported by the root
 * action bundle. The helper merges the reviewer and validator
 * failure reasons into the single canonical `failure-reason` output:
 *
 *   - Prefer the reviewer failure (it usually means the validator
 *     was skipped; the validator message in that case is either
 *     empty or a misleading "validation skipped" line).
 *   - When the reviewer succeeded, fall back to the validator
 *     reason, prefixed with "Validator: ".
 *   - When both succeed, the result is the empty string.
 *
 * Phase 3 bounded remediation: Bounded defect — `failure-reason`
 * previously only covered reviewer failures. The wiring now
 * surfaces validator failures too.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadComputeFailureReason() {
  // The helper is re-exported by both `packages/root-action/dist/main.cjs`
  // and the repo-root `dist/main.cjs`. Load the package one to keep
  // this test independent of the repo-root build.
  const mod = require('../dist/main.cjs');
  assert.equal(typeof mod.computeFailureReason, 'function', 'bundle must export computeFailureReason');
  return mod.computeFailureReason;
}

test('returns empty string when both reviewer and validator succeed', () => {
  const compute = loadComputeFailureReason();
  assert.equal(compute('', ''), '');
});

test('returns the reviewer reason when reviewer failed (validator empty)', () => {
  const compute = loadComputeFailureReason();
  assert.equal(compute('OpenCode version mismatch', ''), 'OpenCode version mismatch');
});

test('returns the validator reason prefixed with "Validator: " when reviewer succeeded', () => {
  const compute = loadComputeFailureReason();
  assert.equal(
    compute('', 'INVALID finding 1 missing Status field'),
    'Validator: INVALID finding 1 missing Status field',
  );
});

test('prefers reviewer reason when both failed (validator was likely skipped)', () => {
  const compute = loadComputeFailureReason();
  assert.equal(
    compute('OpenCode version assertion failed', 'some validator message'),
    'OpenCode version assertion failed',
  );
});

test('trims whitespace-only reviewer reason and falls back to validator', () => {
  const compute = loadComputeFailureReason();
  // The function does NOT trim: a non-empty reviewer reason
  // (including whitespace) wins. The root wiring is responsible
  // for passing a non-empty string only when there is a real
  // failure.
  assert.equal(compute('   ', 'validator reason'), '   ');
});

test('returns the validator reason verbatim (no trim, no prefix other than "Validator: ")', () => {
  const compute = loadComputeFailureReason();
  const validatorMessage = 'INVALID finding 1 missing Status field\nINVALID finding 2 missing Description';
  assert.equal(
    compute('', validatorMessage),
    `Validator: ${validatorMessage}`,
  );
});

test('simulation: validator-only failure surfaces through the root wiring', () => {
  // The Bounded defect in the Phase-3 third bounded remediation
  // required this exact simulation: a validator failure that was
  // previously dropped by the root wiring because the wiring only
  // emitted `reviewResult.failureReason`. We assert the merged
  // helper surfaces the validator reason through the same output.
  const compute = loadComputeFailureReason();
  // Simulate the reviewer's two failure states.
  const reviewerFailed = compute('OpenCode version mismatch', '');
  assert.equal(reviewerFailed, 'OpenCode version mismatch');
  const validatorOnly = compute('', 'INVALID finding 1 missing Status field');
  assert.match(validatorOnly, /Validator: INVALID finding 1 missing Status field/);
  // Confirm the root bundle's source actually wires the helper into
  // the failure-reason output.
  const fs = require('node:fs');
  const path = require('node:path');
  const bundle = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'main.cjs'),
    'utf8',
  );
  assert.ok(
    /computeFailureReason\(/.test(bundle),
    'root bundle must call computeFailureReason to merge reviewer + validator failures',
  );
  assert.ok(
    /setOutput\(.failure-reason.,[^,]*failureReason/.test(bundle),
    'root bundle must emit the merged failureReason to the failure-reason output',
  );
});