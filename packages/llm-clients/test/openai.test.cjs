const { test } = require('node:test');
const assert = require('node:assert');
const { runLlmConformance } = require('./conformance.cjs');
const { createLlmClient } = require('../dist-test/index.cjs');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');
const fixtures = require('./fixtures/openai/index.cjs');

runLlmConformance(test, {
  name: 'openai',
  create: (c) => createLlmClient('openai', c),
  fixtures,
  expectSeedInBody: false,
  forbidBodyKeys: ['seed'],
});

test('openai: body sets store false and strict JSON schema format', async () => {
  const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
  try {
    await createLlmClient('openai', { apiKey: 'k', model: 'm' }).complete({
      system: 'sys',
      prompt: 'p',
      jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
    const body = JSON.parse(f.calls[0].body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(f.calls[0].url, 'https://api.openai.com/v1/responses');
  } finally { f.restore(); }
});
