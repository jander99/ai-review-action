/**
 * JSON schema checking for model output.
 *
 * Adapters ask the provider for structured output, but "structured" is a
 * request, not a guarantee: the reply is re-checked here before it reaches
 * the pipeline.
 */

import Ajv from 'ajv';
import { LlmError } from './errors';
import type { JsonSchema } from './types';

const ajv = new Ajv({ allErrors: true, strict: false });

// One compiled validator per schema object identity: the schemas are module
// constants, so this compiles each of them once.
const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>();

function validatorFor(schema: JsonSchema): ReturnType<typeof ajv.compile> {
  const cached = compiled.get(schema);
  if (cached) {
    return cached;
  }
  const validate = ajv.compile(schema as object);
  compiled.set(schema, validate);
  return validate;
}

export function checkAgainstSchema(
  value: unknown,
  schema: JsonSchema,
): { ok: true } | { ok: false; errors: string } {
  const validate = validatorFor(schema);
  if (validate(value)) {
    return { ok: true };
  }
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
    .join('; ');
  return { ok: false, errors };
}

export function parseAndCheck(text: string, schema: JsonSchema, provider: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LlmError(
      'invalid_output',
      `${provider} returned non-JSON output`,
      provider,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
  const check = checkAgainstSchema(parsed, schema);
  if (!check.ok) {
    throw new LlmError(
      'invalid_output',
      `${provider} output does not match the expected schema`,
      provider,
      undefined,
      check.errors,
    );
  }
  return parsed;
}
