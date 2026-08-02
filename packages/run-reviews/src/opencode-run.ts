import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectTerminalText } from '@jander99/ai-review-review-contract';

export interface DebugCapturePaths {
  stdoutPath: string;
  stderrPath: string;
}

export interface RunOpenCodeRunOptions {
  prompt: string;
  model: string;
  configPath?: string;
  homeDir?: string;
  timeoutMinutes?: number;
  disableTools?: boolean;
  debugCapture?: DebugCapturePaths;
}

export interface RunOpenCodeRunResult {
  text: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
  };
  model: string;
  parts: ReadonlyArray<unknown>;
}

export interface OpenCodeRunRuntime {
  spawn: typeof childProcess.spawn;
}

interface OpenCodeEvent {
  type?: unknown;
  text?: unknown;
  part?: unknown;
  tokens?: unknown;
  cost?: unknown;
}

interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | string): boolean;
}

const EVENT_TYPES = new Set(['text', 'step_finish', 'step_use', 'tool_use', 'reasoning']);
const DEFAULT_TIMEOUT_MINUTES = 30;
const TEMP_DEBUG_PREFIX = 'ai-review-opencode-run-';

class LineBufferedWriter {
  private pending = '';
  private closed = false;

  private readonly fd: number;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(filePath, 'w', 0o600);
  }

  write(chunk: unknown): void {
    if (this.closed || chunk == null) {
      return;
    }

    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    this.pending += text;

    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex >= 0) {
      fs.writeSync(this.fd, this.pending.slice(0, newlineIndex + 1), undefined, 'utf8');
      this.pending = this.pending.slice(newlineIndex + 1);
      newlineIndex = this.pending.indexOf('\n');
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.pending) {
      fs.writeSync(this.fd, this.pending, undefined, 'utf8');
      this.pending = '';
    }
    fs.closeSync(this.fd);
  }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '<none>';
}

function diagnostics(stdoutPath: string, stderrPath: string): string {
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
  return `last stdout line: ${lastNonEmptyLine(stdout)}; last stderr line: ${lastNonEmptyLine(stderr)}`;
}

function normalizeEventType(type: unknown): string | null {
  if (typeof type !== 'string') {
    return null;
  }
  if (type === 'step-finish') {
    return 'step_finish';
  }
  return type;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePart(event: OpenCodeEvent, eventType: string): Record<string, unknown> {
  const eventPart = asRecord(event.part);
  const part = eventPart ? { ...eventPart } : { ...event };
  const partType = normalizeEventType(part.type) ?? eventType;
  part.type = partType === 'step_finish' ? 'step-finish' : partType;
  if (typeof part.text !== 'string' && typeof event.text === 'string') {
    part.text = event.text;
  }
  return part;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTokens(
  event: Record<string, unknown> | undefined,
  part: Record<string, unknown> | undefined,
): RunOpenCodeRunResult['tokens'] {
  const rawTokens = asRecord(event?.tokens) ?? asRecord(part?.tokens);
  const input = readNumber(rawTokens?.input) ?? 0;
  const output = readNumber(rawTokens?.output) ?? 0;
  const reasoning = readNumber(rawTokens?.reasoning);
  return reasoning === undefined ? { input, output } : { input, output, reasoning };
}

function buildEnvironment(options: RunOpenCodeRunOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('OPENCODE_')) {
      delete env[name];
    }
  }
  if (options.configPath) {
    env.OPENCODE_CONFIG = options.configPath;
  }
  if (options.homeDir) {
    fs.mkdirSync(options.homeDir, { recursive: true, mode: 0o700 });
    env.HOME = options.homeDir;
  }
  env.OPENCODE_PERMISSION = JSON.stringify({
    read: 'deny',
    glob: 'deny',
    grep: 'deny',
    list: 'deny',
    webfetch: 'deny',
    edit: 'deny',
    write: 'deny',
    question: 'deny',
    doom_loop: 'deny',
    bash: 'deny',
  });
  return env;
}

function commandArgs(model: string, prompt: string): string[] {
  return [
    `--model=${model}`,
    'run',
    '--format=json',
    '--',
    prompt,
  ];
}

function modelFromCommand(args: ReadonlyArray<string>): string {
  const modelArg = args.find((arg) => arg.startsWith('--model='));
  return modelArg ? modelArg.slice('--model='.length) : '';
}

function parseEvents(stdout: string, stdoutPath: string, stderrPath: string): RunOpenCodeRunResult {
  const parts: unknown[] = [];
  let finalStepFinish: { event: Record<string, unknown>; part: Record<string, unknown> } | undefined;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let parsed: OpenCodeEvent;
    try {
      parsed = JSON.parse(line) as OpenCodeEvent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`could not parse OpenCode JSON event: ${message}; ${diagnostics(stdoutPath, stderrPath)}`);
    }

    const eventType = normalizeEventType(parsed.type);
    const partRecord = asRecord(parsed.part);
    const partType = normalizeEventType(partRecord?.type);
    const filteredType = eventType ?? partType;
    if (!filteredType || !EVENT_TYPES.has(filteredType)) {
      continue;
    }

    const normalized = normalizePart(parsed, filteredType);
    parts.push(normalized);
    if (filteredType === 'step_finish') {
      finalStepFinish = {
        event: asRecord(parsed) ?? {},
        part: normalized,
      };
    }
  }

  const selection = selectTerminalText(parts);
  const finalEvent = finalStepFinish?.event;
  const finalPart = finalStepFinish?.part;
  const cost = readNumber(finalEvent?.cost) ?? readNumber(finalPart?.cost) ?? 0;
  const tokens = finalStepFinish ? readTokens(finalEvent, finalPart) : { input: 0, output: 0 };

  return {
    text: selection.text,
    cost,
    tokens,
    model: '',
    parts,
  };
}

function closeCapture(writer: LineBufferedWriter | null): void {
  writer?.close();
}

function waitForProcess(
  proc: SpawnedProcess,
  timeoutMs: number,
  getDiagnostics: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({ code, signal });
    };

    proc.on('error', (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`could not execute opencode run: ${message}; ${getDiagnostics()}`));
    });
    proc.on('close', (code: unknown, signal: unknown) => {
      finish(
        typeof code === 'number' ? code : null,
        typeof signal === 'string' ? signal as NodeJS.Signals : null,
      );
    });

    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // The process may have exited between the timeout and kill call.
      }
      const message = `opencode run timed out after ${timeoutMs} ms; ${getDiagnostics()}`;
      reject(new Error(message));
      settled = true;
      const killHandle = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Best-effort escalation only.
        }
      }, 3_000);
      killHandle.unref?.();
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
}

/**
 * Run OpenCode as a one-shot CLI process and consume its line-delimited JSON
 * stream after the process exits. This deliberately avoids `opencode serve`:
 * the server can accept connections before plugin installation has finished
 * and then block the CI event loop.
 */
export async function runOpenCodeRun(
  options: RunOpenCodeRunOptions,
  runtime?: OpenCodeRunRuntime,
): Promise<RunOpenCodeRunResult> {
  if (!options || typeof options !== 'object') {
    throw new Error('runOpenCodeRun requires an options object');
  }
  if (!options.prompt) {
    throw new Error('runOpenCodeRun requires options.prompt');
  }
  if (!options.model) {
    throw new Error('runOpenCodeRun requires options.model');
  }
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('runOpenCodeRun requires a positive options.timeoutMinutes');
  }

  const args = commandArgs(options.model, options.prompt);
  const model = modelFromCommand(args);
  const temporaryDebugDirectory = options.debugCapture
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DEBUG_PREFIX));
  const stdoutPath = options.debugCapture?.stdoutPath ?? path.join(temporaryDebugDirectory as string, 'stdout.jsonl');
  const stderrPath = options.debugCapture?.stderrPath ?? path.join(temporaryDebugDirectory as string, 'stderr.log');
  const stdoutWriter = new LineBufferedWriter(stdoutPath);
  const stderrWriter = new LineBufferedWriter(stderrPath);
  const getDiagnostics = (): string => diagnostics(stdoutPath, stderrPath);

  try {
    const env = buildEnvironment(options);
    let proc: SpawnedProcess;
    try {
      proc = (runtime?.spawn ?? childProcess.spawn)('opencode', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as SpawnedProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`could not execute opencode run: ${message}; ${getDiagnostics()}`);
    }

    proc.stdout?.on('data', (chunk: unknown) => stdoutWriter.write(chunk));
    proc.stderr?.on('data', (chunk: unknown) => stderrWriter.write(chunk));

    const exit = await waitForProcess(proc, timeoutMinutes * 60 * 1000, getDiagnostics);
    stdoutWriter.close();
    stderrWriter.close();

    const stdout = fs.readFileSync(stdoutPath, 'utf8');
    if (exit.code !== 0 || exit.signal) {
      throw new Error(
        `opencode run exited unsuccessfully${exit.code !== null ? ` with status ${exit.code}` : ` with signal ${exit.signal}`}; ${getDiagnostics()}`,
      );
    }

    const parsed = parseEvents(stdout, stdoutPath, stderrPath);
    parsed.model = model;
    return parsed;
  } finally {
    closeCapture(stdoutWriter);
    closeCapture(stderrWriter);
    if (temporaryDebugDirectory) {
      fs.rmSync(temporaryDebugDirectory, { recursive: true, force: true });
    }
  }
}
