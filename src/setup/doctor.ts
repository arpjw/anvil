import { execSync } from 'child_process';
import { existsSync, accessSync, constants, statfsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { detectLanguages, getLspRequirements, checkLspInstalled } from './lsp.js';
import { getApiKey } from './config.js';

interface Check {
  name: string;
  required: boolean;
  pass: boolean;
  detail: string;
  fix?: string;
}

function nodeVersion(): Check {
  const ver = process.versions.node;
  const [major] = ver.split('.').map(Number);
  const pass = major >= 18;
  return {
    name: 'Node.js >= 18',
    required: true,
    pass,
    detail: `v${ver}`,
    fix: pass ? undefined : 'Install Node.js 18+ from https://nodejs.org',
  };
}

function apiKey(): Check {
  const key = getApiKey();
  const pass = !!key;
  return {
    name: 'ANTHROPIC_API_KEY',
    required: true,
    pass,
    detail: pass ? (process.env.ANTHROPIC_API_KEY ? 'set via env' : 'set via ~/.anvil/config.json') : 'not set',
    fix: pass ? undefined : 'Set ANTHROPIC_API_KEY or run: anvil config set apiKey <your-key>',
  };
}

function ripgrep(): Check {
  let pass = false;
  try {
    execSync('which rg', { stdio: 'ignore' });
    pass = true;
  } catch {}
  return {
    name: 'ripgrep (rg)',
    required: true,
    pass,
    detail: pass ? 'found in PATH' : 'not found',
    fix: pass ? undefined : 'Install ripgrep: brew install ripgrep  /  apt install ripgrep',
  };
}

async function lspChecks(workdir: string): Promise<Check[]> {
  const langs = await detectLanguages(workdir);
  if (langs.size === 0) {
    return [{
      name: 'LSP servers',
      required: false,
      pass: true,
      detail: 'no source files detected in current directory',
    }];
  }
  const reqs = getLspRequirements(langs);
  return reqs.map(req => {
    const pass = checkLspInstalled(req);
    return {
      name: `LSP: ${req.server}`,
      required: true,
      pass,
      detail: pass ? 'installed' : 'not found',
      fix: pass ? undefined : `Install: ${req.installCmd}`,
    };
  });
}

function shadowWorkspace(): Check {
  const tmpDir = '/tmp/anvil';
  let pass = true;
  let detail = '/tmp/anvil writable';
  let fix: string | undefined;
  try {
    const { execSync: ex } = { execSync };
    ex(`mkdir -p ${tmpDir} && touch ${tmpDir}/.probe && rm ${tmpDir}/.probe`, { stdio: 'ignore' });
  } catch {
    pass = false;
    detail = '/tmp/anvil not writable';
    fix = 'Run: sudo chmod 777 /tmp or check disk space';
  }
  return { name: 'Shadow workspace (/tmp/anvil)', required: true, pass, detail, fix };
}

function diskSpace(): Check {
  let pass = false;
  let detail = '';
  try {
    const stat = statfsSync('/tmp');
    const freeMb = Math.floor((stat.bfree * stat.bsize) / (1024 * 1024));
    pass = freeMb > 100;
    detail = `${freeMb} MB free on /tmp`;
  } catch {
    detail = 'could not check disk space';
    pass = true; // don't block on check failure
  }
  return {
    name: 'Disk space > 100 MB',
    required: true,
    pass,
    detail,
    fix: pass ? undefined : 'Free up disk space on /tmp',
  };
}

function gitCheck(): Check {
  let pass = false;
  try {
    execSync('which git', { stdio: 'ignore' });
    pass = true;
  } catch {}
  return {
    name: 'git',
    required: true,
    pass,
    detail: pass ? 'found in PATH' : 'not found',
    fix: pass ? undefined : 'Install git: https://git-scm.com',
  };
}

function bunCheck(): Check {
  let pass = false;
  try {
    execSync('which bun', { stdio: 'ignore' });
    pass = true;
  } catch {}
  return {
    name: 'bun (optional)',
    required: false,
    pass,
    detail: pass ? 'found in PATH' : 'not found — optional for compiled binary',
  };
}

export async function runDoctor(workdir: string = process.cwd()): Promise<number> {
  console.log('\nAnvil doctor\n');

  const checks: Check[] = [
    nodeVersion(),
    apiKey(),
    ripgrep(),
    ...(await lspChecks(workdir)),
    shadowWorkspace(),
    diskSpace(),
    gitCheck(),
    bunCheck(),
  ];

  let anyRequiredFailed = false;
  for (const c of checks) {
    const icon = c.pass ? '✓' : (c.required ? '✗' : '○');
    console.log(`  ${icon} ${c.name.padEnd(40)} ${c.detail}`);
    if (!c.pass && c.fix) {
      console.log(`    → ${c.fix}`);
    }
    if (!c.pass && c.required) anyRequiredFailed = true;
  }

  console.log();
  if (anyRequiredFailed) {
    console.log('Some required checks failed. Fix the issues above and re-run anvil doctor.\n');
    return 1;
  }
  console.log('All required checks passed. Anvil is ready to use.\n');
  return 0;
}
