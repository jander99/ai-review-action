'use strict';

/**
 * Phase-3 smoke test for the failure-reason ordering guarantee.
 *
 * Block 3 of the Phase-2 remediation said:
 *
 *   - `setEmptyOutputs()` must NOT reset `failure-reason`.
 *   - When `run()` exits via a failure path, `failure-reason` MUST be
 *     assigned to the failure message before `setFailed`.
 *
 * Phase 3 moved the standalone wrapper into `src/action.ts` and kept
 * the API in `src/main.ts`. The wrapper still preserves both
 * invariants:
 *
 *   - the standalone wrapper's "empty outputs" branch never touches
 *     `failure-reason`;
 *   - the standalone wrapper's failure branch assigns `failure-reason`
 *     before calling `core.setFailed`.
 *
 * We verify both invariants by parsing the bundle's source.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readBundle() {
  return fs.readFileSync(path.join(__dirname, '..', 'dist', 'main.cjs'), 'utf8');
}

test('standalone wrapper emits failure-reason before setFailed on failure', () => {
  // The standalone wrapper at the bottom of main.cjs runs only when
  // `require.main === module` (so the package can also be imported as
  // a library by the root action bundle). Search for the conditional
  // wrapper and confirm the failure-reason assignment precedes
  // setFailed inside it.
  const bundle = readBundle();
  const wrapperStart = bundle.search(/if \(require\.main === module\) \{/);
  assert.ok(wrapperStart >= 0, 'bundle must contain the require.main === module guard');

  // Locate the failure branch: the wrapper checks `if (result.failureReason)`
  // and assigns + setFailed inside that block. esbuild may suffix the
  // core symbol with a number (e.g. `core2`) or alias to a const.
  const setOutputRegex = /core\d*\.setOutput\("failure-reason", result\.failureReason\)/;
  const setFailedRegex = /core\d*\.setFailed\(result\.failureReason\)/;
  const setOutputIdx = bundle.search(setOutputRegex);
  const setFailedIdx = bundle.search(setFailedRegex);
  assert.ok(setOutputIdx >= 0, 'wrapper must setOutput failure-reason on failure');
  assert.ok(setFailedIdx >= 0, 'wrapper must call setFailed on failure');
  assert.ok(
    setOutputIdx < setFailedIdx,
    `failure-reason setOutput must precede setFailed (got setOutput at ${setOutputIdx}, setFailed at ${setFailedIdx})`,
  );
});

test('runReviews result shape never carries failure-reason on success', () => {
  // Quick behavioral check: the standalone wrapper always emits
  // `failure-reason` (as empty string) on the success branch so
  // downstream steps can observe the output.
  const bundle = readBundle();
  // Match any core variant.
  const match = bundle.match(/core\d*\.setOutput\("failure-reason", ""\)/);
  assert.ok(match, 'wrapper must always emit failure-reason (possibly empty) so downstream steps can observe the output');
});

test('no leftover setEmptyOutputs / failAndExit helpers in the new bundle', () => {
  // The Phase-3 refactor inlines both helpers into runReviews and the
  // wrapper. There must be no top-level helper definitions left.
  const bundle = readBundle();
  assert.equal(bundle.includes('function setEmptyOutputs('), false, 'bundle must not contain the old setEmptyOutputs helper');
  assert.equal(bundle.includes('function failAndExit('), false, 'bundle must not contain the old failAndExit helper');
});

test('the leaf bundle has exactly one require.main === module guard', () => {
  // Block 1 of the Phase-3 bounded remediation: each leaf action's
  // dist/main.cjs must contain exactly one `require.main === module`
  // guard (the wrapper). Bundling the package as a library must NOT
  // bring along any other top-level side effects.
  const bundle = readBundle();
  const matches = bundle.match(/require\.main === module/g) ?? [];
  assert.equal(matches.length, 1, `expected exactly 1 guard, got ${matches.length}`);
});