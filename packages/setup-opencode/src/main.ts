import { spawnSync } from 'child_process';
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

export interface InstallOpenCodeOptions {
  version: string;
  checksum: string;
  installDirectory: string;
}

export interface InstallOpenCodeResult {
  version: string;
  installDirectory: string;
  installedBinary: string;
}

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

/**
 * Programmatic OpenCode installer. Pure API: no `core` calls, no
 * IIFE. The standalone action wrapper lives in `./action.ts` and
 * gates its top-level entrypoint on `require.main === module`.
 *
 * Returns the installed binary path and version. Callers are
 * responsible for updating PATH (the action wrapper does this via
 * `core.addPath`).
 */
export async function installOpenCode(options: InstallOpenCodeOptions): Promise<InstallOpenCodeResult> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `setup-opencode supports only linux-x64 runners; received ${process.platform}-${process.arch}`,
    );
  }
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(`Invalid OpenCode version '${options.version}'`);
  }
  const expectedChecksum = options.checksum.toLowerCase();
  if (!CHECKSUM_PATTERN.test(expectedChecksum)) {
    throw new Error('checksum must be exactly 64 hexadecimal SHA-256 characters');
  }

  const installDirectory = resolveInstallDirectory(options.installDirectory);
  const assetName = 'opencode-linux-x64.tar.gz';
  const downloadUrl =
    `https://github.com/anomalyco/opencode/releases/download/v${options.version}/${assetName}`;
  const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'setup-opencode-'));
  const downloadedArchive = path.join(temporaryDirectory, assetName);

  await downloadFile(downloadUrl, downloadedArchive);

  const actualChecksum = await calculateSha256(downloadedArchive);
  if (actualChecksum !== expectedChecksum) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(
      `OpenCode checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`,
    );
  }

  const extractionDirectory = path.join(temporaryDirectory, 'extracted');
  fs.mkdirSync(extractionDirectory, { mode: 0o700 });
  const extraction = spawnSync(
    'tar',
    ['-xzf', downloadedArchive, '-C', extractionDirectory],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (extraction.error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(`Could not extract OpenCode archive: ${extraction.error.message}`);
  }
  if (extraction.status !== 0) {
    const stderr = typeof extraction.stderr === 'string' ? extraction.stderr.trim() : '';
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(
      `OpenCode archive extraction failed with status ${extraction.status}${stderr ? `: ${stderr}` : ''}`,
    );
  }

  const extractedBinary = path.join(extractionDirectory, 'opencode');
  if (!fs.existsSync(extractedBinary) || !fs.statSync(extractedBinary).isFile()) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error("OpenCode archive did not contain the expected 'opencode' binary");
  }

  fs.mkdirSync(installDirectory, { recursive: true, mode: 0o755 });
  const installedBinary = path.join(installDirectory, 'opencode');
  let stagedBinary: string | undefined = path.join(
    installDirectory,
    `.opencode-${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  try {
    fs.copyFileSync(extractedBinary, stagedBinary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedBinary, 0o755);
    fs.renameSync(stagedBinary, installedBinary);
    stagedBinary = undefined;
  } finally {
    if (stagedBinary) {
      fs.rmSync(stagedBinary, { force: true });
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  return {
    version: options.version,
    installDirectory,
    installedBinary,
  };
}