const { test } = require('node:test');
const assert = require('node:assert');
const { runDecisionConformance, REQ } = require('./conformance.cjs');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');
const { createDecisionClient } = require('../dist-test/index.cjs');
const fixtures = {
  ok: require('./fixtures/systemone/ok.json'),
  missingAnswer: require('./fixtures/systemone/missing-answer.json'),
};

runDecisionConformance(test, { name: 'systemone', create: (c) => createDecisionClient('systemone', c), fixtures });

test('posts to <baseUrl>/v1/systemone with bearer key', async () => {
  const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
  try {
    await createDecisionClient('systemone', { apiKey: 'k1', model: 'subq-snap-1.2', baseUrl: 'https://api.subq.ai' }).decide(REQ);
    assert.equal(new URL(f.calls[0].url).href, 'https://api.subq.ai/v1/systemone');
    assert.equal(f.calls[0].headers.authorization, 'Bearer k1');
    assert.equal(JSON.parse(f.calls[0].body).state, REQ.state);
  } finally { f.restore(); }
});
