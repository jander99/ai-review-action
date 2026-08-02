'use strict';

/**
 * Orchestration tests for packages/root-action/src/main.ts.
 *
 * Verifies the Phase-4 bounded fix: every failure path (reviewer
 * throw, reviewer failed, validator throw, validator invalid, all
 * invalid) routes through `publishError` so an error comment is
 * posted on PR events. Previously the reviewer-throw path bypassed
 * the publication helper entirely - the throw escaped `run()` and
 * only `core.setFailed` ran, leaving the PR with a red step but no
 * error comment.
 *
 * Test strategy:
 *
 *   - `runDeps` is exported as a mutable object so individual methods
 *     can be stubbed via `mock.method` from `node:test` without
 *     re-requiring the bundle.
 *   - The bundled `@actions/core` is left in place; we point
 *     `GITHUB_OUTPUT` at a temp file so `core.setOutput` writes the
 *     `comment-url` line into a file we can inspect.
 *   - The bundled `@actions/github` `Context` reads from
 *     `GITHUB_REPOSITORY` and `GITHUB_EVENT_PATH`; we set both so
 *     `context.repo.owner/repo` and `context.issue.number` resolve.
 */

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BUNDLE_PATH = path.join(__dirname, '..', 'dist', 'main.cjs');
const REPO = 'owner/repo';
const PR_NUMBER = 42;

// Snapshot of process.env and process.exitCode so each test can
// mutate INPUT_* / GITHUB_* without leaking into sibling tests.
const SAVED_ENV = { ...process.env };
const SAVED_EXIT_CODE = process.exitCode;

let scratchDir = null;
let outputPath = null;
let eventPath = null;

function setUp() {
  // Restore env to the snapshot, then layer on test-specific values.
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    process.env[key] = value;
  }
  // Reset exit code so a stray `setFailed` from a prior test does
  // not mark this test run red.
  process.exitCode = 0;

  // Required inputs.
  process.env.INPUT_PROMPTS = 'text:test prompt';
  process.env.INPUT_GITHUB_TOKEN = 'fake-token';
  // Event context for the bundled @actions/github Context.
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_REPOSITORY = REPO;
  process.env.GITHUB_SHA = 'abc123def456abc123def456abc123def456abcd';

  // PR number comes from the event payload; write a minimal one.
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-orch-'));
  outputPath = path.join(scratchDir, 'github-output');
  eventPath = path.join(scratchDir, 'event.json');
  // GITHUB_OUTPUT file must exist before `core.setOutput` is called.
  fs.writeFileSync(outputPath, '');
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_EVENT_PATH = eventPath;
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: { number: PR_NUMBER, title: 'Test PR' },
      repository: { full_name: REPO, owner: { login: 'owner' }, name: 'repo' },
    }),
  );
}

function tearDown() {
  mock.restoreAll();
  if (scratchDir && fs.existsSync(scratchDir)) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  scratchDir = null;
  outputPath = null;
  eventPath = null;
  process.exitCode = SAVED_EXIT_CODE;
}

afterEach(() => {
  tearDown();
});

function loadBundle() {
  // Clear from require.cache so the bundled @actions/github Context
  // picks up the GITHUB_EVENT_PATH / GITHUB_REPOSITORY we set in
  // setUp(). Context is constructed once at bundle load.
  delete require.cache[BUNDLE_PATH];
  return require(BUNDLE_PATH);
}

function emptyReviewResult(overrides = {}) {
  return {
    review: '',
    reviewOutputPath: '',
    modelsUsed: '',
    cost: 0,
    costByModel: {},
    tokens: { input: 0, output: 0 },
    tokensByModel: {},
    configJson: '{}',
    effectiveModel: 'anthropic/claude-sonnet-4.6',
    debugArtifactPath: '',
    failureReason: '',
    ...overrides,
  };
}

function readGithubOutput(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// -----------------------------------------------------------------------------
// Test 1: reviewer throw -> publishError -> postErrorComment called.
// -----------------------------------------------------------------------------

test('runReviews throws -> postErrorComment is called with the wrapped throw message', async () => {
  setUp();
  const bundle = loadBundle();

  const errorCommentCalls = [];
  const checkRunCalls = [];

  mock.method(bundle.runDeps, 'runReviews', async () => {
    throw new Error('synthetic reviewer boom');
  });
  mock.method(bundle.runDeps, 'validateReview', async () => {
    throw new Error('validateReview must NOT be called when reviewResult.review is empty');
  });
  mock.method(bundle.runDeps, 'postErrorComment', async (opts, ctx) => {
    errorCommentCalls.push({ opts, ctx });
    return { commentUrl: 'http://example.test/comment-throw' };
  });
  mock.method(bundle.runDeps, 'postCheckRun', async (opts) => {
    checkRunCalls.push(opts);
    return { checkRunUrl: '' };
  });
  mock.method(bundle.runDeps, 'postComment', async () => {
    throw new Error('postComment must NOT be called on the error path');
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(errorCommentCalls.length, 1, 'postErrorComment must be called when runReviews throws');
  assert.equal(checkRunCalls.length, 0, 'postCheckRun must NOT be called on PR events');
  assert.match(
    errorCommentCalls[0].opts.reason,
    /Review invocation threw: synthetic reviewer boom/,
    'error reason must wrap the thrown error message',
  );
  assert.equal(errorCommentCalls[0].ctx.owner, 'owner');
  assert.equal(errorCommentCalls[0].ctx.repo, 'repo');
  assert.equal(errorCommentCalls[0].ctx.issueNumber, PR_NUMBER);
  assert.equal(
    errorCommentCalls[0].opts.title,
    'AI Review validator rejected the generated review.',
    'postErrorComment must receive the canonical validator title',
  );
});

// -----------------------------------------------------------------------------
// Test 2: reviewer returned with failureReason + empty review -> error comment.
// -----------------------------------------------------------------------------

test('runReviews returns failureReason + empty review -> postErrorComment is called', async () => {
  setUp();
  const bundle = loadBundle();

  const errorCommentCalls = [];

  mock.method(bundle.runDeps, 'runReviews', async () =>
    emptyReviewResult({
      failureReason: 'all 1 review invocation(s) produced invalid documents',
    }),
  );
  mock.method(bundle.runDeps, 'validateReview', async () => {
    throw new Error('validateReview must NOT be called when reviewResult.review is empty');
  });
  mock.method(bundle.runDeps, 'postErrorComment', async (opts, ctx) => {
    errorCommentCalls.push({ opts, ctx });
    return { commentUrl: 'http://example.test/comment-returned' };
  });
  mock.method(bundle.runDeps, 'postCheckRun', async () => ({ checkRunUrl: '' }));
  mock.method(bundle.runDeps, 'postComment', async () => ({ commentUrl: '' }));

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(errorCommentCalls.length, 1, 'postErrorComment must be called when runFailed');
  assert.match(
    errorCommentCalls[0].opts.reason,
    /review failed before producing a document: all 1 review invocation\(s\) produced invalid documents/,
    'error reason must wrap the reviewer failure reason',
  );
  assert.equal(errorCommentCalls[0].ctx.issueNumber, PR_NUMBER);
});

// -----------------------------------------------------------------------------
// Test 3: runFailed path -> postErrorComment called AND comment-url output set.
// -----------------------------------------------------------------------------

test('runFailed path -> postErrorComment called and comment-url output is set on GITHUB_OUTPUT', async () => {
  setUp();
  const bundle = loadBundle();

  const COMMENT_URL = 'http://example.test/comment-runfailed';

  mock.method(bundle.runDeps, 'runReviews', async () =>
    emptyReviewResult({
      failureReason: 'OpenCode version assertion failed: mismatch',
    }),
  );
  mock.method(bundle.runDeps, 'validateReview', async () => {
    throw new Error('validateReview must NOT be called when review is empty');
  });
  mock.method(bundle.runDeps, 'postErrorComment', async (opts) => {
    // The reason sent to the PR comment must reflect the reviewer
    // failure (not the synthetic empty-validation path).
    assert.match(opts.reason, /OpenCode version assertion failed: mismatch/);
    return { commentUrl: COMMENT_URL };
  });
  mock.method(bundle.runDeps, 'postCheckRun', async () => ({ checkRunUrl: '' }));
  mock.method(bundle.runDeps, 'postComment', async () => ({ commentUrl: '' }));

  await bundle.runWithDeps(bundle.runDeps);

  // The bundled `core.setOutput('comment-url', result.commentUrl)`
  // must have written the returned URL into GITHUB_OUTPUT.
  assert.ok(fs.existsSync(outputPath), 'GITHUB_OUTPUT file must exist after runWithDeps');
  const output = readGithubOutput(outputPath);
  assert.match(
    output,
    new RegExp(`comment-url<<[^\\n]+\\n${COMMENT_URL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`),
    `GITHUB_OUTPUT must contain comment-url pointing at ${COMMENT_URL}; got: ${output}`,
  );
});

// -----------------------------------------------------------------------------
// Bonus: non-PR event -> publishError posts a failure check run, not a comment.
// -----------------------------------------------------------------------------

test('non-PR event + runFailed -> postCheckRun is called with conclusion "failure"', async () => {
  setUp();
  // Override the event for this scenario only.
  process.env.GITHUB_EVENT_NAME = 'push';

  const bundle = loadBundle();

  const errorCommentCalls = [];
  const checkRunCalls = [];

  mock.method(bundle.runDeps, 'runReviews', async () =>
    emptyReviewResult({
      failureReason: 'OpenCode version assertion failed: mismatch',
    }),
  );
  mock.method(bundle.runDeps, 'validateReview', async () => {
    throw new Error('validateReview must NOT be called when review is empty');
  });
  mock.method(bundle.runDeps, 'postErrorComment', async (opts, ctx) => {
    errorCommentCalls.push({ opts, ctx });
    return { commentUrl: '' };
  });
  mock.method(bundle.runDeps, 'postCheckRun', async (opts) => {
    checkRunCalls.push(opts);
    return { checkRunUrl: 'http://example.test/check-push' };
  });
  mock.method(bundle.runDeps, 'postComment', async () => ({ commentUrl: '' }));

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(errorCommentCalls.length, 0, 'postErrorComment must NOT be called on non-PR events');
  assert.equal(checkRunCalls.length, 1, 'postCheckRun must be called once with conclusion "failure"');
  assert.equal(checkRunCalls[0].conclusion, 'failure');
  assert.equal(checkRunCalls[0].name, 'ai-review');
  assert.match(checkRunCalls[0].review, /OpenCode version assertion failed: mismatch/);
});