const { test } = require('node:test');
const assert = require('node:assert');
const { createDecisionClient, listDecisionProviders } = require('../dist-test/index.cjs');

test('unknown provider lists allowed keys', () => {
  assert.throws(() => createDecisionClient('nope', { apiKey: 'k', model: 'm' }), /decision-provider must be one of: .*\(received 'nope'\)/);
});
test('missing key and model are rejected', () => {
  assert.throws(() => createDecisionClient(listDecisionProviders()[0] ?? 'x', { apiKey: '', model: 'm' }), /decision-api-key is required|decision-provider must be one of/);
});
