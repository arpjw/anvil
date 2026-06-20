import { existsSync, readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, basename } from 'path';

export async function loadCommands(workdir: string): Promise<Map<string, string>> {
  const commands = new Map<string, string>();
  const commandsDir = join(workdir, '.anvil', 'commands');
  if (!existsSync(commandsDir)) return commands;

  let files: string[];
  try {
    files = await readdir(commandsDir);
  } catch {
    return commands;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const name = basename(file, '.md');
    try {
      const content = readFileSync(join(commandsDir, file), 'utf8').trim();
      commands.set(name, content);
    } catch {
      // skip unreadable files
    }
  }
  return commands;
}

export function printCommands(commands: Map<string, string>): void {
  if (commands.size === 0) {
    console.log('No slash commands found. Run "anvil init" to create starter commands.');
    return;
  }
  console.log('\nAvailable slash commands:\n');
  for (const [name, content] of commands) {
    const preview = content.split('\n')[0].slice(0, 72);
    console.log(`  /${name.padEnd(16)} ${preview}`);
  }
  console.log();
}

export function resolveSlashCommand(
  request: string,
  commands: Map<string, string>,
): { systemPrompt: string; request: string } | null {
  if (!request.startsWith('/')) return null;

  const parts = request.slice(1).split(/\s+/);
  const name = parts[0];
  const rest = parts.slice(1).join(' ').trim();

  const systemPrompt = commands.get(name);
  if (!systemPrompt) return null;

  const resolvedRequest = rest
    ? `Run this against ${rest}`
    : 'Run this review against the current codebase.';

  return { systemPrompt, request: resolvedRequest };
}
