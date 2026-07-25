import * as core from '@actions/core';
import { createHash } from 'crypto';
import * as fs from 'fs';
import type { IncomingMessage } from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';

const MAX_REDIRECTS = 5;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function getResponse(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'user-agent': 'ai-review-action/setup-opencode' } },
      resolve,
    );
    request.on('error', reject);
  });
}

async function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
  const response = await getResponse(url);
  const status = response.statusCode ?? 0;

  if (status >= 300 && status < 400 && response.headers.location) {
    response.resume();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`OpenCode download exceeded ${MAX_REDIRECTS} redirects`);
    }
    const redirectUrl = new URL(response.headers.location, url).toString();
    await downloadFile(redirectUrl, destination, redirects + 1);
    return;
  }

  if (status !== 200) {
    response.resume();
    throw new Error(`OpenCode download failed with HTTP status ${status}`);
  }

  await pipeline(response, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

function calculateSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => {
      hash.update(chunk);
    });
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function resolveInstallDirectory(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

async function run(): Promise<void> {
  let temporaryDirectory: string | undefined;
  let stagedBinary: string | undefined;

  try {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      throw new Error(
        `setup-opencode supports only linux-x64 runners; received ${process.platform}-${process.arch}`,
      );
    }

    const version = core.getInput('version') || '1.18.4';
    const expectedChecksum = core.getInput('checksum', { required: true }).toLowerCase();
    const installDirectory = resolveInstallDirectory(
      core.getInput('install-dir') || '~/.opencode',
    );

    if (!VERSION_PATTERN.test(version)) {
      throw new Error(`Invalid OpenCode version '${version}'`);
    }
    if (!CHECKSUM_PATTERN.test(expectedChecksum)) {
      throw new Error('checksum must be exactly 64 hexadecimal SHA-256 characters');
    }

    const downloadUrl =
      `https://github.com/sst/opencode/releases/download/v${version}/opencode-linux-x64`;
    const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir();
    fs.mkdirSync(temporaryRoot, { recursive: true });
    temporaryDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'setup-opencode-'));
    const downloadedBinary = path.join(temporaryDirectory, 'opencode.download');

    core.info(`Downloading OpenCode ${version} from ${downloadUrl}`);
    await downloadFile(downloadUrl, downloadedBinary);

    const actualChecksum = await calculateSha256(downloadedBinary);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `OpenCode checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`,
      );
    }

    fs.mkdirSync(installDirectory, { recursive: true, mode: 0o755 });
    const installedBinary = path.join(installDirectory, 'opencode');
    stagedBinary = path.join(
      installDirectory,
      `.opencode-${process.pid}-${Date.now().toString(36)}.tmp`,
    );
    fs.copyFileSync(downloadedBinary, stagedBinary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedBinary, 0o755);
    fs.renameSync(stagedBinary, installedBinary);
    stagedBinary = undefined;

    core.addPath(installDirectory);
    core.info(`Installed OpenCode ${version} at ${installedBinary}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Failed to install OpenCode: ${message}`);
  } finally {
    if (stagedBinary) {
      fs.rmSync(stagedBinary, { force: true });
    }
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

void run();
