'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildValidatorConfig } = require('../dist-test/index.cjs');

function makeAgent(prompt) {
  return {
    description: 'Validates the structural shape of a review markdown file.',
    mode: 'primary',
    prompt,
  };
}

test('buildValidatorConfig never embeds reviewer agent prompts or reviewOutputPath', () => {
  const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
  const reviewOutputPath = path.join(runnerTemp, 'ai-review', 'review-pr-1234abcd.md');

  // Mimic the reviewer-side prompt that always contains the
  // runner-local reviewOutputPath; the validator config must NOT
  // include this string or any reviewer agent definition.
  const reviewerPrompt = `Runtime context:\n- reviewOutputPath: ${reviewOutputPath}\n- eventName: pull_request\n`;
  const validatorPrompt = 'You are a structural validator.';

  const result = buildValidatorConfig({
    model: 'anthropic/claude-sonnet-4.6',
    validatorAgent: makeAgent(validatorPrompt),
  });

  // The serialized JSON must not contain the runner-local path.
  assert.ok(
    !result.serializedConfig.includes('reviewOutputPath'),
    'serialized validator config must not contain reviewOutputPath',
  );
  assert.ok(
    !result.serializedConfig.includes(reviewerPrompt),
    'serialized validator config must not contain the reviewer prompt',
  );
  assert.ok(
    !result.serializedConfig.includes(runnerTemp),
    'serialized validator config must not contain the RUNNER_TEMP path',
  );

  // Structural shape.
  assert.equal(result.config.__validator__, true, 'config must carry the __validator__: true marker');
  assert.equal(result.config.default_agent, 'validator');
  assert.equal(result.config.model, 'anthropic/claude-sonnet-4.6');
  assert.ok(result.config.provider, 'config must include a provider block');
  assert.ok(result.config.agent, 'config must include an agent block');
  assert.ok(result.config.agent.validator, 'config must include agent.validator');
  assert.ok(!result.config.agent.review, 'config must NOT include agent.review');
  assert.ok(!result.config.agent.synthesis, 'config must NOT include agent.synthesis');
  assert.equal(result.config.agent.validator.prompt, validatorPrompt);
});

test('buildValidatorConfig redacts user-supplied provider API keys to <redacted>', () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-validator-test-'));
  try {
    const userConfigPath = path.join(userConfigDir, 'opencode.json');
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        provider: {
          myProvider: {
            options: {
              baseURL: 'https://example.com/v1',
              apiKey: 'sk-abcdef1234567890',
            },
          },
        },
      }),
      'utf8',
    );

    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
      userConfig: userConfigPath,
    });

    assert.equal(
      result.config.provider.myProvider.options.apiKey,
      '<redacted>',
      'literal apiKey must be redacted',
    );
    assert.equal(
      result.config.provider.myProvider.options.baseURL,
      'https://example.com/v1',
      'non-secret baseURL must be preserved',
    );
  } finally {
    fs.rmSync(userConfigDir, { recursive: true, force: true });
  }
});

test('buildValidatorConfig redacts nested secret properties under user-supplied providers', () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-validator-test-'));
  try {
    const userConfigPath = path.join(userConfigDir, 'opencode.jsonc');
    fs.writeFileSync(
      userConfigPath,
      `// comment line
{
  "provider": {
    "myProvider": {
      "options": {
        "token": "ghp_live_abcdef",
        "bearerToken": "Bearer abcdef",
        "metadata": {
          "endpoint": "https://example.com",
          "api_key": "sk-live-xyz"
        }
      }
    }
  }
}`,
      'utf8',
    );

    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
      userConfig: userConfigPath,
    });

    const opts = result.config.provider.myProvider.options;
    assert.equal(opts.token, '<redacted>');
    assert.equal(opts.bearerToken, '<redacted>');
    assert.equal(opts.metadata.endpoint, 'https://example.com');
    assert.equal(opts.metadata.api_key, '<redacted>');
  } finally {
    fs.rmSync(userConfigDir, { recursive: true, force: true });
  }
});

test('buildValidatorConfig uses built-in providers when no user config is supplied', () => {
  // Ensure both built-in and user-provided providers coexist; the
  // built-in MINIMAX_API_KEY branch should appear when the env var is
  // set, otherwise the provider map is just empty.
  delete process.env.MINIMAX_API_KEY;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.KIMI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;

  const result = buildValidatorConfig({
    model: 'anthropic/claude-sonnet-4.6',
    validatorAgent: makeAgent('validator prompt'),
  });

  assert.deepEqual(result.config.provider, {});
});

test('buildValidatorConfig includes built-in providers when their env vars are set', () => {
  process.env.MINIMAX_API_KEY = 'sk-fake-minimax-key';
  try {
    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
    });

    assert.ok(result.config.provider.minimax, 'built-in minimax provider must appear');
    assert.equal(
      result.config.provider.minimax.options.apiKey,
      '{env:MINIMAX_API_KEY}',
      'built-in providers must use {env:VAR} placeholders, not literal keys',
    );
  } finally {
    delete process.env.MINIMAX_API_KEY;
  }
});

test('buildValidatorConfig rejects missing model', () => {
  assert.throws(
    () =>
      buildValidatorConfig({
        model: '',
        validatorAgent: makeAgent('validator prompt'),
      }),
    /model is required/,
  );
});

test('buildValidatorConfig rejects missing validator agent', () => {
  assert.throws(
    () =>
      buildValidatorConfig({
        model: 'anthropic/claude-sonnet-4.6',
        validatorAgent: undefined,
      }),
    /validatorAgent is required/,
  );
});

// ---------------------------------------------------------------------------
// Phase-2 second-remediation: Blocker 1 (array-walking redaction).
// ---------------------------------------------------------------------------

test('buildValidatorConfig redacts secrets inside arrays of objects', () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-validator-arrays-'));
  try {
    const userConfigPath = path.join(userConfigDir, 'opencode.json');
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        provider: {
          myProvider: {
            options: {
              credentials: [
                { apiKey: 'sk-abc-secret-1', region: 'us-east-1' },
                { apiKey: 'sk-abc-secret-2', region: 'us-west-2' },
              ],
            },
          },
        },
      }),
      'utf8',
    );

    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
      userConfig: userConfigPath,
    });

    const creds = result.config.provider.myProvider.options.credentials;
    assert.ok(Array.isArray(creds), 'credentials must remain an array');
    assert.equal(creds.length, 2);
    assert.equal(creds[0].apiKey, '<redacted>');
    assert.equal(creds[0].region, 'us-east-1');
    assert.equal(creds[1].apiKey, '<redacted>');
    assert.equal(creds[1].region, 'us-west-2');
    assert.ok(
      !result.serializedConfig.includes('sk-abc-secret'),
      'serialized config must not contain the literal secret',
    );
  } finally {
    fs.rmSync(userConfigDir, { recursive: true, force: true });
  }
});

test('buildValidatorConfig redacts mixed nested structures with arrays of objects', () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-validator-mixed-'));
  try {
    const userConfigPath = path.join(userConfigDir, 'opencode.json');
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        provider: {
          foo: {
            options: {
              arr: [
                { apiKey: 'x' },
                { token: 'y' },
              ],
            },
          },
        },
      }),
      'utf8',
    );

    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
      userConfig: userConfigPath,
    });

    const arr = result.config.provider.foo.options.arr;
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 2);
    assert.equal(arr[0].apiKey, '<redacted>');
    assert.equal(arr[1].token, '<redacted>');
    assert.ok(!result.serializedConfig.includes('"x"'));
    assert.ok(!result.serializedConfig.includes('"y"'));
  } finally {
    fs.rmSync(userConfigDir, { recursive: true, force: true });
  }
});

test('buildValidatorConfig preserves arrays of primitives unchanged', () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-validator-primitives-'));
  try {
    const userConfigPath = path.join(userConfigDir, 'opencode.json');
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        provider: {
          myProvider: {
            options: {
              tags: ['alpha', 'beta', 'gamma'],
              counts: [1, 2, 3],
              mixed: [1, 2, 'x'],
            },
          },
        },
      }),
      'utf8',
    );

    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
      userConfig: userConfigPath,
    });

    const opts = result.config.provider.myProvider.options;
    assert.deepEqual(opts.tags, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(opts.counts, [1, 2, 3]);
    assert.deepEqual(opts.mixed, [1, 2, 'x']);
  } finally {
    fs.rmSync(userConfigDir, { recursive: true, force: true });
  }
});

test('buildValidatorConfig preserves empty arrays and empty objects', () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-validator-empty-'));
  try {
    const userConfigPath = path.join(userConfigDir, 'opencode.json');
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        provider: {
          myProvider: {
            options: {
              emptyArray: [],
              emptyObject: {},
            },
          },
        },
      }),
      'utf8',
    );

    const result = buildValidatorConfig({
      model: 'anthropic/claude-sonnet-4.6',
      validatorAgent: makeAgent('validator prompt'),
      userConfig: userConfigPath,
    });

    const opts = result.config.provider.myProvider.options;
    assert.deepEqual(opts.emptyArray, []);
    assert.deepEqual(opts.emptyObject, {});
  } finally {
    fs.rmSync(userConfigDir, { recursive: true, force: true });
  }
});