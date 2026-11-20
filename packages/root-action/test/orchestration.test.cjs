'use strict';

/**
 * Orchestration tests for the root action's `runWithDeps`.
 *
 * The orchestration lives in `packages/root-action/src/orchestrate.ts` and is
 * bundled into `dist/main.cjs`. `runDeps` is exported as a mutable object so
 * individual methods can be stubbed with `mock.method` without re-requiring
 * the bundle, and `GITHUB_OUTPUT` is pointed at a temp file so `core.setOutput`
 * calls can be inspected.
 */

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BUNDLE_PATH = path.join(__dirname, '..', 'dist', 'main.cjs');
const REPO = 'owner/repo';
const PR_NUMBER = 42;

const SAVED_ENV = { ...process.env };
const SAVED_EXIT_CODE = process.exitCode;

let scratchDir = null;
let outputPath = null;

function setUp() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, SAVED_ENV);
  process.exitCode = 0;

  // @actions/core maps input names by uppercasing and replacing only SPACES
  // with underscores — hyphens are kept — so 'llm-provider' reads
  // INPUT_LLM-PROVIDER and 'github-token' reads INPUT_GITHUB-TOKEN.
  process.env['INPUT_PROMPTS'] = 'text:test prompt';
  process.env['INPUT_LLM-PROVIDER'] = 'openai';
  process.env['INPUT_LLM-MODEL'] = 'm';
  process.env['INPUT_LLM-API-KEY'] = 'llm-key';
  process.env['INPUT_DECISION-PROVIDER'] = 'google';
  process.env['INPUT_DECISION-MODEL'] = 'm';
  process.env['INPUT_DECISION-API-KEY'] = 'decision-key';
  process.env['INPUT_GITHUB-TOKEN'] = 'fake-token';

  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_REPOSITORY = REPO;
  process.env.GITHUB_SHA = 'abc123def456abc123def456abc123def456abcd';

  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-orch-'));
  outputPath = path.join(scratchDir, 'github-output');
  fs.writeFileSync(outputPath, '');
  process.env.GITHUB_OUTPUT = outputPath;
  const eventPath = path.join(scratchDir, 'event.json');
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
  process.exitCode = SAVED_EXIT_CODE;
}

afterEach(() => tearDown());

function loadBundle() {
  // Clear the cache so the bundled @actions/github Context picks up the
  // GITHUB_EVENT_PATH / GITHUB_REPOSITORY set in setUp().
  delete require.cache[BUNDLE_PATH];
  return require(BUNDLE_PATH);
}

const EMPTY_COUNTS = { kept: 0, uncertain: 0, dropped: 0, duplicates: 0, unjudged: 0 };
const EMPTY_USAGE = { llmInputTokens: 0, llmOutputTokens: 0, decisionInputTokens: 0 };

function reviewResult(overrides = {}) {
  return {
    status: 'ok',
    review: '# Review — Test PR\n\n## Summary\n- ok\n',
    reviewOutputPath: '',
    triage: '',
    kept: [],
    uncertain: [],
    counts: EMPTY_COUNTS,
    usage: EMPTY_USAGE,
    diff: 'diff --git a/a.ts b/a.ts\n',
    headSha: '',
    failureReason: '',
    ...overrides,
  };
}

test('failed -> postErrorComment called once and process.exitCode is 1', async () => {
  setUp();
  const bundle = loadBundle();
  const errorCommentCalls = [];
  mock.method(bundle.runDeps, 'runReviews', async () =>
    reviewResult({ status: 'failed', review: '', failureReason: 'provider exploded' }),
  );
  mock.method(bundle.runDeps, 'postErrorComment', async (opts, ctx) => {
    errorCommentCalls.push({ opts, ctx });
    return { commentUrl: 'http://example.test/comment' };
  });
  const checks = [];
  mock.method(bundle.runDeps, 'postCheckRun', async (opts) => {
    checks.push(opts);
    return { checkRunUrl: '' };
  });
  mock.method(bundle.runDeps, 'postReview', async () => {
    throw new Error('postReview must NOT be called on the error path');
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(errorCommentCalls.length, 1);
  assert.equal(checks.length, 0, 'postCheckRun must NOT be called on PR events');
  assert.match(errorCommentCalls[0].opts.reason, /provider exploded/);
  assert.equal(errorCommentCalls[0].ctx.owner, 'owner');
  assert.equal(errorCommentCalls[0].ctx.repo, 'repo');
  assert.equal(errorCommentCalls[0].ctx.issueNumber, PR_NUMBER);
  assert.equal(process.exitCode, 1);
});

test('ok on a PR -> postReview is called with event COMMENT and findings === kept', async () => {
  setUp();
  const bundle = loadBundle();
  const kept = [
    {
      finding: {
        id: 'F1',
        file: 'a.ts',
        relatedFiles: [],
        startLine: 1,
        endLine: 1,
        title: 't',
        claim: 'c',
        evidence: 'a.ts:1',
        suggestedFix: null,
      },
      severity: 'Warning',
      judgeSeverity: 'major',
      pSupported: 0.9,
      note: '',
    },
  ];
  const reviewCalls = [];
  mock.method(bundle.runDeps, 'runReviews', async () => reviewResult({ kept, counts: { ...EMPTY_COUNTS, kept: 1 } }));
  mock.method(bundle.runDeps, 'postReview', async (opts) => {
    reviewCalls.push(opts);
    return { reviewUrl: 'http://example.test/review', inlineCount: 1, bodyOnlyCount: 0 };
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0].event, 'COMMENT');
  assert.deepEqual(reviewCalls[0].findings, kept);
});

test('llm-provider: nope -> postErrorComment reason matches /llm-provider must be one of/', async () => {
  setUp();
  process.env['INPUT_LLM-PROVIDER'] = 'nope';
  const bundle = loadBundle();
  const reasons = [];
  mock.method(bundle.runDeps, 'runReviews', async () => {
    throw new Error('runReviews must NOT be called when inputs are invalid');
  });
  mock.method(bundle.runDeps, 'postErrorComment', async (opts) => {
    reasons.push(opts.reason);
    return { commentUrl: '' };
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /llm-provider must be one of/);
});

test('keep-threshold: 2 -> postErrorComment reason matches /keep-threshold must be between 0 and 1/', async () => {
  setUp();
  process.env['INPUT_KEEP-THRESHOLD'] = '2';
  const bundle = loadBundle();
  const reasons = [];
  mock.method(bundle.runDeps, 'runReviews', async () => {
    throw new Error('runReviews must NOT be called when inputs are invalid');
  });
  mock.method(bundle.runDeps, 'postErrorComment', async (opts) => {
    reasons.push(opts.reason);
    return { commentUrl: '' };
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /keep-threshold must be between 0 and 1/);
});

test('non-PR event + ok -> postCheckRun with check-conclusion', async () => {
  setUp();
  process.env.GITHUB_EVENT_NAME = 'push';
  process.env['INPUT_CHECK-CONCLUSION'] = 'success';
  const bundle = loadBundle();
  const checks = [];
  mock.method(bundle.runDeps, 'runReviews', async () => reviewResult());
  mock.method(bundle.runDeps, 'postCheckRun', async (opts) => {
    checks.push(opts);
    return { checkRunUrl: 'http://example.test/check' };
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'success');
});

test('no_findings_produced on a non-PR event -> neutral check conclusion', async () => {
  setUp();
  process.env.GITHUB_EVENT_NAME = 'push';
  process.env['INPUT_CHECK-CONCLUSION'] = 'success';
  const bundle = loadBundle();
  const checks = [];
  mock.method(bundle.runDeps, 'runReviews', async () => reviewResult({ status: 'no_findings_produced' }));
  mock.method(bundle.runDeps, 'postCheckRun', async (opts) => {
    checks.push(opts);
    return { checkRunUrl: '' };
  });

  await bundle.runWithDeps(bundle.runDeps);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'neutral');
});

test('missing github-token -> warning is emitted and no review is published', async () => {
  setUp();
  delete process.env['INPUT_GITHUB-TOKEN'];
  delete process.env.GITHUB_TOKEN;
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    const bundle = loadBundle();
    mock.method(bundle.runDeps, 'runReviews', async () => reviewResult());
    mock.method(bundle.runDeps, 'postReview', async () => {
      throw new Error('postReview must NOT be called without a token');
    });
    await bundle.runWithDeps(bundle.runDeps);
    assert.match(captured.join(''), /github-token is not available/);
  } finally {
    process.stdout.write = originalWrite;
  }
});
