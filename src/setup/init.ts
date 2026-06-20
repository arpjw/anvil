import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { checkbox, input } from '@inquirer/prompts';

export async function initProject(workdir: string = process.cwd(), yes = false): Promise<void> {
  const anvilDir = join(workdir, '.anvil');
  const commandsDir = join(anvilDir, 'commands');

  console.log('\nAnvil project initialization\n');

  // 1. Languages
  const languages: string[] = yes
    ? ['typescript']
    : await checkbox({
        message: 'What languages does this project use?',
        choices: [
          { name: 'TypeScript', value: 'typescript', checked: true },
          { name: 'Python', value: 'python' },
          { name: 'Go', value: 'go' },
          { name: 'Rust', value: 'rust' },
        ],
      });

  // 2. Off-limits directories
  const ignoreDirsRaw = yes
    ? 'node_modules, dist, .git'
    : await input({
        message: 'Any directories Anvil should never touch? (comma-separated)',
        default: 'node_modules, dist, .git',
      });
  const ignoreDirs = ignoreDirsRaw.split(',').map(s => s.trim()).filter(Boolean);

  // 3. Test command
  let defaultTestCmd = 'npm test';
  const pkgPath = join(workdir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test) defaultTestCmd = 'npm test';
      if (pkg.scripts?.vitest) defaultTestCmd = 'npx vitest run';
    } catch {
      // ignore
    }
  }
  const testCmd = yes
    ? defaultTestCmd
    : await input({
        message: 'What is your test command?',
        default: defaultTestCmd,
      });

  // 4. Style rules
  const styleRules = yes
    ? ''
    : await input({
        message: 'Any coding style rules Anvil should follow? (optional)',
        default: '',
      });

  // ── Create .anvil/ ────────────────────────────────────────────────────────────
  mkdirSync(anvilDir, { recursive: true });
  mkdirSync(commandsDir, { recursive: true });

  // .anvil/rules.md
  const rulesLines = [
    '# Anvil Rules\n',
    '## Off-limits directories\n',
    ...ignoreDirs.map(d => `- ${d}`),
    '',
    '## Test command\n',
    `\`${testCmd}\``,
    '',
    '## Style\n',
    styleRules ? styleRules : '*(no style rules specified)*',
    '',
    '## Defaults\n',
    '- Never modify lock files.',
    '- Always preserve existing comments unless explicitly asked to remove them.',
    '- Prefer editing existing files over creating new ones.',
  ];
  writeFileSync(join(anvilDir, 'rules.md'), rulesLines.join('\n'));

  // .anvil/ignore
  writeFileSync(join(anvilDir, 'ignore'), ignoreDirs.join('\n') + '\n');

  // .anvil/commands/review.md
  writeFileSync(
    join(commandsDir, 'review.md'),
    'Review the code in this repo for bugs, type safety issues, and missing error handling. List findings by file.',
  );

  // .anvil/commands/document.md
  writeFileSync(
    join(commandsDir, 'document.md'),
    'Add JSDoc comments to all exported functions and classes that are missing documentation.',
  );

  // .anvil/commands/test.md
  writeFileSync(
    join(commandsDir, 'test.md'),
    'Write unit tests for any exported functions that don\'t have test coverage. Use the existing test framework.',
  );

  // .anvil/memory.md
  if (!existsSync(join(anvilDir, 'memory.md'))) {
    writeFileSync(
      join(anvilDir, 'memory.md'),
      '<!-- Anvil stores persistent project context here. It is included in every session as additional context. -->\n',
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const created = [
    resolve(anvilDir, 'rules.md'),
    resolve(anvilDir, 'ignore'),
    resolve(commandsDir, 'review.md'),
    resolve(commandsDir, 'document.md'),
    resolve(commandsDir, 'test.md'),
    resolve(anvilDir, 'memory.md'),
  ];

  console.log('\nCreated:\n');
  for (const f of created) {
    const rel = f.replace(workdir + '/', '');
    console.log(`  ✓ ${rel}`);
  }

  console.log('\nNext steps:\n');
  console.log(`  anvil doctor            — verify your setup`);
  console.log(`  anvil "<request>" .     — run Anvil on this project`);
  console.log(`  anvil /review .         — run the review slash command`);
  console.log();
}
