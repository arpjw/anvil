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
  type: string;
  payload?: unknown;
  timestamp?: number;
}

export const MODELS = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
  { id: 'gpt-5', label: 'GPT-5', provider: 'OpenAI' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'OpenAI' },
  { id: 'o3', label: 'o3', provider: 'OpenAI' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google' },
  { id: 'kimi-k2', label: 'Kimi K2', provider: 'Moonshot' },
] as const;

export type ModelId = (typeof MODELS)[number]['id'];
