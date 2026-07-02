import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { AVAILABLE_MODELS, loadConfig, saveConfig } from './config.js';
import {
  detectLanguages,
  getLspRequirements,
  checkLspInstalled,
  promptAndInstall,
} from './lsp.js';
import { initProject } from './init.js';

const CONFIG_PATH = join(homedir(), '.anvil', 'config.json');

export function isFirstRun(): boolean {
  if (!existsSync(CONFIG_PATH)) return true;
  const cfg = loadConfig();
  return !cfg.setupComplete;
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function stepApiKey(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(chalk.green('  ✓') + chalk.dim(' ANTHROPIC_API_KEY found in env'));
    return;
  }

  const cfg = loadConfig();
  if (cfg.apiKey) {
    console.log(chalk.green('  ✓') + chalk.dim(' API key already saved in config'));
    return;
  }

  console.log(chalk.dim("  You'll need an Anthropic API key. Get one at https://console.anthropic.com"));
  const key = await input({
    message: 'Paste your Anthropic API key (or leave blank to set later):',
    validate: (raw): string | true => {
      if (!raw.trim()) return true; // allow skip
      if (!raw.startsWith('sk-ant-')) return 'Key should start with "sk-ant-"';
      if (raw.length < 40) return 'Key looks too short';
      return true;
    },
  });

  if (!key.trim()) {
    console.log(chalk.yellow('  ⚠ Skipped. Set ANTHROPIC_API_KEY before running a session.'));
    return;
  }

  saveConfig({ apiKey: key.trim() });
  console.log(chalk.green('  ✓') + ' Saved to ~/.anvil/config.json (chmod 0600)');
  console.log(chalk.dim('    For a permanent shell env, add to ~/.zshrc:'));
  console.log(chalk.dim(`    export ANTHROPIC_API_KEY="${key.trim().slice(0, 12)}…"`));
}

async function stepModel(): Promise<string> {
  const cfg = loadConfig();
  const choices = AVAILABLE_MODELS.map((m) => ({
    name: `${m.label} — ${chalk.dim(m.description)}`,
    value: m.id,
    description: `[${m.provider}] env: ${m.envKey}`,
  }));

  const model = await select({
    message: 'Which model should be the default? (Enter to accept default)',
    choices,
    default: cfg.model || 'claude-sonnet-4-6',
  });

  saveConfig({ model });
  console.log(chalk.green('  ✓') + ` Default model: ${chalk.cyan(model)}`);
  return model;
}

type Language = 'typescript' | 'python' | 'go' | 'rust';

async function stepLsp(workdir: string): Promise<void> {
  const detected = await detectLanguages(workdir);

  if (detected.size > 0) {
    console.log(
      chalk.dim(
        `  Detected in ${workdir}: ${[...detected].join(', ')}`,
      ),
    );
    await promptAndInstall(workdir);
    return;
  }

  const answer = await checkbox<Language>({
    message: 'What languages does your project use? (space to toggle)',
    choices: [
      { name: 'TypeScript', value: 'typescript' },
      { name: 'Python', value: 'python' },
      { name: 'Go', value: 'go' },
      { name: 'Rust', value: 'rust' },
    ],
  });

  if (answer.length === 0) {
    console.log(chalk.dim('  Skipped — no languages selected.'));
    return;
  }

  const reqs = getLspRequirements(new Set(answer));
  for (const req of reqs) {
    if (checkLspInstalled(req)) {
      console.log(chalk.green('  ✓') + ` ${req.server} already installed`);
      continue;
    }
    console.log(chalk.dim(`  Missing: ${req.server}`));
    console.log(chalk.dim(`  Install with:  ${req.installCmd}`));
  }
  const reinstall = await confirm({
    message: 'Install missing language servers now?',
    default: true,
  });
  if (!reinstall) return;

  // Reuse the same install flow the CLI already uses for detected languages.
  await promptAndInstall(workdir);
}

async function stepProjectInit(workdir: string): Promise<void> {
  const anvilDir = join(workdir, '.anvil');
  if (existsSync(anvilDir)) {
    console.log(chalk.dim('  .anvil/ already exists — skipping.'));
    return;
  }

  const ok = await confirm({
    message: 'Initialize Anvil for this project? (.anvil/ folder with rules + memory)',
    default: true,
  });
  if (!ok) return;

  await initProject(workdir, true);
}

function stepSummary(workdir: string, model: string): void {
  console.log('');
  console.log(chalk.green.bold('  All set.'));
  console.log(chalk.dim(`  ~/.anvil/config.json  · default model = ${model}`));
  console.log(chalk.dim(`  ${workdir}/.anvil/    · project rules + memory`));
  console.log('');
  console.log(chalk.cyan('  Try it:'));
  console.log(`    ${chalk.bold('anvilai')} "add error handling to main.ts" .`);
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runFirstRun(workdir: string = process.cwd()): Promise<void> {
  console.log('');
  console.log(chalk.bold('  Welcome to Anvil.') + chalk.dim(' First-time setup (60 seconds).'));
  console.log('');

  try {
    console.log(chalk.bold('  1/5 API key'));
    await stepApiKey();
    console.log('');

    console.log(chalk.bold('  2/5 Default model'));
    const model = await stepModel();
    console.log('');

    console.log(chalk.bold('  3/5 Language servers'));
    await stepLsp(workdir);
    console.log('');

    console.log(chalk.bold('  4/5 Project setup'));
    await stepProjectInit(workdir);
    console.log('');

    console.log(chalk.bold('  5/5 Done'));
    stepSummary(workdir, model);

    saveConfig({ setupComplete: true });
  } catch (err) {
    // Ctrl+C from any prompt lands here. Leave setupComplete=false so the
    // wizard fires again next time.
    if ((err as { name?: string }).name === 'ExitPromptError') {
      console.log(chalk.yellow('\n  Setup cancelled. Rerun anvilai to try again.'));
      return;
    }
    console.error(chalk.red(`\n  Setup error: ${(err as Error).message}`));
  }
}
