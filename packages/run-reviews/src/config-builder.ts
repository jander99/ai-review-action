import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './types';
import type { AgentDefinition, MergedConfig, Permission } from './types';

export interface BuildMergedConfigOptions {
  userConfig?: string;
  permission: Permission;
  agent: AgentDefinition;
  model: string;
  workspace?: string;
  runnerTemp?: string;
}

export interface BuildMergedConfigResult {
  configPath: string;
  homeDir: string;
  /**
   * Deterministic JSON serialization of the merged OpenCode config
   * (without temp paths or env-specific pollution). Callers can pass
   * this on to other actions so they reuse the same resolved
   * providers, permissions, and agent definitions instead of
   * rebuilding their own.
   */
  serializedConfig: string;
  merged: MergedConfig;
}

export interface BuildFusionConfigOptions {
  agent: AgentDefinition;
  model: string;
  runnerTemp?: string;
}

export interface BuildValidatorConfigOptions {
  /**
   * Resolved OpenCode model the validator should use. Typically the
   * effective first model from `run-reviews`.
   */
  model: string;
  /**
   * Agent definition for the validator agent (built by the caller
   * from the canonical `VALIDATOR_AGENT_PROMPT_TEMPLATE`).
   */
  validatorAgent: AgentConfig;
  /**
   * Optional path to a user-provided OpenCode config. The file is
   * parsed for `provider` blocks only; agent definitions and prompts
   * from the user config are NOT forwarded so we never leak the
   * reviewer's `agent.review` prompt or any path it contains.
   */
  userConfig?: string;
  workspace?: string;
}

export interface BuildValidatorConfigResult {
  /**
   * Deterministic JSON serialization of a validator-only config. It
   * contains the providers (built-in and user-supplied, with secret
   * fields redacted to `{env:VAR}` placeholders), the effective
   * model, the deny-all validator permission, and a single
   * `agent.validator` definition. The `__validator__: true` marker
   * lets downstream consumers recognize the config as validator-only.
   */
  serializedConfig: string;
  config: Record<string, unknown>;
}

const FUSION_PERMISSION: Permission = {
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  webfetch: 'deny',
  edit: 'deny',
  question: 'deny',
  doom_loop: 'deny',
  bash: 'deny',
};

const VALIDATOR_PERMISSION: Permission = {
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  webfetch: 'deny',
  edit: 'deny',
  question: 'deny',
  doom_loop: 'deny',
  bash: 'deny',
};

// Property names whose values are commonly used to carry API keys /
// bearer tokens / password-style credentials. The redaction walks any
// matching property and rewrites literal values to `<redacted>`.
// `{env:VAR}` style references are NOT redacted because they are
// already placeholders that OpenCode resolves at runtime.
const SECRET_PROPERTY_NAMES = new Set([
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'bearer',
  'bearer_token',
  'bearertoken',
  'authorization',
  'password',
  'secret',
  'secretkey',
  'secret_key',
]);

const ENV_REFERENCE_PATTERN = /^\{env:[A-Z_][A-Z0-9_]*\}$/;

function isEnvReference(value: unknown): boolean {
  return typeof value === 'string' && ENV_REFERENCE_PATTERN.test(value);
}

function redactSecretValue(value: unknown): unknown {
  // Preserve `{env:VAR}` placeholders so OpenCode can resolve them
  // at runtime; replace literal strings with a redaction marker.
  if (isEnvReference(value)) {
    return value;
  }
  return '<redacted>';
}

function isSecretPropertyName(name: string): boolean {
  return SECRET_PROPERTY_NAMES.has(name.toLowerCase());
}

/**
 * Recursively walk an arbitrary value and redact secret-bearing
 * properties on any plain object or array element. Primitives pass
 * through unchanged; arrays preserve their length and ordering; empty
 * arrays and empty objects pass through verbatim.
 */
function redactSecretsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => redactSecretsDeep(element));
  }
  if (value && typeof value === 'object') {
    return redactProviderSecrets(value as Record<string, unknown>);
  }
  return value;
}

function redactProviderSecrets(provider: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider)) {
    if (isSecretPropertyName(key)) {
      redacted[key] = redactSecretValue(value);
      continue;
    }
    if (Array.isArray(value)) {
      redacted[key] = redactSecretsDeep(value);
      continue;
    }
    if (value && typeof value === 'object') {
      redacted[key] = redactProviderSecrets(value as Record<string, unknown>);
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

function stripJsonComments(source: string): string {
  return source.replace(
    /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (match, quoted: string | undefined) => quoted ?? '',
  );
}

function rebaseFileReferences(value: unknown, sourceDir: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{file:([^}]+)\}/g, (_match, filePath: string) => {
      const rebased = path.isAbsolute(filePath) ? filePath : path.resolve(sourceDir, filePath);
      return `{file:${rebased}}`;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => rebaseFileReferences(item, sourceDir));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebaseFileReferences(item, sourceDir)]),
    );
  }

  return value;
}

function rebasePath(value: unknown, sourceDir: string): unknown {
  if (typeof value !== 'string' || path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(sourceDir, value);
}

function rebaseUserConfig(config: Record<string, unknown>, sourceDir: string): Record<string, unknown> {
  const rebased = rebaseFileReferences(config, sourceDir) as Record<string, unknown>;

  if (Array.isArray(rebased.plugin)) {
    rebased.plugin = rebased.plugin.map((plugin) => {
      if (typeof plugin === 'string' && (plugin.startsWith('./') || plugin.startsWith('../'))) {
        return rebasePath(plugin, sourceDir);
      }
      return plugin;
    });
  }

  if (rebased.mcp && typeof rebased.mcp === 'object' && !Array.isArray(rebased.mcp)) {
    rebased.mcp = Object.fromEntries(
      Object.entries(rebased.mcp as Record<string, unknown>).map(([name, definition]) => {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
          return [name, definition];
        }
        const server = { ...(definition as Record<string, unknown>) };
        if ('cwd' in server) {
          server.cwd = rebasePath(server.cwd, sourceDir);
        }
        return [name, server];
      }),
    );
  }

  return rebased;
}

function builtInProviders(): Record<string, unknown> {
  const providers: Record<string, unknown> = {};

  if (process.env.MINIMAX_API_KEY) {
    providers.minimax = {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'https://api.minimax.io/v1',
        apiKey: '{env:MINIMAX_API_KEY}',
      },
      models: {
        'minimax-m3': { name: 'MiniMax-M3' },
      },
    };
  }

  const kimiKey = process.env.KIMI_API_KEY ? 'KIMI_API_KEY' : process.env.MOONSHOT_API_KEY ? 'MOONSHOT_API_KEY' : undefined;
  if (kimiKey) {
    providers.kimi = {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'https://api.moonshot.ai/v1',
        apiKey: `{env:${kimiKey}}`,
      },
    };
  }

  if (
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  ) {
    providers['amazon-bedrock'] = {
      npm: '@ai-sdk/amazon-bedrock',
      options: {
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
      },
    };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    providers['google-vertex-anthropic'] = {
      npm: '@ai-sdk/google-vertex-anthropic',
      options: {
        project:
          process.env.GOOGLE_CLOUD_PROJECT ||
          process.env.GCLOUD_PROJECT ||
          process.env.GCP_PROJECT ||
          '{env:GOOGLE_CLOUD_PROJECT}',
        region: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      },
    };
  }

  return providers;
}

/**
 * Build the merged OpenCode config without writing it to disk. The
 * returned object is identical to what `buildMergedConfig` writes to
 * `configPath`, so callers can serialize it deterministically and
 * share it with downstream actions.
 */
export function buildMergedConfigObject(options: BuildMergedConfigOptions): MergedConfig {
  const workspace = path.resolve(options.workspace || process.env.GITHUB_WORKSPACE || process.cwd());
  let userConfigSource: string | undefined;
  let userConfigSourceDir: string | undefined;

  if (options.userConfig) {
    const userConfigPath = path.isAbsolute(options.userConfig)
      ? options.userConfig
      : path.resolve(workspace, options.userConfig);
    userConfigSource = fs.readFileSync(userConfigPath, 'utf8');
    userConfigSourceDir = path.dirname(userConfigPath);
  }

  let userConfig: Record<string, unknown> = {};
  if (userConfigSource && userConfigSourceDir) {
    userConfig = rebaseUserConfig(
      JSON.parse(stripJsonComments(userConfigSource)) as Record<string, unknown>,
      userConfigSourceDir,
    );
  }

  const userProviders =
    userConfig.provider && typeof userConfig.provider === 'object' && !Array.isArray(userConfig.provider)
      ? (userConfig.provider as Record<string, unknown>)
      : {};

  return {
    ...userConfig,
    permission: options.permission,
    agent: options.agent,
    default_agent: 'review',
    model: options.model,
    provider: {
      ...userProviders,
      ...builtInProviders(),
    },
  };
}

export function buildMergedConfig(options: BuildMergedConfigOptions): BuildMergedConfigResult {
  const workspace = path.resolve(options.workspace || process.env.GITHUB_WORKSPACE || process.cwd());
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || process.cwd());

  for (const fileName of ['opencode.json', 'opencode.jsonc']) {
    const configPath = path.join(workspace, fileName);
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath, { force: true });
      core.info(`Deleted workspace OpenCode config: ${configPath}`);
    }
  }

  const merged = buildMergedConfigObject(options);
  const serializedConfig = JSON.stringify(merged, null, 2);
  fs.mkdirSync(runnerTemp, { recursive: true });
  const configPath = path.join(runnerTemp, 'opencode.json');
  const homeDir = path.join(runnerTemp, 'ai-review-opencode-home');
  fs.writeFileSync(configPath, serializedConfig, 'utf8');
  core.info(`Wrote merged OpenCode config: ${configPath}`);
  return { configPath, homeDir, serializedConfig, merged };
}

export function buildFusionConfig(options: BuildFusionConfigOptions): BuildMergedConfigResult {
  const synthesisAgent = options.agent.synthesis;
  if (!synthesisAgent) {
    throw new Error('Synthesis agent definition is required');
  }

  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || process.cwd());
  const configPath = path.join(runnerTemp, 'opencode-fusion.json');
  const homeDir = path.join(runnerTemp, 'ai-review-opencode-home-fusion');
  const config = {
    permission: FUSION_PERMISSION,
    agent: { synthesis: synthesisAgent },
    default_agent: 'synthesis',
    model: options.model,
  };

  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  core.info(`Wrote isolated OpenCode fusion config: ${configPath}`);
  return {
    configPath,
    homeDir,
    serializedConfig: JSON.stringify(config, null, 2),
    merged: config as unknown as MergedConfig,
  };
}

/**
 * Build a validator-only OpenCode config that can be safely passed
 * to downstream actions. The returned object:
 *
 *   - contains the resolved providers (built-in plus the user-
 *     supplied `provider` block, with any secret-bearing properties
 *     redacted to `<redacted>` so we never forward literal API keys),
 *   - contains the effective model the validator should use,
 *   - contains the deny-all validator permission,
 *   - contains exactly one `agent.validator` definition,
 *   - carries the `__validator__: true` marker so consumers can
 *     recognize it as validator-only.
 *
 * Crucially, the object does NOT contain `agent.review`,
 * `agent.synthesis`, or any prompt that embeds `reviewOutputPath`,
 * and does NOT contain any `OPENCODE_*` env values.
 */
export function buildValidatorConfig(options: BuildValidatorConfigOptions): BuildValidatorConfigResult {
  if (!options.model) {
    throw new Error('model is required to build a validator config');
  }
  if (!options.validatorAgent) {
    throw new Error('validatorAgent is required to build a validator config');
  }

  const workspace = path.resolve(options.workspace || process.env.GITHUB_WORKSPACE || process.cwd());
  let userProviders: Record<string, unknown> = {};

  if (options.userConfig) {
    const userConfigPath = path.isAbsolute(options.userConfig)
      ? options.userConfig
      : path.resolve(workspace, options.userConfig);
    if (fs.existsSync(userConfigPath)) {
      const source = fs.readFileSync(userConfigPath, 'utf8');
      const sourceDir = path.dirname(userConfigPath);
      const parsed = rebaseUserConfig(
        JSON.parse(stripJsonComments(source)) as Record<string, unknown>,
        sourceDir,
      );
      if (parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)) {
        userProviders = parsed.provider as Record<string, unknown>;
      }
    }
  }

  const provider: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(userProviders)) {
    if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
      provider[name] = redactProviderSecrets(definition as Record<string, unknown>);
    } else {
      provider[name] = definition;
    }
  }
  for (const [name, definition] of Object.entries(builtInProviders())) {
    if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
      provider[name] = redactProviderSecrets(definition as Record<string, unknown>);
    } else {
      provider[name] = definition;
    }
  }

  const config = {
    __validator__: true,
    default_agent: 'validator',
    model: options.model,
    permission: VALIDATOR_PERMISSION,
    provider,
    agent: {
      validator: options.validatorAgent,
    },
  };
  return {
    serializedConfig: JSON.stringify(config, null, 2),
    config,
  };
}