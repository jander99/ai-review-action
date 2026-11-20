export interface PromptEntry {
  type: 'file' | 'text';
  source: string;
  content: string;
}

export interface EventContext {
  eventName: string;
  repository?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  baseRef?: string;
  headRef?: string;
  baseSha?: string;
  headSha?: string;
  ref?: string;
  before?: string;
  after?: string;
  inputs?: Record<string, unknown>;
  /**
   * Runner-local path the review markdown may be written to. Optional:
   * the model is not required to use it, but it is a stable, ephemeral
   * location local to the CI runner that other tools can read.
   */
  reviewOutputPath?: string;
}
