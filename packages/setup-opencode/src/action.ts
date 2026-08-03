import * as core from '@actions/core';
import { installOpenCode, type InstallOpenCodeOptions, type InstallOpenCodeResult } from './main';

const DEFAULT_VERSION = '1.18.4';
const DEFAULT_INSTALL_DIR = '~/.opencode';

function buildOptionsFromCore(): InstallOpenCodeOptions {
  return {
    version: core.getInput('version') || DEFAULT_VERSION,
    checksum: core.getInput('checksum', { required: true }).toLowerCase(),
    installDirectory: core.getInput('install-dir') || DEFAULT_INSTALL_DIR,
  };
}

function writeOutputs(_result: InstallOpenCodeResult): void {
  // setup-opencode exposes no outputs of its own; the workflow
  // observes the installed binary via PATH side-effects.
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  core.info(`Downloading OpenCode ${options.version}`);
  const result = await installOpenCode(options);
  core.addPath(result.installDirectory);
  core.info(`Installed OpenCode ${result.version} at ${result.installedBinary}`);
  writeOutputs(result);
}

if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Failed to install OpenCode: ${message}`);
  });
}