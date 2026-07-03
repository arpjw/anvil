import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import OpenAI from 'openai';

// ── Model registry ────────────────────────────────────────────────────────────

export interface ModelSpec {
  id: string;
  label: string;
  provider: string;
  envKey: string;
  description: string;
  baseURL: string | null;
}

// Every `id` here must be a real model string the provider's API will accept.
// Marketing names ("Kimi K2", "GPT-5") belong in `label`, never in `id`.
// When adding a model, verify against the provider's /models endpoint or the
// official API reference — no aspirational IDs.
export const AVAILABLE_MODELS: ModelSpec[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Anthropic most capable, $10/$50 per MTok',
    baseURL: null,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Fast and intelligent, $3/$15 per MTok',
    baseURL: null,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Default — fast and smart',
    baseURL: null,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Complex agentic coding and enterprise work',
    baseURL: null,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Prior Opus generation',
    baseURL: null,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Older Opus, still solid',
    baseURL: null,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    description: 'Cheapest / fastest Claude',
    baseURL: null,
  },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI flagship, $5/$30 per MTok',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI balanced, $2.50/$15 per MTok',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI fast and affordable, $0.75/$4.50 per MTok',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI flagship multimodal',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'Cheap, fast, still strong',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'o3',
    label: 'o3',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'Reasoning model — slower, better on hard tasks',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'Reasoning model, faster / cheaper than o3',
    baseURL: 'https://api.openai.com/v1',
  },
  // ── Google ─────────────────────────────────────────────────────────────────
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    envKey: 'GEMINI_API_KEY',
    description: 'Google flagship — long context',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'google',
    envKey: 'GEMINI_API_KEY',
    description: 'Cheap, fast Google model',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  // ── Z.ai / GLM ─────────────────────────────────────────────────────────────
  {
    id: 'glm-4-plus',
    label: 'GLM-4 Plus',
    provider: 'zai',
    envKey: 'GLM_API_KEY',
    description: 'Z.ai flagship — strongest GLM available via API',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    id: 'glm-4-flash',
    label: 'GLM-4 Flash',
    provider: 'zai',
    envKey: 'GLM_API_KEY',
    description: 'Z.ai — fast, cheap, free tier available',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
  // ── Moonshot ───────────────────────────────────────────────────────────────
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Moonshot coding-optimized, 256K context',
    baseURL: 'https://api.moonshot.ai/v1',
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    label: 'Kimi K2.7 Code Highspeed',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Moonshot coding, ~180 tok/s',
    baseURL: 'https://api.moonshot.ai/v1',
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Moonshot flagship multimodal, 256K context',
    baseURL: 'https://api.moonshot.ai/v1',
  },
  {
    id: 'kimi-k2.5',
    label: 'Kimi K2.5',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Moonshot previous gen, 256K context',
    baseURL: 'https://api.moonshot.ai/v1',
  },
  {
    id: 'moonshot-v1-128k',
    label: 'Moonshot v1 · 128K context',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Kimi K2 backend — largest context window',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  {
    id: 'moonshot-v1-32k',
    label: 'Moonshot v1 · 32K context',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Kimi K2 backend — mid context',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  {
    id: 'moonshot-v1-8k',
    label: 'Moonshot v1 · 8K context',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Kimi K2 backend — cheapest / smallest context',
    baseURL: 'https://api.moonshot.cn/v1',
  },
];

// ── Model picker ──────────────────────────────────────────────────────────────

export interface SelectedModel {
  modelId: string;
  baseURL: string | null;
  apiKey: string;
  modelLabel: string;
}

export async function selectModel(): Promise<SelectedModel> {
  const config = loadConfig();
  const defaultId = config.model;

  for (;;) {
    const choices = AVAILABLE_MODELS.map(m => {
      const hasKey = !!process.env[m.envKey];
      const suffix = hasKey ? '' : chalk.dim(' (API key not set)');
      return {
        name: `${m.label} — ${m.description}${suffix}`,
        value: m.id,
      };
    });

    const defaultValue = AVAILABLE_MODELS.some(m => m.id === defaultId)
      ? defaultId
      : 'claude-sonnet-4-6';

    const modelId = await select<string>({
      message: 'Select model:',
      choices,
      default: defaultValue,
    });

    const spec = AVAILABLE_MODELS.find(m => m.id === modelId)!;
    const apiKey = process.env[spec.envKey] ?? '';

    if (!apiKey) {
      console.log(`\n${spec.envKey} is not set. Set it and re-run, or choose a different model.\n`);
      continue;
    }

    return { modelId: spec.id, baseURL: spec.baseURL, apiKey, modelLabel: spec.label };
  }
}

// ── Client factory ────────────────────────────────────────────────────────────

export function buildClient(modelId: string, baseURL: string | null, apiKey: string): OpenAI {
  if (baseURL === null) {
    return new OpenAI({ apiKey, baseURL: 'https://api.anthropic.com/v1' });
  }
  return new OpenAI({ apiKey, baseURL });
}

// ── Config file ───────────────────────────────────────────────────────────────

export interface AnvilConfig {
  model: string;
  apiKey: string | null;
  maxRetries: number;
  timeout: number;
  theme: string;
  panelWidths: { left: number; right: number };
  autoVerify: boolean;
  autoBranch: boolean;
  setupComplete: boolean;
  budgetCapUSD: number | null;
  autoOpen: boolean;
}

const DEFAULTS: AnvilConfig = {
  model: 'claude-sonnet-4-6',
  apiKey: null,
  maxRetries: 3,
  timeout: 30,
  theme: 'dark',
  panelWidths: { left: 28, right: 72 },
  autoVerify: true,
  autoBranch: true,
  setupComplete: false,
  budgetCapUSD: null,
  autoOpen: true,
};

const ANVIL_DIR = join(homedir(), '.anvil');
const CONFIG_FILE = join(ANVIL_DIR, 'config.json');

export function loadConfig(): AnvilConfig {
  let saved: Partial<AnvilConfig> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      // corrupt config, use defaults
    }
  }
  return { ...DEFAULTS, ...saved, panelWidths: { ...DEFAULTS.panelWidths, ...(saved.panelWidths ?? {}) } };
}

export function saveConfig(partial: Partial<AnvilConfig>): void {
  mkdirSync(ANVIL_DIR, { recursive: true });
  const current = loadConfig();
  const next = { ...current, ...partial };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  // Config may contain the API key — restrict to owner read/write.
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // best-effort — non-POSIX platforms will just skip
  }
}

export function getApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const config = loadConfig();
  return config.apiKey;
}

type ConfigKey = keyof AnvilConfig;

const TYPE_MAP: Record<ConfigKey, string> = {
  model: 'string',
  apiKey: 'string|null',
  maxRetries: 'number',
  timeout: 'number',
  theme: 'string',
  panelWidths: 'object',
  autoVerify: 'boolean',
  autoBranch: 'boolean',
  setupComplete: 'boolean',
  budgetCapUSD: 'number|null',
  autoOpen: 'boolean',
};

function parseValue(key: ConfigKey, raw: string): AnvilConfig[ConfigKey] {
  const expected = TYPE_MAP[key];
  if (expected === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`Invalid boolean value "${raw}". Use true or false.`);
  }
  if (expected === 'number') {
    const n = Number(raw);
    if (isNaN(n)) throw new Error(`Invalid number value "${raw}".`);
    return n;
  }
  if (expected === 'string|null') {
    return raw === 'null' ? null : raw;
  }
  if (expected === 'number|null') {
    if (raw === 'null') return null;
    const n = Number(raw);
    if (isNaN(n)) throw new Error(`Invalid number value "${raw}".`);
    return n;
  }
  return raw;
}

export function runConfigSet(key: string, value: string): void {
  if (!(key in DEFAULTS)) {
    console.error(`Unknown config key "${key}". Run "anvil config list" to see available keys.`);
    process.exit(1);
  }
  const k = key as ConfigKey;
  let parsed: AnvilConfig[ConfigKey];
  try {
    parsed = parseValue(k, value);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  saveConfig({ [k]: parsed } as Partial<AnvilConfig>);
  console.log(`Set ${key} to ${JSON.stringify(parsed)} ✓`);
}

export function runConfigGet(key: string): void {
  if (!(key in DEFAULTS)) {
    console.error(`Unknown config key "${key}". Run "anvil config list" to see available keys.`);
    process.exit(1);
  }
  const config = loadConfig();
  const val = config[key as ConfigKey];
  console.log(JSON.stringify(val));
}

export function runConfigList(): void {
  const config = loadConfig();
  const keys = Object.keys(DEFAULTS) as ConfigKey[];
  const maxLen = Math.max(...keys.map(k => k.length));
  console.log('\nAnvil configuration (~/.anvil/config.json):\n');
  for (const k of keys) {
    const val = JSON.stringify(config[k]);
    console.log(`  ${k.padEnd(maxLen)}  ${val}`);
  }
  console.log();
}
