import type { Permission } from './types';

// The review action's contract requires the model to write the review
// markdown to a runner-local file under RUNNER_TEMP. The model can use
// the `write` tool directly, so we permit it here. The `bash` and `read`
// tools are already permitted, so adding `write` is a small incremental
// concession that does not change the trust boundary.
export const DEFAULT_PERMISSION: Permission = {
  read: 'allow',
  write: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  webfetch: 'allow',
  edit: 'ask',
  question: 'ask',
  doom_loop: 'ask',
  bash: 'allow',
};
