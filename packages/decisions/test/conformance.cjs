/**
 * Shared conformance suite every decision adapter must pass.
 *
 * Usage from an adapter test file:
 *   runDecisionConformance(test, { name, create, fixtures: { ok, missingAnswer } })
 * where `create(config)` is `(c) => createDecisionClient('<provider>', c)`.
 */

const assert = require('node:assert');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');

const REQ = {
  state: '{"note":"conformance"}',
  questions: {
    supported: { type: 'noul', text: 'does the code support the claim?' },
    severity: { type: 'choice', text: 'how severe is it?', options: ['blocker', 'major', 'minor', 'nit'] },
  },
};

const CONFIG = { apiKey: 'sk-test-CONFIGKEY', model: 'test-model' };

function runDecisionConformance(t, { name, create, fixtures }) {
  const register = (title, fn) => (typeof t?.test === 'function' ? t.test(`${name}: ${title}`, fn) : t(`${name}: ${title}`, fn));

  register('ok answers have the right types and ranges', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
    try {
      const res = await create(CONFIG).decide(REQ);
      assert.equal(res.answers.supported.type, 'noul');
      assert.ok(res.answers.supported.pTrue >= 0 && res.answers.supported.pTrue <= 1);
      assert.equal(res.answers.severity.type, 'choice');
      const sum = Object.values(res.answers.severity.probabilities).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) <= 0.02, `choice probabilities sum to ${sum}`);
      assert.ok(res.usage.inputTokens >= 0);
    } finally { f.restore(); }
  });

  register('401 maps to auth after exactly one call', async () => {
    const f = installFakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    try {
      await assert.rejects(create(CONFIG).decide(REQ), (err) => err.kind === 'auth');
      assert.equal(f.calls.length, 1);
    } finally { f.restore(); }
  });

  register('503 with retry-after is retried then resolves', async () => {
    const f = installFakeFetch([{ status: 503, body: { error: { message: 'unavailable' } }, headers: { 'retry-after': '0' } }, { status: 200, body: fixtures.ok }]);
    try {
      await create(CONFIG).decide(REQ);
      assert.equal(f.calls.length, 2);
    } finally { f.restore(); }
  });

  register('persistent 429 maps to rate_limit', async () => {
    const f = installFakeFetch([{ status: 429, body: { error: { message: 'slow down' } } }]);
    try {
      await assert.rejects(create({ ...CONFIG, options: { maxRetries: 1 } }).decide(REQ), (err) => err.kind === 'rate_limit');
    } finally { f.restore(); }
  });

  register('missing answer maps to other', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.missingAnswer }]);
    try {
      await assert.rejects(create(CONFIG).decide(REQ), (err) => err.kind === 'other' && /missing or mistyped answer/.test(err.message));
    } finally { f.restore(); }
  });

  register('api key never appears in errors', async () => {
    const f = installFakeFetch([{ status: 500, body: { error: { message: 'boom sk-test-SECRET123' } } }]);
    try {
      const err = await create({ ...CONFIG, apiKey: 'sk-test-SECRET123' }).decide(REQ).then(() => null, (e) => e);
      assert.ok(err, 'expected a rejection');
      assert.ok(!String(err.message).includes('SECRET123'));
      assert.ok(!String(err.stack).includes('SECRET123'));
    } finally { f.restore(); }
  });

  register('timeout maps to transient', async () => {
    const f = installFakeFetch(['hang']);
    const started = Date.now();
    try {
      await assert.rejects(create({ ...CONFIG, timeoutMs: 50, options: { maxRetries: 0 } }).decide(REQ), (err) => err.kind === 'transient');
      assert.ok(Date.now() - started < 2000);
    } finally { f.restore(); }
  });

  register('env vars cannot redirect traffic', async () => {
    const junk = { GEMINI_API_KEY: 'junk', GOOGLE_API_KEY: 'junk', TYPESAFE_API_KEY: 'junk', TYPESAFE_BASE_URL: 'https://junk.invalid' };
    const saved = {};
    for (const [k, v] of Object.entries(junk)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      const clean = installFakeFetch([{ status: 200, body: fixtures.ok }]);
      await create(CONFIG).decide(REQ);
      const cleanHost = new URL(clean.calls[0].url).host;
      clean.restore();

      const dirty = installFakeFetch([{ status: 200, body: fixtures.ok }]);
      await create(CONFIG).decide(REQ);
      assert.equal(new URL(dirty.calls[0].url).host, cleanHost);
      const headerValues = Object.values(dirty.calls[0].headers).join(' ');
      assert.ok(headerValues.includes(CONFIG.apiKey), 'auth header carries the config key');
      assert.ok(!headerValues.includes('junk'), 'no header carries the junk env values');
      dirty.restore();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

module.exports = { runDecisionConformance, REQ, CONFIG };
