import * as core from '@actions/core';
import { buildAgentDefinition, getEventContext } from './agent-definition';
import { buildFusionConfig, buildMergedConfig } from './config-builder';
import { composeFusionPrompt, composeLabeledReviews } from './fusion';
import { invokeOpenCode } from './opencode';
import { DEFAULT_PERMISSION } from './permissions';
import { composeTaskPrompt, parsePrompts } from './prompt-composer';
import type { Permission, PromptEntry, ReviewResult } from './types';

interface IndividualReviewResult extends ReviewResult {
  prompt: string;
}

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

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function run(): void {
  const model = core.getInput('model') || 'anthropic/claude-sonnet-4.6';
  const modelsInput = core.getInput('models');
  const fusionEnabled = core.getBooleanInput('fusion');
  const failOnError = core.getBooleanInput('fail-on-error');
  const timeoutMinutes = Number.parseInt(core.getInput('timeout-minutes') || '30', 10);
  const userConfig = core.getInput('opencode-config') || undefined;
  const individualResults: IndividualReviewResult[] = [];
  const accountedResults: ReviewResult[] = [];
  const successfulModels = new Set<string>();
  const failures: string[] = [];
  let prompts: PromptEntry[];
  let effectiveModels: string[];
  let fusionModel: string;
  let configPath: string;
  let homeDir: string;
  let fusionConfigPath = '';
  let fusionHomeDir = '';

  try {
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error('timeout-minutes must be a positive integer');
    }

    const parsedModels = modelsInput
      ? modelsInput
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [model];
    effectiveModels = [...new Set(parsedModels)];
    if (effectiveModels.length === 0) {
      throw new Error('At least one model is required');
    }

    fusionModel = core.getInput('fusion-model') || effectiveModels[0];
    prompts = parsePrompts(core.getInput('prompts'));
    const agent = buildAgentDefinition(getEventContext());
    ({ configPath, homeDir } = buildMergedConfig({
      userConfig,
      permission: readPermission(),
      agent,
      model: effectiveModels[0],
    }));
    if (fusionEnabled) {
      ({ configPath: fusionConfigPath, homeDir: fusionHomeDir } = buildFusionConfig({
        agent,
        model: fusionModel,
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setEmptyOutputs();
    core.setFailed(`Review setup failed: ${message}`);
    return;
  }

  const orderedPrompts = [...prompts].sort((left, right) => compareLexically(left.source, right.source));
  const orderedModels = [...effectiveModels].sort(compareLexically);

  for (const prompt of orderedPrompts) {
    for (const currentModel of orderedModels) {
      core.info(`Running review: ${currentModel} :: ${prompt.source}`);
      try {
        const result = invokeOpenCode(composeTaskPrompt([prompt]), currentModel, configPath, {
          homeDir,
          timeoutMinutes,
        });
        individualResults.push({ ...result, prompt: prompt.source });
        accountedResults.push(result);
        successfulModels.add(currentModel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${currentModel} :: ${prompt.source}: ${message}`);
        core.warning(`Review failed for ${currentModel} :: ${prompt.source}: ${message}`);
      }
    }
  }

  let reviewText = composeLabeledReviews(individualResults);
  if (fusionEnabled && individualResults.length > 0) {
    core.info(`Running fusion: ${fusionModel}`);
    try {
      const fusionResult = invokeOpenCode(
        composeFusionPrompt(individualResults),
        fusionModel,
        fusionConfigPath,
        {
          homeDir: fusionHomeDir,
          timeoutMinutes,
          disableTools: true,
        },
      );
      accountedResults.push(fusionResult);
      successfulModels.add(fusionModel);
      reviewText = fusionResult.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`fusion :: ${fusionModel}: ${message}`);
      core.warning(`Fusion failed for ${fusionModel}; using all successful individual reviews: ${message}`);
    }
  }

  if (individualResults.length === 0) {
    core.warning('All review invocations failed; no review output was generated.');
    setEmptyOutputs();
  } else {
    const costByModel: Record<string, number> = {};
    const tokensByModel: Record<string, { input: number; output: number }> = {};
    let totalCost = 0;
    const totalTokens = { input: 0, output: 0 };

    for (const result of accountedResults) {
      totalCost += result.cost;
      totalTokens.input += result.tokens.input;
      totalTokens.output += result.tokens.output;
      costByModel[result.model] = (costByModel[result.model] ?? 0) + result.cost;
      const modelTokens = tokensByModel[result.model] ?? { input: 0, output: 0 };
      modelTokens.input += result.tokens.input;
      modelTokens.output += result.tokens.output;
      tokensByModel[result.model] = modelTokens;
    }

    core.setOutput('review', reviewText);
    core.setOutput('models-used', [...successfulModels].join(','));
    core.setOutput('cost', totalCost);
    core.setOutput('cost-by-model', JSON.stringify(costByModel));
    core.setOutput('tokens', JSON.stringify(totalTokens));
    core.setOutput('tokens-by-model', JSON.stringify(tokensByModel));
  }

  if (failures.length > 0 && failOnError) {
    core.setFailed(`${failures.length} review operation(s) failed`);
  }
}

run();
