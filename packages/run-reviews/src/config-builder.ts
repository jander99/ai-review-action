import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
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
}

export interface BuildFusionConfigOptions {
  agent: AgentDefinition;
  model: string;
  runnerTemp?: string;
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

export function buildMergedConfig(options: BuildMergedConfigOptions): BuildMergedConfigResult {
  const workspace = path.resolve(options.workspace || process.env.GITHUB_WORKSPACE || process.cwd());
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || process.cwd());
  let userConfigSource: string | undefined;
  let userConfigSourceDir: string | undefined;

  if (options.userConfig) {
    const userConfigPath = path.isAbsolute(options.userConfig)
      ? options.userConfig
      : path.resolve(workspace, options.userConfig);
    userConfigSource = fs.readFileSync(userConfigPath, 'utf8');
    userConfigSourceDir = path.dirname(userConfigPath);
  }

  for (const fileName of ['opencode.json', 'opencode.jsonc']) {
    const configPath = path.join(workspace, fileName);
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath, { force: true });
      core.info(`Deleted workspace OpenCode config: ${configPath}`);
    }
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

  const merged: MergedConfig = {
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

  const serialized = JSON.stringify(merged, null, 2);
  fs.mkdirSync(runnerTemp, { recursive: true });
  const configPath = path.join(runnerTemp, 'opencode.json');
  const homeDir = path.join(runnerTemp, 'ai-review-opencode-home');
  fs.writeFileSync(configPath, serialized, 'utf8');
  core.info(`Wrote merged OpenCode config: ${configPath}`);
  return { configPath, homeDir };
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
  return { configPath, homeDir };
}
