const { test } = require('node:test');
const assert = require('node:assert');
const { checkAgainstSchema, parseAndCheck, LlmError } = require('../dist-test/index.cjs');

const S = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };

test('checkAgainstSchema rejects a wrong shape and names the field', () => {
  const res = checkAgainstSchema({ answer: 1 }, S);
  assert.equal(res.ok, false);
  assert.match(res.errors, /answer/);
});

test('checkAgainstSchema accepts a valid value', () => {
  assert.deepEqual(checkAgainstSchema({ answer: 'yes' }, S), { ok: true });
});

test('parseAndCheck throws invalid_output on non-JSON', () => {
  assert.throws(() => parseAndCheck('not json', S, 'x'), (err) => err instanceof LlmError && err.kind === 'invalid_output');
});

test('parseAndCheck returns the parsed value on valid JSON', () => {
  assert.deepEqual(parseAndCheck('{"answer":"yes"}', S, 'x'), { answer: 'yes' });
});
