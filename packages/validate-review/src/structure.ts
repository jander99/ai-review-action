// Deterministic structural validator for the review markdown.
//
// Phase 1 delegates the contract to the shared `review-contract` package
// so generation, extraction, deterministic validation, and fusion all
// agree on the same rules. This file is a thin wrapper that keeps the
// existing import path working for callers in `packages/validate-review`.

export {
  validateReviewDocument,
  type ValidationResult,
  type ParsedDocument,
  type ParsedFinding,
} from '@jander99/ai-review-review-contract';
