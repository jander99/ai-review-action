/**
 * Repository-root action entrypoint.
 *
 * This file is the entrypoint for the repository-root `action.yml`'s
 * `main: dist/main.cjs`. Like `./main`, it is a thin wrapper: the
 * orchestration lives in `./orchestrate`, and this file only decides
 * whether the module is executed as the action or imported as a library.
 *
 * The repo-root `dist/main.cjs` is produced by esbuild from this file.
 * It exists so consumers can reference `owner/repo@v1` without
 * needing to know about the `packages/` subdirectory.
 */

import { run } from './orchestrate';

export * from './orchestrate';

if (require.main === module) {
  run();
}
