import { extractReviewDocument } from '@jander99/ai-review-review-contract';

export interface FusionReview {
  model: string;
  prompt: string;
  text: string;
}

export interface FusionOptions {
  /**
   * Per-review character cap applied to each labeled review payload
   * before assembly. Defaults to 50_000.
   */
  perReviewLimit?: number;
  /**
   * Total character cap for the *entire* prompt that will be sent to
   * the synthesis model. This includes the synthesis template prefix
   * and the review-data delimiter suffix, so the labeled payload is
   * internally budgeted to `max(0, totalLimit - prefix.length -
   * suffix.length)`. Defaults to 200_000.
   */
  totalLimit?: number;
}

const INJECTION_PATTERN =
  /ignore\s+(?:all|previous|prior)(?:\s+instructions)?|disregard\s+prior|you\s+are\s+now|system\s*:/i;
const REVIEW_SEPARATOR = '\n\n---\n\n';
const LABEL_LIMIT = 200;
const FUSION_PREFIX = '<BEGIN_REVIEW_DATA>\n';
const FUSION_SUFFIX = '\n<END_REVIEW_DATA>';

function fusionLabel(review: FusionReview): string {
  return `${review.model} :: ${review.prompt}`.slice(0, LABEL_LIMIT);
}

function fusionSection(review: FusionReview): string {
  return `## ${fusionLabel(review)}\n\n${review.text}`;
}

export function sanitizeForFusion(text: string): string {
  // Slice from the heading boundary (or use the raw text when no
  // heading exists) before fence-injection inspection so a model that
  // puts the heading inside a code fence does not get the fence (and
  // the heading inside it) stripped before we have a chance to use the
  // heading as an anchor.
  const extracted = extractReviewDocument(text);
  const anchored = extracted !== null ? extracted : text;
  return anchored.replace(/```[\s\S]*?```/g, (block: string) =>
    INJECTION_PATTERN.test(block) ? '' : block,
  );
}

export function composeLabeledReviews(reviews: FusionReview[]): string {
  return reviews.map(fusionSection).join(REVIEW_SEPARATOR);
}

export function truncateForFusion(
  reviews: FusionReview[],
  perReviewLimit = 50_000,
  payloadLimit = 200_000,
): FusionReview[] {
  const truncated: FusionReview[] = [];
  let remaining = payloadLimit;

  for (const review of reviews) {
    const separatorLength = truncated.length > 0 ? REVIEW_SEPARATOR.length : 0;
    const sectionPrefixLength = `## ${fusionLabel(review)}\n\n`.length;
    const availableText = remaining - separatorLength - sectionPrefixLength;
    if (availableText < 0) {
      break;
    }

    const text = review.text.slice(0, Math.min(perReviewLimit, availableText));
    truncated.push({ ...review, text });
    remaining -= separatorLength + sectionPrefixLength + text.length;
  }

  return truncated;
}

export function composeFusionPrompt(
  reviews: FusionReview[],
  synthesisPromptTemplate: string,
  options: FusionOptions = {},
): string {
  const totalLimit = options.totalLimit ?? 200_000;
  // Reserve the prefix/suffix overhead so callers can reason about the
  // total prompt size in one number rather than having to pre-compute
  // the labeled-payload cap themselves.
  const payloadLimit = Math.max(0, totalLimit - FUSION_PREFIX.length - FUSION_SUFFIX.length);
  const sanitized = reviews.map((review) => ({
    ...review,
    text: sanitizeForFusion(review.text),
  }));
  const truncated = truncateForFusion(sanitized, options.perReviewLimit ?? 50_000, payloadLimit);
  const labeledPayload = composeLabeledReviews(truncated);

  return synthesisPromptTemplate.replace(
    '__REVIEW_DATA__',
    `${FUSION_PREFIX}${labeledPayload}${FUSION_SUFFIX}`,
  );
}
