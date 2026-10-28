export type SessionStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'reviewing'
  | 'complete'
  | 'failed'
  | 'aborted';

export type DiffStatus = 'pending' | 'approved' | 'rejected';

export interface Repo {
  id: string;
  userId: string;
  fullName: string;
  defaultBranch: string;
  installedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  repoId: string;
  status: SessionStatus;
  branch: string;
  request: string;
  model: string;
  planJson: Plan | null;
  vmIp: string | null;
  vmPort: number | null;
  prUrl: string | null;
  prState: 'open' | 'merged' | 'closed' | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  createdAt: string;
  repoFullName?: string;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface SessionDetail extends Session {
  repoFullName: string;
  events: SessionEvent[];
  diffs: Diff[];
}

export interface Diff {
  id: string;
  sessionId: string;
  filepath: string;
  originalContent: string | null;
  newContent: string | null;
  status: DiffStatus;
  createdAt: string;
}

export interface Plan {
  goal?: string;
  context?: string;
  steps?: string[];
  verificationCriteria?: string[];
  intent?: string;
  approach?: string;
  filesToRead?: string[];
  filesToModify?: string[];
  filesToCreate?: string[];
  testPlan?: string;
  risks?: string[];
  [key: string]: unknown;
}

export interface UIEvent {
  id?: string;
  type: string;
  payload?: unknown;
  timestamp?: number;
}

// Kept in sync with src/setup/config.ts::AVAILABLE_MODELS. Every id must be a
// real string the provider's API will accept.
export const MODELS = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Anthropic' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI' },
  { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'OpenAI' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI' },
  { id: 'o3', label: 'o3', provider: 'OpenAI' },
  { id: 'o4-mini', label: 'o4-mini', provider: 'OpenAI' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google' },
  { id: 'glm-4-plus', label: 'GLM-4 Plus', provider: 'Z.ai' },
  { id: 'glm-4-flash', label: 'GLM-4 Flash', provider: 'Z.ai' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'Moonshot' },
  { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed', provider: 'Moonshot' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', provider: 'Moonshot' },
  { id: 'kimi-k2.5', label: 'Kimi K2.5', provider: 'Moonshot' },
  { id: 'moonshot-v1-128k', label: 'Moonshot v1 · 128K', provider: 'Moonshot' },
  { id: 'moonshot-v1-32k', label: 'Moonshot v1 · 32K', provider: 'Moonshot' },
  { id: 'moonshot-v1-8k', label: 'Moonshot v1 · 8K', provider: 'Moonshot' },
] as const;

export type ModelId = (typeof MODELS)[number]['id'];
