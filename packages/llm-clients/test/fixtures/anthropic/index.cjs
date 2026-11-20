// Anthropic response fixtures. Shapes follow the Messages API.

const ok = {
  id: 'msg_ok',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: '{"answer":"yes"}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 5 },
};

const okWrongShape = {
  ...ok,
  content: [{ type: 'text', text: '{"answer":1}' }],
};

const okNotJson = {
  ...ok,
  content: [{ type: 'text', text: 'not json' }],
};

const refusal = {
  ...ok,
  content: [],
  stop_reason: 'refusal',
};

module.exports = { ok, okWrongShape, okNotJson, refusal };
