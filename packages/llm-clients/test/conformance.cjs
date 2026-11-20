/**
 * Shared conformance suite every LLM adapter must pass.
 *
 * Usage from an adapter test file:
 *   runLlmConformance(t, { name, create, fixtures: { ok, okWrongShape, okNotJson, refusal }, expectSeedInBody, forbidBodyKeys })
 * where `create(config)` is `(c) => createLlmClient('<provider>', c)`.
 */

const assert = require('node:assert');
const { installFakeFetch } = require('../../../test-helpers/fake-fetch.cjs');

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const REQ = { system: 'sys', prompt: '{"note":"conformance"}', jsonSchema: SCHEMA, maxTokens: 128 };
const CONFIG = { apiKey: 'sk-test-CONFIGKEY', model: 'test-model' };

function runLlmConformance(t, { name, create, fixtures, expectSeedInBody, forbidBodyKeys = [] }) {
  const register = (title, fn) => (typeof t?.test === 'function' ? t.test(`${name}: ${title}`, fn) : t(`${name}: ${title}`, fn));

  register('ok output parses and reports usage', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
    try {
      const res = await create(CONFIG).complete(REQ);
      assert.equal(res.value.answer, 'yes');
      assert.ok(res.usage.inputTokens >= 0);
      assert.ok(res.usage.outputTokens >= 0);
    } finally { f.restore(); }
  });

  register('401 maps to auth after exactly one call', async () => {
    const f = installFakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    try {
      await assert.rejects(create(CONFIG).complete(REQ), (err) => err.kind === 'auth');
      assert.equal(f.calls.length, 1);
    } finally { f.restore(); }
  });

  register('503 with retry-after is retried then resolves', async () => {
    const f = installFakeFetch([{ status: 503, body: { error: { message: 'unavailable' } }, headers: { 'retry-after': '0' } }, { status: 200, body: fixtures.ok }]);
    try {
      await create(CONFIG).complete(REQ);
      assert.equal(f.calls.length, 2);
    } finally { f.restore(); }
  });

  register('persistent 429 maps to rate_limit', async () => {
    const f = installFakeFetch([{ status: 429, body: { error: { message: 'slow down' } } }]);
    try {
      await assert.rejects(create({ ...CONFIG, options: { maxRetries: 0 } }).complete(REQ), (err) => err.kind === 'rate_limit');
    } finally { f.restore(); }
  });

  register('api key never appears in errors', async () => {
    const f = installFakeFetch([{ status: 500, body: { error: { message: 'boom sk-test-SECRET123' } } }]);
    try {
      const err = await create({ ...CONFIG, apiKey: 'sk-test-SECRET123' }).complete(REQ).then(() => null, (e) => e);
      assert.ok(err, 'expected a rejection');
      assert.ok(!String(err.message).includes('SECRET123'));
      assert.ok(!String(err.stack).includes('SECRET123'));
    } finally { f.restore(); }
  });

  register('timeout maps to transient', async () => {
    const f = installFakeFetch(['hang']);
    const started = Date.now();
    try {
      await assert.rejects(create({ ...CONFIG, timeoutMs: 50, options: { maxRetries: 0 } }).complete(REQ), (err) => err.kind === 'transient');
      assert.ok(Date.now() - started < 2000);
    } finally { f.restore(); }
  });

  register('env vars cannot redirect traffic', async () => {
    const junk = { OPENAI_API_KEY: 'junk', OPENAI_BASE_URL: 'https://junk.invalid', ANTHROPIC_API_KEY: 'junk', ANTHROPIC_AUTH_TOKEN: 'junk', ANTHROPIC_BASE_URL: 'https://junk.invalid', GEMINI_API_KEY: 'junk', GOOGLE_API_KEY: 'junk' };
    const saved = {};
    for (const [k, v] of Object.entries(junk)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      const clean = installFakeFetch([{ status: 200, body: fixtures.ok }]);
      await create(CONFIG).complete(REQ);
      const cleanHost = new URL(clean.calls[0].url).host;
      clean.restore();

      const dirty = installFakeFetch([{ status: 200, body: fixtures.ok }]);
      await create(CONFIG).complete(REQ);
      assert.equal(new URL(dirty.calls[0].url).host, cleanHost);
      const headerValues = Object.values(dirty.calls[0].headers).join(' ');
      assert.ok(headerValues.includes(CONFIG.apiKey), 'auth header carries the config key');
      assert.ok(!headerValues.includes('junk'), 'no header carries the junk env values');
      dirty.restore();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  register('wrong shape maps to invalid_output naming the field', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.okWrongShape }]);
    try {
      await assert.rejects(create(CONFIG).complete(REQ), (err) => err.kind === 'invalid_output' && /answer/.test(String(err.details)));
    } finally { f.restore(); }
  });

  register('non-JSON body maps to invalid_output', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.okNotJson }]);
    try {
      await assert.rejects(create(CONFIG).complete(REQ), (err) => err.kind === 'invalid_output');
    } finally { f.restore(); }
  });

  register('refusal maps to refusal', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.refusal }]);
    try {
      await assert.rejects(create(CONFIG).complete(REQ), (err) => err.kind === 'refusal');
    } finally { f.restore(); }
  });

  register('seed field and forbidden body keys', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
    try {
      await create(CONFIG).complete({ ...REQ, seed: 7 });
      const body = f.calls[0].body;
      assert.equal(body.includes('"seed"'), expectSeedInBody, `seed field presence should be ${expectSeedInBody}`);
      for (const key of forbidBodyKeys) {
        assert.ok(!body.includes(`"${key}"`), `body must not contain ${key}`);
      }
    } finally { f.restore(); }
  });

  register('maxTokens omitted sends the default', async () => {
    const f = installFakeFetch([{ status: 200, body: fixtures.ok }]);
    try {
      const { maxTokens, ...req } = REQ;
      await create(CONFIG).complete(req);
      assert.ok(f.calls[0].body.includes('4096'), 'default max output tokens must appear in the body');
    } finally { f.restore(); }
  });
}

module.exports = { runLlmConformance, REQ, CONFIG, SCHEMA };
