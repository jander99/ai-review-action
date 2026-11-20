/**
 * Root action entrypoint (bundle).
 *
 * The orchestration lives in `./orchestrate`; this file only decides
 * whether the module is being executed as the action or imported as a
 * library, so importing the bundle in tests never triggers a run.
 */

import { run } from './orchestrate';

export * from './orchestrate';

if (require.main === module) {
  run();
}
