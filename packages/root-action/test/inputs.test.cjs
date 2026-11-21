'use strict';

/**
 * Phase 3 architecture tests for the root action.
 *
 * Verifies:
 *   1. The action.yml declares every input/output the previous
 *      composite exposed (parity).
 *   2. The action.yml declares `using: node24` and `main: dist/main.cjs`
 *      so it works under remote invocation as a JS action.
 *   3. The bundled main.cjs requires successfully and includes the
 *      wired-in package APIs (runReviews, validateReview, postComment,
 *      postCheckRun, postErrorComment) as identifiers in its source.
 *   4. The bundle is portable: requiring it from a different cwd
 *      does not throw.
 *   5. Block 1 of the Phase-3 bounded remediation: the bundle must
 *      contain exactly one `require.main === module` guard (its own),
 *      and importing it must NOT trigger leaf wrapper side effects
 *      (no `core.setOutput` / `core.setFailed` calls during require).
 *   6. Block 7 of the Phase-3 bounded remediation: the bundle must
 *      export the wired package APIs as module exports.
 *   7. The programmatic APIs (runReviews/validateReview/postComment/
 *      postCheckRun/postErrorComment) must be self-contained: every
 *      required input flows through the options argument. The root
 *      action is responsible for translating `core.getInput` into
 *      options; the API never touches `core` internally.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ACTION_YML = fs.readFileSync(
  path.join(__dirname, '..', 'action.yml'),
  'utf8',
);
const BUNDLE = fs.readFileSync(
  path.join(__dirname, '..', 'dist', 'main.cjs'),
  'utf8',
);

const REQUIRED_INPUTS = [
  'github-token',
  'prompts',
  'llm-provider',
  'llm-base-url',
  'llm-model',
  'llm-api-key',
  'decision-provider',
  'decision-base-url',
  'decision-model',
  'decision-api-key',
  'keep-threshold',
  'drop-threshold',
  'severity-threshold',
  'review-event',
  'post-comment',
  'post-check-run',
  'max-comment-chars',
  'check-name',
  'check-conclusion',
  'check-details-url',
];

const REQUIRED_OUTPUTS = [
  'review',
  'triage',
  'comment-url',
  'check-run-url',
  'review-output-path',
  'findings-kept',
  'findings-uncertain',
  'findings-dropped',
  'tokens',
  'failure-reason',
];

const WIRED_APIS = ['runReviews', 'postReview', 'postCheckRun', 'postErrorComment'];

test('action.yml declares using: node24', () => {
  assert.ok(
    /using: ['"]?node24['"]?/.test(ACTION_YML),
    'root action must declare using: node24 so it runs as a JS action',
  );
});

test('action.yml declares main: dist/main.cjs', () => {
  assert.ok(
    /main: ['"]?dist\/main\.cjs['"]?/.test(ACTION_YML),
    'root action must point at dist/main.cjs so the bundled code is the action entrypoint',
  );
});

test('action.yml declares every required input', () => {
  for (const name of REQUIRED_INPUTS) {
    assert.ok(
      new RegExp(`\\b${name}:`).test(ACTION_YML),
      `action.yml must declare input: ${name}`,
    );
  }
});

test('action.yml declares every required output', () => {
  for (const name of REQUIRED_OUTPUTS) {
    assert.ok(
      new RegExp(`\\b${name}:`).test(ACTION_YML),
      `action.yml must declare output: ${name}`,
    );
  }
});

test('action.yml declares the single canonical failure-reason output (not review-failure-reason)', () => {
  // Fix 4 of the Phase-3 bounded remediation: collapse
  // `review-failure-reason` into `failure-reason` so consumers only
  // watch one name.
  assert.ok(
    /\bfailure-reason:/.test(ACTION_YML),
    'action.yml must declare the failure-reason output',
  );
  assert.ok(
    !/\breview-failure-reason:/.test(ACTION_YML),
    'action.yml must NOT declare the legacy review-failure-reason output',
  );
});

test('action.yml is NOT a composite action (no `using: composite`)', () => {
  assert.ok(
    !/using: ['"]?composite['"]?/.test(ACTION_YML),
    'root action must NOT be a composite; composite `uses: ./packages/foo` paths break under remote invocation',
  );
});

test('bundle includes references to every wired-in package API', () => {
  for (const name of WIRED_APIS) {
    assert.ok(
      BUNDLE.includes(name),
      `bundle must reference ${name} (the bundled action wires this API)`,
    );
  }
});

test('bundle contains exactly one require.main === module guard', () => {
  // Block 1 of the Phase-3 bounded remediation: the root bundle has
  // exactly one guard (its own action IIFE). The leaf wrappers must
  // NOT have been bundled in with their own guards - esbuild would
  // otherwise emit one guard per leaf.
  const matches = BUNDLE.match(/require\.main === module/g) ?? [];
  assert.equal(matches.length, 1, `expected exactly 1 guard, got ${matches.length}`);
});

test('require() on the root bundle triggers NO @actions/core calls', () => {
  // Block 1 of the Phase-3 bounded remediation: importing the root
  // bundle as a library must NOT trigger the leaf wrapper IIFEs.
  // @actions/core is inlined into the bundle, so it cannot be spied on
  // through the module cache (and v3 is ESM-only, so it cannot be
  // required here at all). Instead we observe its effects: setOutput,
  // setFailed and warning all write `::command::` lines to stdout, and
  // setFailed sets process.exitCode. Requiring the bundle must produce
  // neither.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-root-action-no-side-effects-'));
  try {
    fs.copyFileSync(
      path.join(__dirname, '..', 'dist', 'main.cjs'),
      path.join(scratch, 'main.cjs'),
    );
    const recorded = [];
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = function (chunk, ...rest) {
      const text = String(chunk);
      if (/^::|^##\[/m.test(text)) recorded.push(text.trim());
      return originalWrite.call(process.stdout, chunk, ...rest);
    };
    try {
      // Force a fresh require so the bundle's top level re-executes.
      delete require.cache[path.join(scratch, 'main.cjs')];
      const originalCwd = process.cwd();
      process.chdir(scratch);
      try {
        require(path.join(scratch, 'main.cjs'));
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      process.stdout.write = originalWrite;
    }
    const exitCodeChanged = process.exitCode !== originalExitCode;
    process.exitCode = originalExitCode;
    assert.deepEqual(
      recorded,
      [],
      `requiring the root bundle must NOT trigger any @actions/core calls; got: ${JSON.stringify(recorded)}`,
    );
    assert.equal(exitCodeChanged, false, 'requiring the root bundle must not set process.exitCode');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('bundle module.exports expose the wired APIs', () => {
  // Fix 7 of the Phase-3 bounded remediation: the root bundle
  // exposes runReviews, validateReview, postComment, postCheckRun,
  // and postErrorComment as module exports so consumers can call
  // them directly.
  const exports = require('../dist/main.cjs');
  for (const name of WIRED_APIS) {
    assert.ok(
      typeof exports[name] === 'function',
      `bundle must export ${name} as a function (got ${typeof exports[name]})`,
    );
  }
});

test('bundle loads successfully from a fresh directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-root-action-'));
  try {
    fs.copyFileSync(
      path.join(__dirname, '..', 'dist', 'main.cjs'),
      path.join(scratch, 'main.cjs'),
    );
    const Module = require('node:module');
    const originalResolveLookupPaths = Module._resolveLookupPaths;
    delete require.cache[path.join(scratch, 'main.cjs')];
    const originalCwd = process.cwd();
    process.chdir(scratch);
    try {
      assert.doesNotThrow(() => {
        require(path.join(scratch, 'main.cjs'));
      }, 'bundle must load without throwing when required from a fresh directory');
    } finally {
      process.chdir(originalCwd);
      Module._resolveLookupPaths = originalResolveLookupPaths;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
test('neither bundle carries the removed harness runtimes', () => {
  // v2 removed the OpenCode and Claude Code runtimes, the validator, and
  // the plain-comment poster. Their identifiers must not survive in
  // either shipped bundle.
  const forbidden = ['opencode', '--allowedTools'];
  const forbiddenIdentifiers = ['validateReview'];
  const bundles = {
    'root-action/dist/main.cjs': BUNDLE,
    'dist/main.cjs': fs.readFileSync(path.join(__dirname, '..', '..', '..', 'dist', 'main.cjs'), 'utf8'),
  };
  for (const [label, source] of Object.entries(bundles)) {
    for (const name of forbidden) {
      assert.ok(
        !source.includes(name),
        `${label} must not reference ${name} (removed in v2)`,
      );
    }
    for (const name of forbiddenIdentifiers) {
      // Whole-identifier match: `validateReviewDocument` is still exported.
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(source),
        `${label} must not reference ${name} (removed in v2)`,
      );
    }
  }
});
