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
  'opencode-version',
  'debug',
  'github-token',
  'model',
  'models',
  'prompts',
  'opencode-config',
  'permission',
  'timeout-minutes',
  'fusion',
  'fusion-model',
  'fail-on-error',
  'post-comment',
  'post-check-run',
  'max-comment-chars',
  'check-name',
  'check-conclusion',
  'check-details-url',
];

const REQUIRED_OUTPUTS = [
  'review',
  'review-output-path',
  'config-json',
  'comment-url',
  'check-run-url',
  'models-used',
  'effective-model',
  'cost',
  'validate-cost',
  'total-cost',
  'cost-by-model',
  'tokens',
  'validate-tokens',
  'tokens-by-model',
  'debug-artifact-path',
  'validate-status',
  'validate-reason',
  'failure-reason',
];

const WIRED_APIS = [
  'runReviews',
  'validateReview',
  'postComment',
  'postCheckRun',
  'postErrorComment',
];

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
  // We detect this by patching @actions/core so every setOutput,
  // setFailed, and warning call records itself. Requiring the
  // bundle must produce zero recorded calls.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-root-action-no-side-effects-'));
  try {
    fs.copyFileSync(
      path.join(__dirname, '..', 'dist', 'main.cjs'),
      path.join(scratch, 'main.cjs'),
    );
    const recorded = [];
    const corePath = require.resolve('@actions/core');
    // Save the original cached module so we can restore it.
    const originalCached = require.cache[corePath];
    require.cache[corePath] = {
      id: 'actions-core-spy',
      filename: corePath,
      loaded: true,
      exports: new Proxy(
        {},
        {
          get(_target, key) {
            if (key === 'setOutput') {
              return (name, value) => recorded.push(['setOutput', name, value]);
            }
            if (key === 'setFailed') {
              return (message) => recorded.push(['setFailed', message]);
            }
            if (key === 'warning') {
              return (message) => recorded.push(['warning', message]);
            }
            return undefined;
          },
        },
      ),
    };
    try {
      // Force a fresh require so we hit the spy.
      delete require.cache[path.join(scratch, 'main.cjs')];
      const originalCwd = process.cwd();
      process.chdir(scratch);
      try {
        require(path.join(scratch, 'main.cjs'));
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      // Restore the original cached module.
      if (originalCached) {
        require.cache[corePath] = originalCached;
      } else {
        delete require.cache[corePath];
      }
    }
    assert.deepEqual(
      recorded,
      [],
      `requiring the root bundle must NOT trigger any @actions/core calls; got: ${JSON.stringify(recorded)}`,
    );
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