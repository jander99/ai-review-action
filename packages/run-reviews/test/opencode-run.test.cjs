'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const bundle = require('../dist-test/index.cjs');
const { runOpenCodeRun } = bundle;

const PROMPT = 'return the canonical review';
const MODEL = 'opencode-go/minimax-m3';

function makeProcess({ events = [], stderr = '', exitCode = 0 } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => true;

  setImmediate(() => {
    for (const event of events) {
      proc.stdout.write(`${JSON.stringify(event)}\n`);
    }
    if (stderr) {
      proc.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
    }
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', exitCode, null);
  });

  return proc;
}

function runWithEvents(events, overrides = {}) {
  const spawnCalls = [];
  const result = runOpenCodeRun(
    {
      prompt: PROMPT,
      model: MODEL,
      configPath: '/tmp/opencode-test.json',
      homeDir: '/tmp/opencode-test-home',
      timeoutMinutes: 1,
      ...overrides,
    },
    {
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return makeProcess(overrides.process ?? { events });
      },
    },
  );
  return { result, spawnCalls };
}

test('runOpenCodeRun returns terminal text after a successful process exit', async () => {
  const { result, spawnCalls } = runWithEvents([
    { type: 'text', part: { type: 'text', text: 'draft' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } },
    { type: 'text', part: { type: 'text', text: '# Review — title\n\n## Summary' } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 10, output: 4 },
        cost: 0.25,
      },
    },
  ]);
  const resultValue = await result;

  assert.equal(resultValue.text, '# Review — title\n\n## Summary');
  assert.equal(resultValue.model, MODEL);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'opencode');
  assert.deepEqual(spawnCalls[0].args, [
    `--model=${MODEL}`,
    'run',
    '--format=json',
    '--',
    PROMPT,
  ]);
});

test('runOpenCodeRun preserves a terminal document with Scope', async () => {
  const body = [
    '# Review — title',
    '',
    '## Scope',
    '- Reviewed X',
    '',
    '## Summary',
    '- New findings: 0',
    '- Unresolved from prior review: 0',
    '- Resolved by latest commits: 0',
  ].join('\n');
  const { result } = runWithEvents([
    { type: 'text', part: { type: 'text', text: body } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ]);

  const resultValue = await result;
  assert.equal(resultValue.text, body);
});
test('runOpenCodeRun reports stderr when the process exits non-zero', async () => {
  const { result } = runWithEvents([], {
    process: { events: [], stderr: 'plugin installation failed', exitCode: 7 },
  });

  await assert.rejects(result, (error) => {
    assert.match(error.message, /status 7/);
    assert.match(error.message, /plugin installation failed/);
    return true;
  });
});

test('runOpenCodeRun returns empty text when no text event is present', async () => {
  const { result } = runWithEvents([
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ]);

  const resultValue = await result;
  assert.equal(resultValue.text, '');
});

test('runOpenCodeRun respects the terminal step-finish boundary', async () => {
  const { result } = runWithEvents([
    { type: 'text', part: { type: 'text', text: 'before stop' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
    { type: 'text', part: { type: 'text', text: 'after stop' } },
  ]);

  const resultValue = await result;
  assert.equal(resultValue.text, 'before stop');
});

test('runOpenCodeRun extracts cost and tokens from the final step-finish event', async () => {
  const { result } = runWithEvents([
    {
      type: 'step_finish',
      part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 1, output: 2 }, cost: 0.01 },
    },
    { type: 'text', part: { type: 'text', text: 'final' } },
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 30, output: 12, reasoning: 5 },
        cost: 0.75,
      },
    },
  ]);

  const resultValue = await result;
  assert.deepEqual(resultValue.tokens, { input: 30, output: 12, reasoning: 5 });
  assert.equal(resultValue.cost, 0.75);
});
