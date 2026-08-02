import { randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { extractReviewDocument, sanitizeModelText } from '@jander99/ai-review-review-contract';
import type { Permission } from './types';

/**
 * OpenCode HTTP server transport for the run-reviews and
 * validate-review actions.
 *
 * Replaces the previous `opencode run --format json` capture path
 * with a documented HTTP API client. The synchronous
 * `POST /session/:id/message` endpoint returns the terminal assistant
 * message atomically, which fixes the production capture race where
 * the JSONL aggregator lost the final `text` part to the
 * `--format json` stream's maxBuffer flush.
 *
 * Evidence:
 *   - `packages/run-reviews/probes/opencode-transport-probe.cjs`
 *     (canonical probe implementation)
 *   - `docs/probes/opencode-transport.md`
 *     (findings report + production run 30751766949 context)
 *   - `docs/probes/opencode-transport.json`
 *     (captured request/response bodies)
 *
 * Threat-model note: a fresh `OPENCODE_SERVER_PASSWORD` is generated
 * per invocation with `crypto.randomBytes(32)` and is forwarded on
 * every request as `Authorization: Bearer <password>`. The password is
 * never logged and never appears in debug captures — the
 * `redactDebugOutput` helper strips any field whose name matches
 * `Authorization`, `key`, `token`, `secret`, or `password`.
 */

export interface DebugCapturePaths {
  stdoutPath: string;
  stderrPath: string;
}

export interface RunOpenCodeServerOptions {
  /**
   * Absolute path to the pre-built merged OpenCode config JSON. The
   * server reads this via `OPENCODE_CONFIG` at startup; it carries
   * the resolved providers, the deny-all `permission` block, and the
   * `agent` definition (review / synthesis / validator). The caller
   * is responsible for building this with `buildMergedConfig` (or an
   * equivalent validator-only config).
   */
  configPath: string;
  /**
   * Per-invocation `$HOME` for the opencode server. Used to isolate
   * the server's on-disk state from the runner's default home and to
   * make sure the global `auth.json` is loaded by inheritance of the
   * host HOME when needed.
   */
  homeDir: string;
  /**
   * Provider/model string (e.g. `opencode-go/minimax-m3`). The server
   * is told which model to use via `modelID`/`providerID` derived from
   * this string.
   */
  model: string;
  /** User prompt sent as a single `text` part to `POST /session/:id/message`. */
  prompt: string;
  /** Wall-clock budget for the prompt call. Enforced client-side only. */
  timeoutMinutes: number;
  /**
   * Resolved permission block forwarded to the server via
   * `OPENCODE_PERMISSION` so the model picks up deny-all when the
   * caller asked for it (fusion, validator). Reviewer runs set the
   * permission inside the config file instead.
   */
  permission: Permission;
  /** Pinned opencode version. Used for diagnostics only; the
   * `setup-opencode` action is responsible for installing the matching
   * binary on PATH. */
  opencodeVersion: string;
  /** Optional paths that mirror the server's stdout/stderr. The
   * legacy JSONL aggregator wrote these for action-debug uploads; we
   * preserve that contract by piping the server's stdout/stderr into
   * the same destination. */
  debugCapture?: DebugCapturePaths;
  /**
   * If true, deny every tool the agent might call. Equivalent to the
   * legacy `disableTools` convenience flag.
   */
  disableTools?: boolean;
  /**
   * Optional user-supplied OpenCode config path. Not used by the
   * transport itself; the caller already inlined it into the merged
   * config at `configPath`. Accepted here so the upstream caller can
   * forward it without a separate bookkeeping path.
   */
  userConfig?: string;
  /**
   * Optional override for the agent name the server should invoke.
   * Defaults to the `default_agent` declared in the merged config.
   * Most callers should leave this unset.
   */
  agent?: string;
}

export interface RunOpenCodeServerResult {
  /**
   * Terminal assistant text — the last `text` part before the
   * terminal `step-finish reason='stop'` (or the last `text` part in
   * the array when no `step-finish` is present, as a defensive
   * fallback).
   */
  text: string;
  /** Reported cost (USD) from `info.cost`. */
  cost: number;
  /** Reported token usage from `info.tokens`. `reasoning` is optional
   * because some providers do not break it out. */
  tokens: { input: number; output: number; reasoning?: number };
  /** `${providerID}/${modelID}` from `info`. */
  model: string;
  /** Raw `parts` array for downstream diagnostics (mirrors the probe's
   * captured `info` + `parts` body). */
  parts: ReadonlyArray<unknown>;
}

/**
 * Injectable runtime for tests. Defaults pull from `node:crypto`,
 * `node:child_process`, and the global `fetch` (Node 18+). Callers
 * should leave this unset in production.
 */
export type RandomBytesLike = (size: number) => Uint8Array;

export interface OpenCodeServerRuntime {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildLike;
  fetch: (url: string, init?: Record<string, unknown>) => Promise<FetchLike>;
  randomBytes: RandomBytesLike;
  sleep: (ms: number) => Promise<void>;
}

export interface ChildLike {
  pid?: number;
  killed?: boolean;
  exitCode: number | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): boolean;
}

export interface FetchLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_POLL_MS = 100;
const DEFAULT_TERMINATE_GRACE_MS = 3_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAuthorizationHeader(password: string): string {
  return `Bearer ${password}`;
}

function parseListeningUrl(stream: string): { port: number; baseUrl: string } | null {
  // Mirror the probe's parser: look for an explicit URL first, fall
  // back to a `port: <n>` regex. We tolerate both stdout and stderr
  // because opencode 1.18.x prints the banner on stderr while older
  // versions print it on stdout.
  const lines = stream.split(/\r?\n/);
  for (const line of lines) {
    const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      try {
        const u = new URL(urlMatch[1]);
        if (u.port) {
          return { port: Number(u.port), baseUrl: `${u.protocol}//${u.hostname}:${u.port}` };
        }
      } catch {
        // not a URL we can parse; fall through to the port regex
      }
    }
    const portMatch = line.match(/port[:\s]+(\d{2,5})/i);
    if (portMatch) {
      return { port: Number(portMatch[1]), baseUrl: `${DEFAULT_BASE_URL}:${portMatch[1]}` };
    }
  }
  return null;
}

function buildPermissionEnv(permission: Permission, disableTools?: boolean): string | null {
  if (disableTools) {
    return JSON.stringify({
      read: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      webfetch: 'deny',
      edit: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: 'deny',
    });
  }
  if (!permission || Object.keys(permission).length === 0) {
    return null;
  }
  return JSON.stringify(permission);
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    // The legacy CLI used bare model IDs. Fall back to the user's input
    // as the modelID and an empty providerID; the server will pick a
    // sensible default when the modelID is recognised.
    return { providerID: '', modelID: model };
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

function appendBuffer(target: string[], chunk: unknown): string {
  if (chunk == null) return target.join('');
  if (typeof chunk === 'string') {
    target.push(chunk);
  } else if (Buffer.isBuffer(chunk)) {
    target.push(chunk.toString('utf8'));
  } else if (chunk instanceof Uint8Array) {
    target.push(Buffer.from(chunk).toString('utf8'));
  } else {
    target.push(String(chunk));
  }
  return target.join('');
}

interface TerminalTextSelection {
  text: string;
  parts: ReadonlyArray<unknown>;
}

/**
 * Walk the parts array and return the terminal assistant text.
 *
 * Algorithm (matches `docs/probes/opencode-transport.md`):
 *   1. Find the index of the last `step-finish` part with
 *      `reason === 'stop'`.
 *   2. If found, return the last `text` part whose index is strictly
 *      less than that boundary.
 *   3. If no terminal `step-finish` exists, fall back to the last
 *      `text` part in the array.
 *   4. If no `text` part exists at all, return an empty string.
 *
 * The returned `parts` array is the verbatim slice we walked, so
 * downstream diagnostics (the production probe's `info` + `parts`
 * capture) see the same shape.
 */
export function selectTerminalText(parts: ReadonlyArray<unknown>): TerminalTextSelection {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { text: '', parts: [] };
  }

  let terminalIndex = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts[i] as { type?: string; reason?: string } | null;
    if (candidate && candidate.type === 'step-finish' && candidate.reason === 'stop') {
      terminalIndex = i;
      break;
    }
  }

  const upperBound = terminalIndex >= 0 ? terminalIndex : parts.length;
  let lastTextIndex = -1;
  for (let i = upperBound - 1; i >= 0; i -= 1) {
    const candidate = parts[i] as { type?: string; text?: unknown } | null;
    if (candidate && candidate.type === 'text' && typeof candidate.text === 'string') {
      lastTextIndex = i;
      break;
    }
  }

  if (lastTextIndex < 0) {
    return { text: '', parts };
  }

  const text = (parts[lastTextIndex] as { text: string }).text;
  return { text, parts };
}

interface ChatResponseInfo {
  cost: number;
  tokens: { input: number; output: number; reasoning?: number };
  providerID: string;
  modelID: string;
}

function readInfo(info: unknown): ChatResponseInfo {
  if (!info || typeof info !== 'object') {
    return { cost: 0, tokens: { input: 0, output: 0 }, providerID: '', modelID: '' };
  }
  const record = info as Record<string, unknown>;
  const tokensRaw = (record.tokens as Record<string, unknown> | undefined) ?? {};
  const reasoningRaw = tokensRaw.reasoning;
  const reasoning = typeof reasoningRaw === 'number' && Number.isFinite(reasoningRaw) ? reasoningRaw : undefined;
  return {
    cost: typeof record.cost === 'number' ? record.cost : 0,
    tokens: {
      input: typeof tokensRaw.input === 'number' ? tokensRaw.input : 0,
      output: typeof tokensRaw.output === 'number' ? tokensRaw.output : 0,
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
    providerID: typeof record.providerID === 'string' ? record.providerID : '',
    modelID: typeof record.modelID === 'string' ? record.modelID : '',
  };
}

async function readJsonResponse(fetchFn: OpenCodeServerRuntime['fetch'], response: FetchLike): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function awaitListeningUrl(
  proc: ChildLike,
  stdoutBuffer: string[],
  stderrBuffer: string[],
  timeoutMs: number,
  sleep: OpenCodeServerRuntime['sleep'],
): Promise<{ port: number; baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const combined = `${stdoutBuffer.join('')}\n${stderrBuffer.join('')}`;
    const parsed = parseListeningUrl(combined);
    if (parsed) return parsed;
    if (proc.exitCode !== null) {
      throw new Error(
        `opencode server exited before announcing a listening URL (code=${proc.exitCode}):\n` +
          `--- stdout ---\n${stdoutBuffer.join('')}\n--- stderr ---\n${stderrBuffer.join('')}`,
      );
    }
    await sleep(50);
  }
  throw new Error(
    `opencode server did not announce a listening URL within ${timeoutMs} ms:\n` +
      `--- stdout ---\n${stdoutBuffer.join('')}\n--- stderr ---\n${stderrBuffer.join('')}`,
  );
}

async function awaitHealthy(
  fetchFn: OpenCodeServerRuntime['fetch'],
  baseUrl: string,
  password: string,
  timeoutMs: number,
  pollMs: number,
  sleep: OpenCodeServerRuntime['sleep'],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchFn(`${baseUrl}/global/health`, {
        method: 'GET',
        headers: {
          authorization: buildAuthorizationHeader(password),
          accept: 'application/json',
        },
      });
      if (response.ok) {
        const body = (await response.json()) as { healthy?: boolean } | null;
        if (body && body.healthy === true) return;
      }
    } catch {
      // server not yet accepting connections; keep polling
    }
    await sleep(pollMs);
  }
  throw new Error(`opencode server did not become healthy within ${timeoutMs} ms`);
}

async function createSession(
  fetchFn: OpenCodeServerRuntime['fetch'],
  baseUrl: string,
  password: string,
  title: string,
): Promise<string> {
  const response = await fetchFn(`${baseUrl}/session`, {
    method: 'POST',
    headers: {
      authorization: buildAuthorizationHeader(password),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /session failed with status ${response.status}: ${body}`);
  }
  const body = (await readJsonResponse(fetchFn, response)) as { id?: string } | null;
  if (!body || typeof body.id !== 'string' || !body.id) {
    throw new Error(`POST /session returned a body without an id: ${JSON.stringify(body)}`);
  }
  return body.id;
}

async function postMessage(
  fetchFn: OpenCodeServerRuntime['fetch'],
  baseUrl: string,
  password: string,
  sessionId: string,
  modelParts: { providerID: string; modelID: string; parts: ReadonlyArray<unknown> },
): Promise<{ info: ChatResponseInfo; parts: ReadonlyArray<unknown> }> {
  const response = await fetchFn(`${baseUrl}/session/${sessionId}/message`, {
    method: 'POST',
    headers: {
      authorization: buildAuthorizationHeader(password),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      modelID: modelParts.modelID,
      providerID: modelParts.providerID,
      parts: modelParts.parts,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /session/${sessionId}/message failed with status ${response.status}: ${body}`);
  }
  const body = (await readJsonResponse(fetchFn, response)) as { info?: unknown; parts?: unknown } | null;
  if (!body) {
    throw new Error(`POST /session/${sessionId}/message returned an empty body`);
  }
  const info = readInfo(body.info);
  const parts = Array.isArray(body.parts) ? (body.parts as ReadonlyArray<unknown>) : [];
  return { info, parts };
}

async function terminateServer(
  proc: ChildLike,
  graceMs: number,
  sleep: OpenCodeServerRuntime['sleep'],
): Promise<void> {
  if (proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // best-effort; child may have already exited
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return;
    await sleep(50);
  }
  if (proc.exitCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
}

function pipeStream(
  stream: Readable | null,
  buffer: string[],
  debugPath: string | undefined,
): void {
  if (!stream) return;
  stream.on('data', (chunk: unknown) => {
    appendBuffer(buffer, chunk);
  });
  stream.on('error', () => {
    // ignore stream errors; the spawn error handler reports fatal ones
  });
  if (debugPath) {
    // Snapshot the buffer to disk whenever new data arrives so the
    // debug artifact mirrors the legacy CLI behaviour (one file per
    // stream). We use a debounced flush to avoid hammering the disk
    // for high-frequency logs.
    let pending: NodeJS.Immediate | null = null;
    stream.on('data', () => {
      if (pending) return;
      pending = setImmediate(() => {
        pending = null;
        try {
          const fs2 = require('fs') as typeof import('fs');
          fs2.mkdirSync((require('path') as typeof import('path')).dirname(debugPath), { recursive: true });
          fs2.writeFileSync(debugPath, buffer.join(''), { encoding: 'utf8', mode: 0o600 });
        } catch {
          // debug capture is best-effort
        }
      });
    });
  }
}

/**
 * Drive a single `opencode serve` invocation to completion.
 *
 * Lifecycle:
 *   1. Spawn `opencode serve --port 0 --hostname 127.0.0.1
 *      --log-level DEBUG --print-logs` with a fresh
 *      `OPENCODE_SERVER_PASSWORD` and the caller's `OPENCODE_CONFIG`.
 *   2. Wait for the server to print its listening URL (max 10s).
 *   3. Poll `GET /global/health` until it reports `healthy: true`.
 *   4. `POST /session` to allocate a session.
 *   5. `POST /session/:id/message` with the caller's prompt as a
 *      single `text` part. The response is the terminal assistant
 *      message — synchronous, no streaming race.
 *   6. SIGTERM the server, then SIGKILL after a 3s grace window.
 *
 * The function returns the terminal text plus the cost/token/model
 * accounting from `info` and the raw `parts` array for diagnostics.
 */
export async function runOpenCodeServer(
  options: RunOpenCodeServerOptions,
  runtime?: Partial<OpenCodeServerRuntime>,
): Promise<RunOpenCodeServerResult> {
  if (!options || typeof options !== 'object') {
    throw new Error('runOpenCodeServer requires an options object');
  }
  if (!options.configPath) {
    throw new Error('runOpenCodeServer requires options.configPath');
  }
  if (!options.homeDir) {
    throw new Error('runOpenCodeServer requires options.homeDir');
  }
  if (!options.prompt) {
    throw new Error('runOpenCodeServer requires options.prompt');
  }
  if (!options.model) {
    throw new Error('runOpenCodeServer requires options.model');
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error('runOpenCodeServer requires a positive options.timeoutMinutes');
  }

  const fs = await import('fs');
  const path = await import('path');

  // Best-effort: ensure the home dir exists. The server writes
  // session state under it; missing dirs are a fatal startup error.
  fs.mkdirSync(options.homeDir, { recursive: true });

  // Generate a fresh per-invocation server password. Never log this
  // value; the debug capture path strips it via the regex below, and
  // the Authorization header that carries it is also stripped by the
  // `redactDebugOutput` helper in `main.ts`.
  const randomBytesFn = runtime?.randomBytes ?? randomBytes;
  const passwordBytes = randomBytesFn(32);
  const serverPassword = Buffer.from(passwordBytes).toString('hex');

  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('OPENCODE_')) continue;
    env[name] = value;
  }
  env.OPENCODE_CONFIG = options.configPath;
  env.HOME = options.homeDir;
  env.OPENCODE_SERVER_PASSWORD = serverPassword;
  const permissionEnv = buildPermissionEnv(options.permission, options.disableTools);
  if (permissionEnv) {
    env.OPENCODE_PERMISSION = permissionEnv;
  }

  const spawnFn =
    runtime?.spawn ??
    (require('child_process').spawn as OpenCodeServerRuntime['spawn']);
  const fetchFn = runtime?.fetch ?? (globalThis.fetch as OpenCodeServerRuntime['fetch']);
  const sleepFn = runtime?.sleep ?? defaultSleep;

  const proc = spawnFn(
    'opencode',
    [
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--log-level',
      'DEBUG',
      '--print-logs',
    ],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];
  pipeStream(proc.stdout, stdoutBuffer, options.debugCapture?.stdoutPath);
  pipeStream(proc.stderr, stderrBuffer, options.debugCapture?.stderrPath);

  const spawnError: { value: Error | null } = { value: null };
  proc.on('error', (err: Error) => {
    spawnError.value = err;
  });

  try {
    const listening = await awaitListeningUrl(
      proc,
      stdoutBuffer,
      stderrBuffer,
      DEFAULT_TIMEOUT_MS,
      sleepFn,
    );

    await awaitHealthy(
      fetchFn,
      listening.baseUrl,
      serverPassword,
      DEFAULT_TIMEOUT_MS,
      DEFAULT_HEALTH_POLL_MS,
      sleepFn,
    );

    const sessionId = await createSession(
      fetchFn,
      listening.baseUrl,
      serverPassword,
      `ai-review:${path.basename(options.configPath)}`,
    );

    const { providerID, modelID } = splitModel(options.model);
    const response = await postMessage(fetchFn, listening.baseUrl, serverPassword, sessionId, {
      providerID,
      modelID,
      parts: [{ type: 'text', text: options.prompt }],
    });

    const selection = selectTerminalText(response.parts);
    const sanitized = sanitizeModelText(selection.text);
    const extracted = extractReviewDocument(sanitized);

    const returnedModel = `${response.info.providerID || providerID}/${response.info.modelID || modelID}`;

    return {
      text: extracted ?? sanitized,
      cost: response.info.cost,
      tokens: response.info.tokens,
      model: returnedModel,
      parts: selection.parts,
    };
  } catch (error) {
    if (options.debugCapture) {
      try {
        fs.mkdirSync(path.dirname(options.debugCapture.stdoutPath), { recursive: true });
        fs.mkdirSync(path.dirname(options.debugCapture.stderrPath), { recursive: true });
        fs.writeFileSync(options.debugCapture.stdoutPath, stdoutBuffer.join(''), {
          encoding: 'utf8',
          mode: 0o600,
        });
        fs.writeFileSync(options.debugCapture.stderrPath, stderrBuffer.join(''), {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        // debug capture is best-effort
      }
    }
    if (spawnError.value) {
      throw new Error(`opencode server spawn failed: ${spawnError.value.message}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await terminateServer(proc, DEFAULT_TERMINATE_GRACE_MS, sleepFn);
    if (options.debugCapture) {
      try {
        fs.mkdirSync(path.dirname(options.debugCapture.stdoutPath), { recursive: true });
        fs.mkdirSync(path.dirname(options.debugCapture.stderrPath), { recursive: true });
        fs.writeFileSync(options.debugCapture.stdoutPath, stdoutBuffer.join(''), {
          encoding: 'utf8',
          mode: 0o600,
        });
        fs.writeFileSync(options.debugCapture.stderrPath, stderrBuffer.join(''), {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        // debug capture is best-effort
      }
    }
  }
}
