'use strict';

/**
 * Phase-3 third bounded remediation: Spec deviation — `setup-opencode`
 * is not a pure API module.
 *
 * Verifies:
 *   1. The leaf action bundle (`dist/main.cjs`) is built from
 *      `src/action.ts` and contains exactly one
 *      `require.main === module` guard (the wrapper).
 *   2. The pure API surface (`src/main.ts` + `dist-test/index.cjs`)
 *      does NOT import `@actions/core` and does NOT call any
 *      `core.*` function. Side effects belong in the action
 *      wrapper, not the API.
 *   3. `src/index.ts` re-exports the API from `src/main.ts`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE = fs.readFileSync(
  path.join(__dirname, '..', 'dist', 'main.cjs'),
  'utf8',
);
const API_BUNDLE = fs.readFileSync(
  path.join(__dirname, '..', 'dist-test', 'index.cjs'),
  'utf8',
);
const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main.ts'),
  'utf8',
);
const INDEX_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'index.ts'),
  'utf8',
);

test('the leaf action bundle (dist/main.cjs) contains exactly one require.main === module guard', () => {
  const matches = BUNDLE.match(/require\.main === module/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected exactly 1 guard in the action bundle, got ${matches.length}`,
  );
});

test('the pure API source (src/main.ts) does NOT import @actions/core', () => {
  // The pure API surface must not import @actions/core - that
  // dependency is reserved for the action wrapper.
  assert.ok(
    !/from\s+['"]@actions\/core['"]/.test(MAIN_SOURCE),
    'src/main.ts must not import @actions/core',
  );
});

test('the pure API source (src/main.ts) does NOT call any @actions/core function', () => {
  // No core.* calls of any kind in the API surface.
  assert.ok(
    !/\bcore\d*\.(info|addPath|setFailed|setOutput|warning|debug|notice|error|exportVariable|setCommandEcho)\(/.test(MAIN_SOURCE),
    'src/main.ts must not call any @actions/core function',
  );
});

test('the API bundle (dist-test/index.cjs) does NOT contain any @actions/core calls', () => {
  // The API bundle, built from src/index.ts → src/main.ts, must
  // never include core.info / core.addPath / core.setFailed /
  // core.setOutput / etc. (those live in the action wrapper).
  assert.ok(
    !/\bcore\d*\.(info|addPath|setFailed|setOutput|warning|debug|notice|error)\(/.test(API_BUNDLE),
    'pure API bundle must not call any @actions/core function',
  );
});

test('the API bundle (dist-test/index.cjs) exposes installOpenCode as a function', () => {
  const api = require('../dist-test/index.cjs');
  assert.equal(
    typeof api.installOpenCode,
    'function',
    'dist-test bundle must export installOpenCode as a function',
  );
});

test('src/index.ts re-exports the API from src/main.ts', () => {
  assert.match(
    INDEX_SOURCE,
    /from\s+['"]\.\/main['"]/,
    'src/index.ts must re-export from src/main.ts',
  );
});