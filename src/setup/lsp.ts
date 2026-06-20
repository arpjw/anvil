import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, extname } from 'path';
import { homedir } from 'os';
import { execSync, spawn } from 'child_process';

type Language = 'typescript' | 'python' | 'go' | 'rust';

interface LspRequirement {
  server: string;
  installCmd: string;
  binName: string;
  checkPaths: string[];
}

const LSP_MAP: Record<Language, LspRequirement> = {
  typescript: {
    server: 'typescript-language-server',
    installCmd: 'npm install -g typescript-language-server typescript',
    binName: 'typescript-language-server',
    checkPaths: [],
  },
  python: {
    server: 'pylsp',
    installCmd: 'pip install python-lsp-server',
    binName: 'pylsp',
    checkPaths: [join(homedir(), '.local', 'bin'), '/usr/local/bin'],
  },
  go: {
    server: 'gopls',
    installCmd: 'go install golang.org/x/tools/gopls@latest',
    binName: 'gopls',
    checkPaths: [join(homedir(), 'go', 'bin')],
  },
  rust: {
    server: 'rust-analyzer',
    installCmd: 'rustup component add rust-analyzer',
    binName: 'rust-analyzer',
    checkPaths: [join(homedir(), '.cargo', 'bin')],
  },
};

const EXT_TO_LANG: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

export async function detectLanguages(workdir: string): Promise<Set<Language>> {
  const langs = new Set<Language>();
  async function scan(dir: string, depth = 0): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const fullPath = join(dir, e.name);
      if (e.isDirectory()) {
        await scan(fullPath, depth + 1);
      } else {
        const lang = EXT_TO_LANG[extname(e.name)];
        if (lang) langs.add(lang);
      }
    }
  }
  await scan(workdir);
  return langs;
}

export function getLspRequirements(languages: Set<Language>): LspRequirement[] {
  return [...languages].map(l => LSP_MAP[l]);
}

export function checkLspInstalled(req: LspRequirement): boolean {
  try {
    execSync(`which ${req.binName}`, { stdio: 'ignore' });
    return true;
  } catch {
    // fall through to check common paths
  }
  const localBin = join(process.cwd(), 'node_modules', '.bin', req.binName);
  if (existsSync(localBin)) return true;
  for (const p of req.checkPaths) {
    if (existsSync(join(p, req.binName))) return true;
  }
  return false;
}

const ANVIL_DIR = join(homedir(), '.anvil');
const LSP_STATE_FILE = join(ANVIL_DIR, 'lsp.json');

function loadLspState(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(LSP_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveLspState(state: Record<string, boolean>): void {
  mkdirSync(ANVIL_DIR, { recursive: true });
  writeFileSync(LSP_STATE_FILE, JSON.stringify(state, null, 2));
}

function runInstallStreaming(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const [bin, ...args] = cmd.split(' ');
    const child = spawn(bin, args, { stdio: 'inherit', shell: true });
    child.on('close', code => resolve(code === 0));
  });
}

export async function promptAndInstall(workdir: string): Promise<void> {
  const langs = await detectLanguages(workdir);
  if (langs.size === 0) return;

  const reqs = getLspRequirements(langs);
  const state = loadLspState();

  for (const req of reqs) {
    if (state[req.server]) continue;
    if (checkLspInstalled(req)) {
      state[req.server] = true;
      continue;
    }

    const langName = ([...Object.entries(LSP_MAP)].find(([, v]) => v.server === req.server)?.[0] ?? req.server);
    const display = langName.charAt(0).toUpperCase() + langName.slice(1);
    process.stdout.write(`${display} files detected. ${req.server} is not installed.\n`);
    process.stdout.write(`Install now? (y/n): `);

    const answer = await readLine();
    if (answer.trim().toLowerCase() === 'y') {
      process.stdout.write(`Running: ${req.installCmd}\n`);
      const ok = await runInstallStreaming(req.installCmd);
      if (ok) {
        console.log(`✓ ${req.server} installed successfully`);
        state[req.server] = true;
      } else {
        console.error(`✗ Failed to install ${req.server}. Run manually: ${req.installCmd}`);
      }
    } else {
      console.log(`Skipping ${req.server}. Some LSP features may not work.`);
      state[req.server] = false;
    }
    saveLspState(state);
  }
}

function readLine(): Promise<string> {
  return new Promise(resolve => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(buf.trim());
      }
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}
