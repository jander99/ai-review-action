import * as core from '@actions/core';
import { buildAgentDefinition, getEventContext } from './agent-definition';
import { buildMergedConfig } from './config-builder';
import { invokeOpenCode } from './opencode';
import { DEFAULT_PERMISSION } from './permissions';
import { composeTaskPrompt, parsePrompts } from './prompt-composer';
import type { Permission, PromptEntry, ReviewResult } from './types';

function readPermission(): Permission {
  const input = core.getInput('permission');
  if (!input) {
    return { ...DEFAULT_PERMISSION };
  }

  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('permission must be a JSON object');
  }
  return parsed as Permission;
}

function setEmptyOutputs(): void {
  core.setOutput('review', '');
  core.setOutput('models-used', '');
  core.setOutput('cost', 0);
  core.setOutput('cost-by-model', '{}');
  core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
  core.setOutput('tokens-by-model', '{}');
}

function run(): void {
  const model = core.getInput('model') || 'anthropic/claude-sonnet-4.6';
  const failOnError = core.getBooleanInput('fail-on-error');
  const timeoutMinutes = Number.parseInt(core.getInput('timeout-minutes') || '30', 10);
  const userConfig = core.getInput('opencode-config') || undefined;
  const results: ReviewResult[] = [];
  const failures: string[] = [];
  let prompts: PromptEntry[];
  let configPath: string;
  let homeDir: string;

  try {
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error('timeout-minutes must be a positive integer');
    }

    prompts = parsePrompts(core.getInput('prompts'));
    const agent = buildAgentDefinition(getEventContext());
    ({ configPath, homeDir } = buildMergedConfig({
      userConfig,
      permission: readPermission(),
      agent,
      model,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setEmptyOutputs();
    core.setFailed(`Review setup failed: ${message}`);
    return;
  }

  for (const prompt of prompts) {
    try {
      results.push(
        invokeOpenCode(composeTaskPrompt([prompt]), model, configPath, {
          homeDir,
          timeoutMinutes,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${prompt.source}: ${message}`);
      core.warning(`Review failed for ${prompt.source}: ${message}`);
    }
  }

  if (results.length === 0) {
    setEmptyOutputs();
  } else {
    const cost = results.reduce((total, result) => total + result.cost, 0);
    const tokens = results.reduce(
      (total, result) => ({
        input: total.input + result.tokens.input,
        output: total.output + result.tokens.output,
      }),
      { input: 0, output: 0 },
    );
    const costByModel = { [model]: cost };
    const tokensByModel = { [model]: tokens };

    core.setOutput('review', results[results.length - 1].text);
    core.setOutput('models-used', model);
    core.setOutput('cost', cost);
    core.setOutput('cost-by-model', JSON.stringify(costByModel));
    core.setOutput('tokens', JSON.stringify(tokens));
    core.setOutput('tokens-by-model', JSON.stringify(tokensByModel));
  }

  if (failures.length > 0 && failOnError) {
    core.setFailed(`${failures.length} review operation(s) failed`);
  }
}

run();
