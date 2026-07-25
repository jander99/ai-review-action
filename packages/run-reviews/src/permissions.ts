import type { Permission } from './types';

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
