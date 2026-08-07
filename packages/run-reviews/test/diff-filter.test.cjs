'use strict';

/**
 * Tests for `computeReviewDiff` and the `REVIEW_DIFF_*` constants
 * that drive the path-spec exclude filter applied to the diff
 * embedded in the reviewer prompt.
 *
 * Strategy: each test sets up a throw-away git repository under
 * `os.tmpdir()` with a few commits, calls `computeReviewDiff` with
 * the event context for a `pull_request` (or other) shape, and
 * asserts on the resulting diff text. The temp repository is cleaned
 * up regardless of test outcome.
 *
 * These tests intentionally do NOT mock `spawnSync`: the filter
 * itself lives inside `git diff -- <pathspecs>`, so any mock would
 * defeat the purpose of testing what the runtime actually passes to
 * git. Each test uses a small, fast repo so the suite stays cheap.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const bundle = require('../dist-test/index.cjs');
const {
  computeReviewDiff,
  REVIEW_DIFF_EXCLUDE_PATHSPECS,
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_DIFF_EMPTY_PLACEHOLDER,
} = bundle;

function runGit(cwd, args, opts = {}) {
  return childProcess.spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    ...opts,
  });
}

/**
 * Build a minimal two-commit git repo under `os.tmpdir()` so we can
 * test the diff filter against a realistic working directory without
 * polluting the repo under test.
 *
 * Layout:
 *   - commit A (base): README.md + src/foo.ts + dist/main.cjs + packages/x/dist/bundle.js
 *   - commit B (head): README.md + src/foo.ts (changed) + dist/main.cjs (changed) + packages/x/dist/bundle.js (changed)
 */
function buildFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-diff-fixture-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages', 'x', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });

  // Initial commit A.
  fs.writeFileSync(path.join(repo, 'README.md'), 'first\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'foo.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'dist', 'main.cjs'), '// generated bundle A\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'packages', 'x', 'dist', 'bundle.js'), '// gen A\n', 'utf8');

  runGit(repo, ['init', '-q', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test']);
  runGit(repo, ['add', '.']);
  const baseResult = runGit(repo, ['commit', '-q', '-m', 'base']);
  if (baseResult.status !== 0) {
    throw new Error(`git commit (base) failed: ${baseResult.stderr}`);
  }
  const baseSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

  // Mutating commit B.
  fs.writeFileSync(path.join(repo, 'README.md'), 'second\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'foo.ts'), 'export const a = 2;\nexport const b = 3;\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'dist', 'main.cjs'), '// generated bundle B (big diff)\n'.repeat(50), 'utf8');
  fs.writeFileSync(path.join(repo, 'packages', 'x', 'dist', 'bundle.js'), '// gen B\n'.repeat(20), 'utf8');
  runGit(repo, ['add', '.']);
  const headResult = runGit(repo, ['commit', '-q', '-m', 'head']);
  if (headResult.status !== 0) {
    throw new Error(`git commit (head) failed: ${headResult.stderr}`);
  }
  const headSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

  return { repo, baseSha, headSha };
}

function rmFixture(repo) {
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

test('REVIEW_DIFF_EXCLUDE_PATHSPECS covers the dist layouts that ship in this repo', () => {
  // Bound the regression where a new dist layout would slip past the
  // filter and dump auto-generated JS into the reviewer prompt.
  assert.deepEqual(
    REVIEW_DIFF_EXCLUDE_PATHSPECS,
    [':(exclude)dist/**', ':(exclude)packages/*/dist*/**'],
    'filter must cover the root dist bundle and every per-package dist directory',
  );
});

test('REVIEW_DIFF_MAX_BYTES is a positive integer cap', () => {
  assert.ok(Number.isInteger(REVIEW_DIFF_MAX_BYTES) && REVIEW_DIFF_MAX_BYTES > 0);
  assert.equal(REVIEW_DIFF_MAX_BYTES, 200_000, 'cap is pinned at 200 KB for predictable token use');
});

test('REVIEW_DIFF_EMPTY_PLACEHOLDER mentions dist/** so the model still has context', () => {
  assert.match(REVIEW_DIFF_EMPTY_PLACEHOLDER, /dist\/\*\*/);
  assert.ok(REVIEW_DIFF_EMPTY_PLACEHOLDER.length > 0);
});

test('computeReviewDiff filters out dist/** paths from a pull_request diff', () => {
  const { repo, baseSha, headSha } = buildFixtureRepo();
  try {
    const result = computeReviewDiff(
      { eventName: 'pull_request', baseSha, headSha },
      repo,
    );

    assert.notEqual(result, REVIEW_DIFF_EMPTY_PLACEHOLDER, 'diff must not be empty');
    assert.ok(result.includes('README.md'), 'source README change must be present');
    assert.ok(result.includes('src/foo.ts'), 'source change under src/ must be present');
    assert.ok(!result.includes('dist/main.cjs'), 'root dist bundle must be excluded');
    assert.ok(
      !result.includes('packages/x/dist/bundle.js'),
      'per-package dist bundle must be excluded',
    );
    assert.ok(!/\bbundle (A|B)\b/.test(result), 'generated dist content must not appear');
  } finally {
    rmFixture(repo);
  }
});

test('computeReviewDiff filters out packages/*/dist*/** paths', () => {
  const { repo, baseSha, headSha } = buildFixtureRepo();
  try {
    // Add a second per-package dist layout that the second glob
    // pattern must also catch. Both the package-dist layout and a
    // new dist-test layout (gitignored but still matched by the
    // glob) get changed, and neither may appear in the result.
    fs.mkdirSync(path.join(repo, 'packages', 'y', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'packages', 'y', 'dist-test'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'y', 'dist', 'other.js'), '// y gen\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'packages', 'y', 'dist-test', 'h.cjs'), '// y test gen\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src', 'bar.ts'), 'export const c = 1;\n', 'utf8');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'add per-package dist + dist-test']);
    const newHeadSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

    const result = computeReviewDiff(
      { eventName: 'pull_request', baseSha, headSha: newHeadSha },
      repo,
    );

    assert.ok(result.includes('src/bar.ts'), 'source change must be present');
    assert.ok(!result.includes('packages/y/dist/other.js'), 'packages/*/dist/** must be excluded');
    assert.ok(
      !result.includes('packages/y/dist-test/h.cjs'),
      'packages/*/dist*/** glob must also exclude dist-test',
    );
  } finally {
    rmFixture(repo);
  }
});

test('computeReviewDiff returns the placeholder when the filtered diff is empty', () => {
  const { repo, headSha } = buildFixtureRepo();
  try {
    // Make a commit that ONLY touches a dist file; the filter strips
    // it, so the result must be the placeholder. Use headSha as the
    // base so the diff range captures only this single dist-only
    // commit (the earlier buildFixtureRepo commits had source
    // changes that would otherwise sneak in).
    fs.writeFileSync(path.join(repo, 'dist', 'main.cjs'), '// regenerated AGAIN\n'.repeat(100), 'utf8');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'dist-only change']);
    const newHeadSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

    const result = computeReviewDiff(
      { eventName: 'pull_request', baseSha: headSha, headSha: newHeadSha },
      repo,
    );

    assert.equal(
      result,
      REVIEW_DIFF_EMPTY_PLACEHOLDER,
      'placeholder must surface when every changed path is in the exclude list',
    );
  } finally {
    rmFixture(repo);
  }
});

test('computeReviewDiff returns the placeholder when refs are missing', () => {
  const { repo } = buildFixtureRepo();
  try {
    // No baseSha/headSha for this pull_request event.
    const result = computeReviewDiff({ eventName: 'pull_request' }, repo);
    assert.equal(result, REVIEW_DIFF_EMPTY_PLACEHOLDER);

    // Same for push without before/after.
    const pushResult = computeReviewDiff({ eventName: 'push' }, repo);
    assert.equal(pushResult, REVIEW_DIFF_EMPTY_PLACEHOLDER);
  } finally {
    rmFixture(repo);
  }
});

test('computeReviewDiff returns the placeholder when the working dir is not a git repo', () => {
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-diff-nonrepo-'));
  try {
    const result = computeReviewDiff(
      { eventName: 'pull_request', baseSha: 'deadbeef', headSha: 'feedface' },
      nonRepo,
    );
    assert.equal(
      result,
      REVIEW_DIFF_EMPTY_PLACEHOLDER,
      'non-repo working dir must fall back to the placeholder, not throw',
    );
  } finally {
    rmFixture(nonRepo);
  }
});

test('computeReviewDiff handles a push event with before..after', () => {
  const { repo, baseSha, headSha } = buildFixtureRepo();
  try {
    const result = computeReviewDiff(
      { eventName: 'push', before: baseSha, after: headSha },
      repo,
    );

    assert.notEqual(result, REVIEW_DIFF_EMPTY_PLACEHOLDER);
    assert.ok(result.includes('src/foo.ts'));
    assert.ok(!result.includes('dist/main.cjs'));
  } finally {
    rmFixture(repo);
  }
});

test('computeReviewDiff truncates diffs larger than REVIEW_DIFF_MAX_BYTES and appends a marker', () => {
  // Build a controlled fixture whose diff is reliably larger than
  // REVIEW_DIFF_MAX_BYTES but stays below the runtime's spawnSync
  // maxBuffer cap so we exercise the truncation path (not the
  // ENOBUFS placeholder fallback). A ~280 KB file produces a diff
  // of roughly that size once git adds the `+` line prefixes and
  // file headers, which comfortably exceeds the 200 KB cap while
  // leaving headroom under the runtime's 2x maxBuffer allowance.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-diff-huge-'));
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf8');
    runGit(repo, ['init', '-q', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test']);
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    const baseSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

    // 80 columns per line, ~3500 lines = ~280 KB. The diff will be
    // a hair larger because of the `+` prefix and the diff header
    // for the file (a few hundred bytes), comfortably exceeding the
    // 200 KB cap without overflowing the 400 KB maxBuffer.
    const lineCount = Math.ceil(280_000 / 80);
    const huge = Array.from({ length: lineCount }, (_, i) => `line ${i.toString().padStart(8, '0')} ${'x'.repeat(55)}`).join('\n');
    fs.writeFileSync(path.join(repo, 'src', 'huge.ts'), `${huge}\n`, 'utf8');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'add huge file']);
    const headSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

    const result = computeReviewDiff(
      { eventName: 'pull_request', baseSha, headSha },
      repo,
    );

    assert.ok(result.length > REVIEW_DIFF_MAX_BYTES, 'truncated output must exceed the cap (cap + marker)');
    assert.ok(
      result.includes(`[diff truncated to ${REVIEW_DIFF_MAX_BYTES / 1000} KB]`),
      'truncation must append a marker so the model knows the section is incomplete',
    );
    // The marker is appended AFTER the cap-length prefix; the first
    // REVIEW_DIFF_MAX_BYTES of the result must be the unaltered
    // prefix of the original git output.
    assert.equal(
      result.slice(0, REVIEW_DIFF_MAX_BYTES),
      result.slice(0, REVIEW_DIFF_MAX_BYTES),
      'first REVIEW_DIFF_MAX_BYTES bytes of the truncated output must be a stable prefix',
    );
  } finally {
    rmFixture(repo);
  }
});