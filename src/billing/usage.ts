// Cost estimation for a session. All prices are per 1M tokens.
// Numbers as supplied by the user; some may not match live provider pricing
// exactly — they're a running estimate, not billing truth.

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUSD: number;
  model: string;
}

export interface Pricing {
  inputPer1M: number;
  outputPer1M: number;
  // Optional cache pricing. If absent, cache tokens are billed at the
  // corresponding input/output rates. Anthropic charges 10% for cache reads
  // and 125% for cache writes vs. base input; that split isn't uniform across
  // providers so we default to base rates unless a model overrides.
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export const MODEL_PRICING: Record<string, Pricing> = {
  // Anthropic
  'claude-fable-5':              { inputPer1M: 10.00, outputPer1M: 50.00 },
  'claude-sonnet-5':             { inputPer1M:  3.00, outputPer1M: 15.00 },
  'claude-opus-4-8':             { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-opus-4-7':             { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-opus-4-6':             { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-sonnet-4-6':           { inputPer1M:  3.00, outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001':   { inputPer1M:  0.80, outputPer1M:  4.00 },
  // OpenAI
  'gpt-5.5':                     { inputPer1M:  5.00, outputPer1M: 30.00 },
  'gpt-5.4':                     { inputPer1M:  2.50, outputPer1M: 15.00 },
  'gpt-5.4-mini':                { inputPer1M:  0.75, outputPer1M:  4.50 },
  'gpt-4o':                      { inputPer1M:  2.50, outputPer1M: 10.00 },
  'gpt-4o-mini':                 { inputPer1M:  0.15, outputPer1M:  0.60 },
  'o3':                          { inputPer1M: 10.00, outputPer1M: 40.00 },
  'o4-mini':                     { inputPer1M:  1.10, outputPer1M:  4.40 },
  // Google
  'gemini-2.5-pro':              { inputPer1M:  1.25, outputPer1M: 10.00 },
  'gemini-2.5-flash':            { inputPer1M:  0.075, outputPer1M: 0.30 },
  // Z.ai
  'glm-4-plus':                  { inputPer1M:  0.14, outputPer1M:  0.14 },
  'glm-4-flash':                 { inputPer1M:  0.01, outputPer1M:  0.01 },
  // Moonshot
  'kimi-k2.7-code':              { inputPer1M:  0.66, outputPer1M:  3.41 },
  'kimi-k2.7-code-highspeed':    { inputPer1M:  0.66, outputPer1M:  3.41 },
  'kimi-k2.6':                   { inputPer1M:  0.66, outputPer1M:  3.41 },
  'kimi-k2.5':                   { inputPer1M:  0.60, outputPer1M:  2.50 },
  'moonshot-v1-8k':              { inputPer1M:  0.12, outputPer1M:  0.12 },
  'moonshot-v1-32k':             { inputPer1M:  0.24, outputPer1M:  0.24 },
  'moonshot-v1-128k':            { inputPer1M:  0.80, outputPer1M:  0.80 },
};

export function calculateCost(
  usage: Pick<SessionUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
  model: string,
): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  const cacheReadRate = p.cacheReadPer1M ?? p.inputPer1M;
  const cacheWriteRate = p.cacheWritePer1M ?? p.inputPer1M;
  const cost =
    (usage.inputTokens / 1_000_000) * p.inputPer1M +
    (usage.outputTokens / 1_000_000) * p.outputPer1M +
    (usage.cacheReadTokens / 1_000_000) * cacheReadRate +
    (usage.cacheWriteTokens / 1_000_000) * cacheWriteRate;
  return Math.round(cost * 10000) / 10000; // 4 dp
}

export function emptyUsage(model: string): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUSD: 0,
    model,
  };
}

export interface UsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function accumulateUsage(
  current: SessionUsage,
  delta: UsageDelta,
): SessionUsage {
  const next: SessionUsage = {
    ...current,
    inputTokens: current.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: current.outputTokens + (delta.outputTokens ?? 0),
    cacheReadTokens: current.cacheReadTokens + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (delta.cacheWriteTokens ?? 0),
    estimatedCostUSD: 0,
  };
  next.estimatedCostUSD = calculateCost(next, current.model);
  return next;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatDollars(n: number): string {
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

export function formatUsage(usage: SessionUsage): string {
  return `↑ ${formatTokens(usage.inputTokens)}  ↓ ${formatTokens(usage.outputTokens)}  ~${formatDollars(usage.estimatedCostUSD)}`;
}

export function formatCost(usage: SessionUsage): string {
  return formatDollars(usage.estimatedCostUSD);
}

export class BudgetExceededError extends Error {
  readonly capUSD: number;
  readonly usage: SessionUsage;
  constructor(capUSD: number, usage: SessionUsage) {
    super(`Budget cap reached: $${capUSD.toFixed(2)} (usage: ${formatUsage(usage)})`);
    this.name = 'BudgetExceededError';
    this.capUSD = capUSD;
    this.usage = usage;
  }
}

// Session-scoped accumulator. Kept as a module-level singleton so the loop,
// orchestrator, and UI can all read the same running total without threading
// it through every function.
const sessionUsageStore = new Map<string, SessionUsage>();

export function initSessionUsage(sessionId: string, model: string): SessionUsage {
  const initial = emptyUsage(model);
  sessionUsageStore.set(sessionId, initial);
  return initial;
}

export function getSessionUsage(sessionId: string): SessionUsage | null {
  return sessionUsageStore.get(sessionId) ?? null;
}

export function addUsage(
  sessionId: string,
  delta: UsageDelta,
): SessionUsage | null {
  const current = sessionUsageStore.get(sessionId);
  if (!current) return null;
  const next = accumulateUsage(current, delta);
  sessionUsageStore.set(sessionId, next);
  return next;
}

export function clearSessionUsage(sessionId: string): void {
  sessionUsageStore.delete(sessionId);
}
