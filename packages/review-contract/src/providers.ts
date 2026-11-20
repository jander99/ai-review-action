/**
 * Provider configuration shared by every LLM and decision adapter.
 *
 * Adapters receive this explicitly and never read `process.env`, so SDK
 * environment fallbacks cannot redirect requests.
 */

export interface ProviderConfig {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ProviderCapabilities {
  readonly supportsSeed: boolean;
  readonly maxInputTokens: number;
}

/**
 * Replace every occurrence of `secret` (only when it is long enough to be a
 * real secret) with `[REDACTED]`. Every adapter error message goes through it.
 */
export function redactSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('[REDACTED]');
}
