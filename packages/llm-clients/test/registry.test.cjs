const { test } = require('node:test');
const assert = require('node:assert');
const { createLlmClient, listLlmProviders } = require('../dist-test/index.cjs');

test('unknown provider lists allowed keys', () => {
  assert.throws(() => createLlmClient('nope', { apiKey: 'k', model: 'm' }), /llm-provider must be one of: .*\(received 'nope'\)/);
});
test('missing key and model are rejected', () => {
  assert.throws(() => createLlmClient(listLlmProviders()[0] ?? 'x', { apiKey: '', model: 'm' }), /llm-api-key is required|llm-provider must be one of/);
  assert.throws(() => createLlmClient(listLlmProviders()[0] ?? 'x', { apiKey: 'k', model: '' }), /llm-model is required|llm-provider must be one of/);
});
