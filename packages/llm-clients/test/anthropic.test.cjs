const { test } = require('node:test');
const assert = require('node:assert');
const { runLlmConformance } = require('./conformance.cjs');
const { createLlmClient } = require('../dist-test/index.cjs');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');
const fixtures = require('./fixtures/anthropic/index.cjs');

runLlmConformance(test, {
  name: 'anthropic',
  create: (c) => createLlmClient('anthropic', c),
  fixtures,
  expectSeedInBody: false,
  forbidBodyKeys: ['temperature', 'top_p', 'top_k', 'seed'],
});

test('anthropic: body carries a json_schema output format', async () => {
  const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
  try {
    await createLlmClient('anthropic', { apiKey: 'k', model: 'm' }).complete({
      system: 'sys',
      prompt: 'p',
      jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
    const body = JSON.parse(f.calls[0].body);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
  } finally { f.restore(); }
});
