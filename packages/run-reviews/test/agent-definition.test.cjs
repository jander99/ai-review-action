'use strict';

/**
 * Tests for `buildAgentDefinition`, focused on the `__DIFF__`
 * placeholder substitution that drives the reviewer-prompt diff
 * embedding. The action computes a pathspec-filtered diff upstream
 * (see diff-filter.test.cjs) and threads it through here as the
 * third substitution, alongside the pre-existing `__RUNTIME_CONTEXT__`
 * and `__PRIOR_REVIEWS__` slots.
 *
 * The agent definition shape is intentionally simple (one primary
 * agent keyed by `review`); the test exercises substitution only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const bundle = require('../dist-test/index.cjs');
const { buildAgentDefinition } = bundle;

const FIXTURE_EVENT_CONTEXT = {
  eventName: 'pull_request',
  repository: 'owner/repo',
  prNumber: 42,
  prTitle: 'Example PR',
  baseRef: 'main',
  headRef: 'feature/example',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  headSha: 'fedcba9876543210fedcba9876543210fedcba98',
  reviewOutputPath: '/tmp/ai-review/review-pr-fedcba98.md',
};

test('buildAgentDefinition substitutes __DIFF__ with the supplied reviewDiff', () => {
  const diffText = 'diff --git a/src/foo.ts b/src/foo.ts\n+export const a = 1;\n';
  const { review } = buildAgentDefinition({
    eventContext: FIXTURE_EVENT_CONTEXT,
    reviewDiff: diffText,
  });

  assert.equal(typeof review.prompt, 'string');
  assert.ok(
    review.prompt.includes(diffText),
    'reviewer prompt must contain the supplied diff verbatim',
  );
  assert.ok(
    !review.prompt.includes('__DIFF__'),
    '__DIFF__ placeholder must be fully substituted (no remaining literal)',
  );
});

test('buildAgentDefinition substitutes __RUNTIME_CONTEXT__ as a JSON object', () => {
  const { review } = buildAgentDefinition({
    eventContext: FIXTURE_EVENT_CONTEXT,
    reviewDiff: '(placeholder)',
  });

  assert.ok(
    !review.prompt.includes('__RUNTIME_CONTEXT__'),
    '__RUNTIME_CONTEXT__ placeholder must be fully substituted',
  );
  // The runtime context is JSON.stringify(contextForAgent, null, 2);
  // the most stable assertion is that the prTitle + prNumber from
  // the fixture appear in the rendered prompt.
  assert.ok(review.prompt.includes('Example PR'));
  assert.ok(review.prompt.includes('42'));
});

test('buildAgentDefinition substitutes __PRIOR_REVIEWS__ with the supplied block (or "none")', () => {
  const prior = 'first prior review';
  const { review: withPrior } = buildAgentDefinition({
    eventContext: FIXTURE_EVENT_CONTEXT,
    priorReviewsBlock: prior,
    reviewDiff: '(placeholder)',
  });
  assert.ok(withPrior.prompt.includes(prior));
  assert.ok(!withPrior.prompt.includes('__PRIOR_REVIEWS__'));

  const { review: withoutPrior } = buildAgentDefinition({
    eventContext: FIXTURE_EVENT_CONTEXT,
    reviewDiff: '(placeholder)',
  });
  assert.ok(withoutPrior.prompt.includes('none'));
  assert.ok(!withoutPrior.prompt.includes('__PRIOR_REVIEWS__'));
});

test('buildAgentDefinition renders an empty diff as the supplied string verbatim', () => {
  // The action always calls computeReviewDiff and gets back either
  // a real diff or the placeholder; either way the placeholder must
  // appear verbatim in the prompt so the model still emits a valid
  // `## Scope` line.
  const { review } = buildAgentDefinition({
    eventContext: FIXTURE_EVENT_CONTEXT,
    reviewDiff: '',
  });

  // An empty diff is still a valid substitution: the `__DIFF__`
  // token must be gone. The downstream prompt body around it is
  // unchanged (the surrounding header text "Diff for this change
  // (filtered..." still appears).
  assert.ok(!review.prompt.includes('__DIFF__'));
  assert.ok(review.prompt.includes('Diff for this change (filtered'));
});

test('buildAgentDefinition produces an agent keyed by `review` with mode=primary', () => {
  const { review } = buildAgentDefinition({
    eventContext: FIXTURE_EVENT_CONTEXT,
    reviewDiff: 'diff --git a b\n',
  });

  assert.equal(review.mode, 'primary');
  assert.match(
    review.description,
    /Reviews repository changes/,
    'description must mention the review purpose so OpenCode can label the agent',
  );
});