import type { DecideRequest, DecideResult } from './types';
import { DecisionError } from './errors';

/**
 * Verify every question got an answer of the matching type. A provider that
 * silently drops a question would otherwise surface as `undefined` deep in
 * the policy, so adapters call this before returning.
 */
export function assertAnswersComplete(req: DecideRequest, res: DecideResult, provider: string): void {
  for (const [id, question] of Object.entries(req.questions)) {
    const answer = res.answers[id];
    if (!answer || answer.type !== question.type) {
      throw new DecisionError('other', `missing or mistyped answer for question '${id}'`, provider);
    }
  }
}
