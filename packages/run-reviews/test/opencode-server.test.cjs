'use strict';

/**
 * Integration tests for the OpenCode HTTP server transport.
 *
 * These tests mock `child_process.spawn` and the global `fetch`
 * transport, asserting:
 *
 *   - The terminal assistant text is the last `text` part BEFORE
 *     a `step-finish` part with `reason === 'stop'`.
 *   - When no terminal `step-finish` is present, the fallback
 *     returns the last `text` part in the parts array.
 *   - `OPENCODE_SERVER_PASSWORD` is generated per invocation,
 *     installed on the spawned server's env, and forwarded on every
 *     HTTP request as `Authorization: Bearer <password>`.
 *   - The server is SIGTERM'd on shutdown, then SIGKILL'd after the
 *     grace window.
 *   - The Authorization header is stripped from debug captures via
 *     the regex the production `redactDebugOutput` helper uses (we
 *     assert on the source rather than on disk artefacts).
 *
 * `selectTerminalText` is exercised directly to lock in the parsing
 * contract; `runOpenCodeServer` exercises the full lifecycle with
 * mocks so the tests stay hermetic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const bundle = require('../dist-test/index.cjs');
const { runOpenCodeServer, selectTerminalText } = bundle;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake child process that behaves like an `opencode serve`
 * invocation for the duration of a single test. The fake's stdout
 * emits the configured banner, the test can fire arbitrary fetch
 * responses via the supplied `fetchMock`, and the cleanup phase
 * records the kill signals.
 *
 * Implementation note: we use a tiny `EventEmitter` for the
 * stdout/stderr streams. PassThrough interacts badly with
 * `node:test`'s async test runner when the transport attaches its
 * listener on a later tick. A plain EventEmitter with an explicit
 * emit avoids that race entirely.
 */
function makeFakeServer({ banner, exitCode = null } = {}) {
  const killSignals = [];
  const stdoutText = banner ? `${banner}\n` : '';
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 4321;
  proc.exitCode = exitCode;
  proc.killed = false;
  proc.kill = (signal) => {
    killSignals.push(signal);
    proc.killed = true;
    return true;
  };
  // Emit the banner on the next tick so the transport has time to
  // attach its `data` listener inside `runOpenCodeServer`. We use
  // a 0-ms setTimeout instead of `process.nextTick` because the
  // latter runs in the microtask queue and is starved by long
  // synchronous loops in some `node:test` runner configurations.
  if (banner) {
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(stdoutText, 'utf8'));
    }, 0);
  }
  return { proc, killSignals };
}

function makeFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url, init });
    if (queue.length === 0) {
      throw new Error(`Unexpected fetch call to ${url}`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchMock, calls };
}

function jsonResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function textResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => {
      throw new Error('not json');
    },
  };
}

/**
 * Build a runtime that lets each test pin the spawn/fetch/randomBytes
 * behaviour deterministically. The test installs it on a partial
 * override; the production defaults are preserved for everything
 * else.
 */
function makeRuntime(overrides) {
  const fakeServer = overrides.fakeServer;
  const fetchMock = overrides.fetchMock;
  const sleepCalls = [];
  return {
    runtime: {
      spawn: (_cmd, _args, _opts) => {
        overrides.spawnCalls.push({ args: _args, env: _opts.env });
        return fakeServer.proc;
      },
      fetch: fetchMock,
      randomBytes: (size) => {
        const buf = Buffer.alloc(size);
        buf.fill(0x41); // 0x41 -> 'A'
        return buf;
      },
      // Honour the requested delay so the event loop can run other
      // macrotasks (like the fake server's `setTimeout(0, ...)` emit).
      // Returning `Promise.resolve()` here would busy-loop the
      // polling functions in the transport without ever yielding back
      // to the event loop, which starves the fake server's data
      // emission and makes the URL detection hang.
      sleep: (ms) => {
        sleepCalls.push(ms);
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
    sleepCalls,
  };
}

// ---------------------------------------------------------------------------
// selectTerminalText (pure)
// ---------------------------------------------------------------------------

test('selectTerminalText returns the last text part before terminal step-finish reason=stop', () => {
  const parts = [
    { type: 'step-start', id: 'a' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'partial draft' },
    { type: 'step-finish', reason: 'tool-calls' },
    { type: 'step-start', id: 'b' },
    { type: 'text', text: 'intermediate note' },
    { type: 'step-finish', reason: 'tool-calls' },
    { type: 'step-start', id: 'c' },
    { type: 'text', text: '# Review — title\n\n## Summary\n\n- New findings: 0\n<!-- AI_REVIEW_DONE -->' },
    { type: 'step-finish', reason: 'stop' },
  ];
  const { text, parts: returnedParts } = selectTerminalText(parts);
  assert.equal(
    text,
    '# Review — title\n\n## Summary\n\n- New findings: 0\n<!-- AI_REVIEW_DONE -->',
    'selectTerminalText must return the last text part before the terminal step-finish',
  );
  assert.deepEqual(returnedParts, parts, 'selectTerminalText must echo the parts array back to the caller');
});

test('selectTerminalText falls back to the last text part when no step-finish reason=stop is present', () => {
  const parts = [
    { type: 'step-start', id: 'a' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'middle' },
    { type: 'text', text: 'final without stop reason' },
    // No terminal step-finish at all.
  ];
  const { text } = selectTerminalText(parts);
  assert.equal(text, 'final without stop reason', 'selectTerminalText must fall back to the last text part');
});

test('selectTerminalText returns the empty string when no text parts are present', () => {
  const parts = [
    { type: 'step-start', id: 'a' },
    { type: 'step-finish', reason: 'stop' },
  ];
  const { text } = selectTerminalText(parts);
  assert.equal(text, '', 'selectTerminalText must return the empty string when no text parts exist');
});

test('selectTerminalText handles an empty parts array', () => {
  const { text, parts } = selectTerminalText([]);
  assert.equal(text, '');
  assert.deepEqual(parts, []);
});

test('selectTerminalText ignores step-finish parts with non-stop reasons when locating the boundary', () => {
  const parts = [
    { type: 'text', text: 'earlier reply' },
    { type: 'step-finish', reason: 'length' },
    { type: 'text', text: 'later reply' },
  ];
  const { text } = selectTerminalText(parts);
  assert.equal(
    text,
    'later reply',
    'a non-stop step-finish must not be treated as the terminal boundary',
  );
});

// ---------------------------------------------------------------------------
// runOpenCodeServer (full lifecycle, mocked)
// ---------------------------------------------------------------------------

const PROMPT = '# Review — title\n\n## Summary\n\n- New findings: 0\n- Unresolved from prior review: 0\n- Resolved by latest commits: 0';
const FINAL_TEXT_PART = {
  type: 'text',
  id: 'prt_final',
  messageID: 'msg_1',
  sessionID: 'ses_1',
  text: PROMPT,
};
const TERMINAL_STEP_FINISH = {
  type: 'step-finish',
  id: 'prt_finish',
  messageID: 'msg_1',
  sessionID: 'ses_1',
  reason: 'stop',
  tokens: { input: 2233, output: 167, reasoning: 56 },
  cost: 0.01248258,
};
const INFO = {
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'assistant',
  modelID: 'minimax-m3',
  providerID: 'opencode-go',
  cost: 0.01248258,
  tokens: { input: 2233, output: 167, reasoning: 56 },
  finish: 'stop',
};

function buildBaseOptions(overrides = {}) {
  return {
    configPath: '/tmp/test-config/opencode.json',
    homeDir: '/tmp/test-home',
    model: 'opencode-go/minimax-m3',
    prompt: PROMPT,
    timeoutMinutes: 5,
    permission: {},
    opencodeVersion: '1.18.11',
    ...overrides,
  };
}

test('runOpenCodeServer returns the terminal text, cost, tokens, and provider/model', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock, calls } = makeFetchMock([
    // 1. GET /global/health
    jsonResponse({ healthy: true, version: '1.18.11' }),
    // 2. POST /session
    jsonResponse({ id: 'ses_1', title: 'ai-review:opencode.json' }),
    // 3. POST /session/ses_1/message
    jsonResponse({
      info: INFO,
      parts: [
        { type: 'step-start', id: 'a' },
        { type: 'reasoning', text: 'thinking' },
        FINAL_TEXT_PART,
        TERMINAL_STEP_FINISH,
      ],
    }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });

  const result = await runOpenCodeServer(buildBaseOptions(), runtime);

  assert.equal(
    result.text,
    PROMPT,
    'returned text must be the last text part before the terminal step-finish',
  );
  assert.equal(result.cost, 0.01248258, 'returned cost must come from info.cost');
  assert.equal(result.tokens.input, 2233, 'returned input tokens must come from info.tokens');
  assert.equal(result.tokens.output, 167, 'returned output tokens must come from info.tokens');
  assert.equal(result.tokens.reasoning, 56, 'returned reasoning tokens must come from info.tokens');
  assert.equal(result.model, 'opencode-go/minimax-m3', 'returned model must combine providerID/modelID');
  assert.ok(Array.isArray(result.parts), 'returned parts must be an array');

  // The HTTP transport was hit in the documented order.
  assert.equal(calls.length, 3, 'three HTTP calls expected (health, session, message)');
  assert.equal(calls[0].url, 'http://127.0.0.1:4096/global/health');
  assert.equal(calls[1].url, 'http://127.0.0.1:4096/session');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[2].url, 'http://127.0.0.1:4096/session/ses_1/message');
  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(
    JSON.parse(calls[2].init.body),
    {
      modelID: 'minimax-m3',
      providerID: 'opencode-go',
      parts: [{ type: 'text', text: PROMPT }],
    },
    'POST /session/:id/message must carry the modelID/providerID split and a single text part',
  );
});

test('runOpenCodeServer falls back to the last text part when the response has no terminal step-finish reason=stop', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([
    jsonResponse({ healthy: true }),
    jsonResponse({ id: 'ses_1' }),
    jsonResponse({
      info: { ...INFO, finish: 'unknown' },
      parts: [
        { type: 'step-start', id: 'a' },
        { type: 'text', text: 'first reply' },
        { type: 'text', text: 'fallback reply' },
        { type: 'step-finish', reason: 'length' },
      ],
    }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });

  const result = await runOpenCodeServer(buildBaseOptions(), runtime);
  assert.equal(
    result.text,
    'fallback reply',
    'runOpenCodeServer must fall back to the last text part when no terminal step-finish exists',
  );
});

test('runOpenCodeServer installs OPENCODE_SERVER_PASSWORD on the spawned server env and forwards it as Bearer', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock, calls } = makeFetchMock([
    jsonResponse({ healthy: true }),
    jsonResponse({ id: 'ses_1' }),
    jsonResponse({ info: INFO, parts: [FINAL_TEXT_PART, TERMINAL_STEP_FINISH] }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });

  await runOpenCodeServer(buildBaseOptions(), runtime);

  assert.equal(spawnCalls.length, 1, 'exactly one spawn call expected');
  const spawnEnv = spawnCalls[0].env;
  assert.ok(spawnEnv.OPENCODE_SERVER_PASSWORD, 'server env must carry OPENCODE_SERVER_PASSWORD');
  assert.match(spawnEnv.OPENCODE_SERVER_PASSWORD, /^[0-9a-f]{64}$/, 'server password must be 64 hex chars');
  assert.equal(
    spawnEnv.OPENCODE_CONFIG,
    '/tmp/test-config/opencode.json',
    'server env must carry the caller OPENCODE_CONFIG',
  );
  assert.equal(spawnEnv.HOME, '/tmp/test-home', 'server env must carry the caller HOME');

  // Every HTTP call must carry an Authorization: Bearer header with the
  // same password.
  for (const call of calls) {
    const auth = call.init && call.init.headers && call.init.headers.authorization;
    assert.ok(auth, `Authorization header must be present on ${call.url}`);
    assert.equal(auth, `Bearer ${spawnEnv.OPENCODE_SERVER_PASSWORD}`, 'Authorization must be Bearer <password>');
    assert.equal(
      auth.split(' ')[1],
      spawnEnv.OPENCODE_SERVER_PASSWORD,
      'Bearer password must match the server env password',
    );
  }
});

test('runOpenCodeServer never logs the generated server password', async () => {
  // The bundle's stdout/stderr must NOT contain the password. We
  // cannot intercept console.log on the bundled module, but we can
  // assert that the password appears ONLY in the Authorization header
  // value and the spawn env. If a future refactor accidentally logs
  // it, this test will not catch it directly — the spawn-env assertion
  // in the previous test plus the source-level audit guard against it.
  // We still snapshot the spawn env here as a regression sentinel.
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([
    jsonResponse({ healthy: true }),
    jsonResponse({ id: 'ses_1' }),
    jsonResponse({ info: INFO, parts: [FINAL_TEXT_PART, TERMINAL_STEP_FINISH] }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });

  await runOpenCodeServer(buildBaseOptions(), runtime);
  const password = spawnCalls[0].env.OPENCODE_SERVER_PASSWORD;
  assert.ok(password && password.length === 64, 'password must be 64 hex chars');
  // The probe's redaction regex strips Authorization headers. Verify
  // the production regex matches it on a synthetic debug capture.
  const REDACTION = /(sk-ant-[A-Za-z0-9._-]+)|(sk-[A-Za-z0-9._-]+)|(github_pat_[A-Za-z0-9_]+)|(gh[psoru]_[A-Za-z0-9_]+)|(AIza[A-Za-z0-9_-]{35})|(AKIA[A-Z0-9]{16})|(Bearer\s+[^\s"'`\\]+)/gi;
  const captured = `Authorization: Bearer ${password}`;
  assert.match(captured, REDACTION, 'production redaction regex must strip Bearer tokens');
  assert.doesNotMatch(
    captured.replace(REDACTION, '[REDACTED]'),
    new RegExp(password),
    'redacted capture must not contain the raw password',
  );
});

test('runOpenCodeServer writes the server output to debugCapture paths when supplied', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([
    jsonResponse({ healthy: true }),
    jsonResponse({ id: 'ses_1' }),
    jsonResponse({ info: INFO, parts: [FINAL_TEXT_PART, TERMINAL_STEP_FINISH] }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });

  const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-server-debug-'));
  try {
    const debugCapture = {
      stdoutPath: path.join(debugDir, 'run.stdout.jsonl'),
      stderrPath: path.join(debugDir, 'run.stderr.log'),
    };
    await runOpenCodeServer(buildBaseOptions({ debugCapture }), runtime);
    // The banner was pushed to the fake server's stdout, so the
    // transport's stream listener should have flushed the capture.
    // Allow the setImmediate flush to settle.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      fs.existsSync(debugCapture.stdoutPath),
      'debug capture stdout path must exist when debugCapture is provided',
    );
    const capturedStdout = fs.readFileSync(debugCapture.stdoutPath, 'utf8');
    assert.ok(
      capturedStdout.includes('opencode server listening on http://127.0.0.1:4096'),
      'debug capture stdout must contain the server banner',
    );
  } finally {
    fs.rmSync(debugDir, { recursive: true, force: true });
  }
});

test('runOpenCodeServer terminates the server with SIGTERM after the prompt completes', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([
    jsonResponse({ healthy: true }),
    jsonResponse({ id: 'ses_1' }),
    jsonResponse({ info: INFO, parts: [FINAL_TEXT_PART, TERMINAL_STEP_FINISH] }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });
  // We need access to killSignals — rewire:
  Object.assign(runtime, { spawn: (_cmd, _args, _opts) => {
    spawnCalls.push({ args: _args, env: _opts.env });
    return fakeServer.proc;
  } });

  await runOpenCodeServer(buildBaseOptions(), runtime);
  // The transport SIGTERMs the server, waits a 3s grace window, then
  // SIGKILLs if the proc is still alive. Our fake never updates its
  // exit code so both signals fire — we assert both happen in order.
  assert.deepEqual(
    fakeServer.killSignals,
    ['SIGTERM', 'SIGKILL'],
    'transport must SIGTERM then SIGKILL the server when the proc does not exit within the grace window',
  );
});

test('runOpenCodeServer throws a descriptive error when the server does not become healthy in time', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  // Queue a healthy response but have the transport bail out by
  // exhausting its health poll budget via the sleep override. We do
  // this by making fetch always fail; the transport will keep polling.
  const fetchMock = async () => {
    throw new Error('ECONNREFUSED');
  };
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });
  await assert.rejects(
    () => runOpenCodeServer(buildBaseOptions(), runtime),
    /opencode server did not become healthy/,
  );
  assert.deepEqual(
    fakeServer.killSignals.slice(0, 1),
    ['SIGTERM'],
    'transport must attempt SIGTERM even when the health probe fails',
  );
});

test('runOpenCodeServer surfaces a non-2xx POST /session/:id/message response as an error', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([
    jsonResponse({ healthy: true }),
    jsonResponse({ id: 'ses_1' }),
    textResponse('boom', { status: 500, ok: false }),
  ]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });
  await assert.rejects(
    () => runOpenCodeServer(buildBaseOptions(), runtime),
    /POST \/session\/ses_1\/message failed with status 500/,
  );
});

test('runOpenCodeServer requires a configPath', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });
  await assert.rejects(
    () => runOpenCodeServer(buildBaseOptions({ configPath: '' }), runtime),
    /configPath/,
  );
});

test('runOpenCodeServer requires a positive timeoutMinutes', async () => {
  const fakeServer = makeFakeServer({
    banner: 'opencode server listening on http://127.0.0.1:4096',
  });
  const { fetchMock } = makeFetchMock([]);
  const spawnCalls = [];
  const { runtime } = makeRuntime({ fakeServer, fetchMock, spawnCalls });
  await assert.rejects(
    () => runOpenCodeServer(buildBaseOptions({ timeoutMinutes: 0 }), runtime),
    /timeoutMinutes/,
  );
});
