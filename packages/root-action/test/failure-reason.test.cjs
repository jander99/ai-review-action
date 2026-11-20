'use strict';

/**
 * Tests for the canonical `failure-reason` output.
 *
 * The decision-review pipeline has a single failure channel: the pipeline
 * result's `failureReason` (it fails closed, so every stage that can fail
 * reports a reason instead of throwing). The action writes that one value to
 * `failure-reason`; there is no separate validator reason to merge, and no
 * `validate-*` output family anymore.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main.cjs'), 'utf8');

test('bundle emits the pipeline failureReason to the failure-reason output', () => {
  assert.match(
    BUNDLE,
    /setOutput\(["']failure-reason["'], result\.failureReason\)/,
    'root bundle must emit result.failureReason to the failure-reason output',
  );
});

test('bundle has no validator output family', () => {
  for (const legacy of ['validate-reason', 'validate-status', 'validate-cost', 'validate-tokens']) {
    assert.ok(!BUNDLE.includes(legacy), `bundle must NOT emit ${legacy}`);
  }
});

test('bundle has no legacy review-failure-reason output', () => {
  assert.ok(!BUNDLE.includes('review-failure-reason'));
});
