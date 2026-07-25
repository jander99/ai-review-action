export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type Permission = Record<string, PermissionDecision>;

export interface ReviewResult {
  text: string;
  tokens: {
    input: number;
    output: number;
  };
  cost: number;
  model: string;
}

export interface AgentConfig {
  description: string;
  mode: 'primary';
  prompt: string;
}

export type AgentDefinition = Record<string, AgentConfig>;

export interface MergedConfig extends Record<string, unknown> {
  permission: Permission;
  agent: AgentDefinition;
  default_agent: string;
  model: string;
  provider: Record<string, unknown>;
}

export interface PromptEntry {
  type: 'file' | 'text';
  source: string;
  content: string;
}

export interface EventContext {
  eventName: string;
  repository?: string;
  prNumber?: number;
  baseRef?: string;
  headRef?: string;
  baseSha?: string;
  headSha?: string;
  ref?: string;
  before?: string;
  after?: string;
  inputs?: Record<string, unknown>;
}
