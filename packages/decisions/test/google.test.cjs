const { test } = require('node:test');
const assert = require('node:assert');
const { runDecisionConformance, REQ } = require('./conformance.cjs');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');
const { createDecisionClient } = require('../dist-test/index.cjs');
const fixtures = {
  ok: require('./fixtures/google/ok.json'),
  missingAnswer: require('./fixtures/google/missing-answer.json'),
};

runDecisionConformance(test, { name: 'google', create: (c) => createDecisionClient('google', c), fixtures });

test('request targets /v1beta/decisions with the goog key header', async () => {
  const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
  try {
    await createDecisionClient('google', { apiKey: 'g-key', model: 'gemini-decision-1' }).decide(REQ);
    assert.ok(new URL(f.calls[0].url).pathname.endsWith('/v1beta/decisions'));
    assert.equal(f.calls[0].headers['x-goog-api-key'], 'g-key');
    const body = JSON.parse(f.calls[0].body);
    assert.equal(body.model, 'models/gemini-decision-1');
    assert.equal(body.input, REQ.state);
  } finally { f.restore(); }
});
