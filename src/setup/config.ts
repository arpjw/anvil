import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

export const AVAILABLE_MODELS: ModelSpec[] = [
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
    description: 'Most capable, best for complex agentic tasks',
    baseURL: null,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI flagship',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gpt-5.5-pro',
    label: 'GPT-5.5 Pro',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI highest capability, more compute',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    description: 'OpenAI previous gen, still strong',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'google',
    envKey: 'GEMINI_API_KEY',
    description: 'Google — fast, cheap, strong on coding',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    provider: 'google',
    envKey: 'GEMINI_API_KEY',
    description: 'Google flagship',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Moonshot — economical, multimodal',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    provider: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    description: 'Moonshot — coding-optimized, 256K context',
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
