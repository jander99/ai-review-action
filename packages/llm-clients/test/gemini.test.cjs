const { test } = require('node:test');
const assert = require('node:assert');
const { runLlmConformance } = require('./conformance.cjs');
const { createLlmClient } = require('../dist-test/index.cjs');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');
const fixtures = require('./fixtures/gemini/index.cjs');

runLlmConformance(test, {
  name: 'gemini',
  create: (c) => createLlmClient('gemini', c),
  fixtures,
  expectSeedInBody: true,
  forbidBodyKeys: [],
});

test('gemini: body carries the json schema config', async () => {
  const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
  try {
    await createLlmClient('gemini', { apiKey: 'k', model: 'm' }).complete({
      system: 'sys',
      prompt: 'p',
      jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
    const body = JSON.parse(f.calls[0].body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.responseJsonSchema.type, 'object');
    assert.ok(f.calls[0].url.startsWith('https://generativelanguage.googleapis.com'));
  } finally { f.restore(); }
});
