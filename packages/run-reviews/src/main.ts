import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';

function appendUniqueModel(models: string[], candidate: string): void {
  if (!models.includes(candidate)) {
    models.push(candidate);
  }
}

function isWithinWorkspace(filePath: string, workspace: string): boolean {
  try {
    const realFile = fs.realpathSync(filePath);
    const realWorkspace = fs.realpathSync(workspace);
    return realFile === realWorkspace || realFile.startsWith(`${realWorkspace}${path.sep}`);
  } catch {
    return false;
  }
}

(async () => {
  try {
    execSync('copilot --version', { stdio: 'pipe' });
  } catch {
    core.setFailed('copilot CLI not found');
    process.exit(1);
  }

  let noCustomFlag = '';
  try {
    const helpOut = execSync('copilot help', { stdio: 'pipe' }).toString();
    if (helpOut.includes('no-custom-instructions')) {
      noCustomFlag = '--no-custom-instructions';
    } else {
      core.warning('--no-custom-instructions flag not found; AGENTS.md injection protection unavailable');
    }
  } catch {
    // ignore
  }

  let yoloSupported = false;
  try {
    const helpOut = execSync('copilot help', { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    if (helpOut.includes('--yolo')) {
      yoloSupported = true;
    }
  } catch {
    // ignore
  }

  const allowAllTools = core.getInput('allow-all-tools') === 'true';
  const copilotToken = core.getInput('copilot-token');
  let toolFlags: string[];
  if (allowAllTools) {
    if (yoloSupported) {
      toolFlags = ['--yolo'];
    } else {
      core.warning('--yolo not supported; falling back to --allow-tool="shell(git:*)"');
      toolFlags = ['--allow-tool=shell(git:*)'];
    }
  } else {
    toolFlags = ['--allow-tool=shell(git:*)'];
  }

  const rawModels = core.getInput('models') || 'claude-sonnet-4.6';
  const modelsList = rawModels
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (modelsList.length === 0) {
    core.setFailed('No models specified');
    process.exit(1);
  }

  const actionPath = path.resolve(__dirname, '..');
  const workspaceRoot = path.resolve(process.env.GITHUB_WORKSPACE || '/github/workspace');
  const rawPrompts = core.getInput('prompts') || 'code-review';
  const promptFiles: string[] = [];

  for (const entry of rawPrompts.split(',').map((value) => value.trim()).filter(Boolean)) {
    const name = entry.replace(/\.md$/, '');
    const builtinPath = path.join(actionPath, 'prompts', `${name}.md`);
    if (fs.existsSync(builtinPath)) {
      promptFiles.push(builtinPath);
    } else {
      const resolved = path.resolve(workspaceRoot, entry);
      if (!isWithinWorkspace(resolved, workspaceRoot)) {
        core.warning(`prompt path '${entry}' is outside workspace`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        core.warning(`prompt '${entry}' is neither a built-in nor an existing file; skipping`);
        continue;
      }
      promptFiles.push(resolved);
    }
  }

  if (promptFiles.length === 0) {
    promptFiles.push(path.join(actionPath, 'prompts', 'code-review.md'));
  }

  let baseSha = process.env.GITHUB_BASE_SHA;
  if (!baseSha && process.env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      baseSha = event?.pull_request?.base?.sha;
    } catch {
      // ignore
    }
  }
  const baseRef = process.env.GITHUB_BASE_REF || 'main';
  const gitRef = baseSha || `origin/${baseRef}`;
  let prDiffLen = 0;
  try {
    const diff = execSync(`git diff ${gitRef}...HEAD`, { stdio: ['pipe', 'pipe', 'pipe'] });
    prDiffLen = diff.length;
  } catch {
    core.warning('git diff failed; check that fetch-depth: 0 is set in actions/checkout.');
  }

  const rawMin = core.getInput('min-prompt-length') || '50';
  const minLen = /^\d+$/.test(rawMin) ? parseInt(rawMin, 10) : 50;
  if (!/^\d+$/.test(rawMin)) {
    core.warning(`min-prompt-length '${rawMin}' is not a valid integer; using default 50.`);
  }

  if (prDiffLen < minLen) {
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
      core.info(
        `PR diff (${prDiffLen} chars) is below min-prompt-length (${minLen}); bypassing guard for workflow_dispatch event. Note: prompts referencing git diff may yield limited output.`,
      );
    } else {
      core.info(`PR diff (${prDiffLen} chars) is smaller than min-prompt-length (${minLen}); skipping review.`);
      core.setOutput('review', '');
      core.setOutput('models-used', '');
      process.exit(0);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  let lastReviewFile = '';
  const allReviewFiles: string[] = [];
  const succeededModels: string[] = [];

  process.on('exit', () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  for (const promptFile of promptFiles) {
    const promptSlug = path.basename(promptFile).replace(/\.md$/, '');
    const promptContent = fs.readFileSync(promptFile, 'utf8');

    for (const model of modelsList) {
      const outputFile = path.join(tmpDir, `review-${crypto.randomBytes(4).toString('hex')}.txt`);
      const modelSlug = model.replace(/\//g, '-');

      core.info(`Running review: model=${model} prompt=${promptSlug} output=${modelSlug}`);

      const args = ['-p', promptContent, '-s', '--no-ask-user', ...toolFlags, '--model', model];
      if (noCustomFlag) {
        args.push(noCustomFlag);
      }

      try {
        const result = spawnSync('copilot', args, {
          env: {
            ...process.env,
            COPILOT_AUTO_UPDATE: 'false',
            COPILOT_GITHUB_TOKEN: copilotToken,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 50 * 1024 * 1024,
          encoding: 'buffer',
        });
        if (result.error || result.status !== 0) {
          throw result.error || new Error(`exit ${result.status}`);
        }
        fs.writeFileSync(outputFile, result.stdout);
        appendUniqueModel(succeededModels, model);
        allReviewFiles.push(outputFile);
        lastReviewFile = outputFile;
      } catch {
        core.warning(`Review failed for model=${model} prompt=${promptSlug}`);
      }
    }
  }

  if (!lastReviewFile) {
    core.warning('All reviews failed; no output generated.');
    core.setOutput('review', '');
    core.setOutput('models-used', '');
    if (core.getInput('fail-on-error') === 'true') {
      core.setFailed('fail-on-error is true');
      process.exit(1);
    }
    process.exit(0);
  }

  if (core.getInput('fusion') === 'true' && succeededModels.length > 0) {
    const fusionInputFile = path.join(tmpDir, 'fusion-prompt.txt');
    const fusionOutputFile = path.join(tmpDir, 'fusion-output.txt');

    let fusionPrompt =
      'You are synthesizing multiple AI code reviews into one coherent review.\nDeduplicate findings, prioritize by severity, and write a clear summary.\n\n';
    for (const file of allReviewFiles) {
      fusionPrompt += `---\n${fs.readFileSync(file, 'utf8')}\n`;
    }
    fs.writeFileSync(fusionInputFile, fusionPrompt);

    const fusionModel = core.getInput('fusion-model') || modelsList[0];
    const fusionArgs = ['-p', fusionPrompt, '-s', '--no-ask-user', ...toolFlags, '--model', fusionModel];
    if (noCustomFlag) {
      fusionArgs.push(noCustomFlag);
    }

    try {
      const fusionResult = spawnSync('copilot', fusionArgs, {
        env: {
          ...process.env,
          COPILOT_AUTO_UPDATE: 'false',
          COPILOT_GITHUB_TOKEN: copilotToken,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'buffer',
      });
      if (fusionResult.error || fusionResult.status !== 0) {
        throw fusionResult.error || new Error(`exit ${fusionResult.status}`);
      }
      fs.writeFileSync(fusionOutputFile, fusionResult.stdout);
      lastReviewFile = fusionOutputFile;
    } catch {
      core.warning('Fusion pass failed; using last individual review.');
    }
  }

  const reviewText = fs.readFileSync(lastReviewFile, 'utf8');
  core.setOutput('review', reviewText);
  core.setOutput('models-used', succeededModels.join(','));
  core.exportVariable('REVIEW_FILE', lastReviewFile);
})();
