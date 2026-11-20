// OpenAI response fixtures. Shapes follow the Responses API.

const ok = {
  id: 'resp_ok',
  object: 'response',
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":"yes"}' }] },
  ],
  output_text: '{"answer":"yes"}',
  usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
};

const okWrongShape = {
  ...ok,
  output_text: '{"answer":1}',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":1}' }] }],
};

const okNotJson = {
  ...ok,
  output_text: 'not json',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not json' }] }],
};

const refusal = {
  id: 'resp_refusal',
  object: 'response',
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
  ],
  output_text: '',
  usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
};

module.exports = { ok, okWrongShape, okNotJson, refusal };
