import type { Permission } from './types';

// The action writes the authoritative review markdown itself after
// capturing the model's reply. The model does not need to write any
// files, so `write` is intentionally not permitted. The other tool
// permissions stay in their Phase 1 defaults so the model can read the
// repository, inspect git history, and inspect OpenCode config files.
export const DEFAULT_PERMISSION: Permission = {
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  webfetch: 'allow',
  edit: 'ask',
  question: 'ask',
  doom_loop: 'ask',
  bash: 'allow',
};