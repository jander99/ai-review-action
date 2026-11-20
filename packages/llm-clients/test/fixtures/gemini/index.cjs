// Gemini fixtures. Shapes follow generateContent.

const ok = {
  candidates: [
    { content: { role: 'model', parts: [{ text: '{"answer":"yes"}' }] }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
};

const okWrongShape = {
  ...ok,
  candidates: [{ content: { role: 'model', parts: [{ text: '{"answer":1}' }] }, finishReason: 'STOP' }],
};

const okNotJson = {
  ...ok,
  candidates: [{ content: { role: 'model', parts: [{ text: 'not json' }] }, finishReason: 'STOP' }],
};

const refusal = {
  promptFeedback: { blockReason: 'SAFETY' },
  candidates: [],
  usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 },
};

module.exports = { ok, okWrongShape, okNotJson, refusal };
