/**
 * Public API surface of `setup-opencode`. Re-exports the
 * `installOpenCode` programmatic API so the root bundle (or tests)
 * can require the package as a library without triggering the
 * standalone action entrypoint.
 */

export { installOpenCode } from './main';
export type { InstallOpenCodeOptions, InstallOpenCodeResult } from './main';