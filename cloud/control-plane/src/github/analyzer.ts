import type { AppDeps, GithubClient } from '../lib/context';
import { logger } from '../lib/logger';

export type Framework =
  | 'next' | 'react' | 'vue' | 'svelte' | 'express' | 'fastapi'
  | 'django' | 'flask' | 'gin' | 'actix' | null;

export type TestRunner =
  | 'jest' | 'vitest' | 'pytest' | 'cargo' | 'go' | 'npm' | null;

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | null;

export interface RepoAnalysis {
  framework: Framework;
  testRunner: TestRunner;
  packageManager: PackageManager;
  language: string;
  conventions: string[];
  offLimitsPaths: string[];
  generatedRules: string;
}

const DEFAULT_OFF_LIMITS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
  'target',
];

const FRAMEWORK_MARKERS: Record<Exclude<Framework, null>, string[]> = {
  next: ['next'],
  react: ['react'],
  vue: ['vue'],
  svelte: ['svelte'],
  express: ['express'],
  fastapi: ['fastapi'],
  django: ['django', 'Django'],
  flask: ['flask', 'Flask'],
  gin: ['gin-gonic/gin'],
  actix: ['actix-web'],
};

// analyzeRepo reads a small handful of files via the Contents API and returns
// a synthesised RepoAnalysis + a starter .anvil/rules.md.
// language and defaultBranch come in from the caller so we don't burn an
// extra API call to re-fetch them.
export async function analyzeRepo(
  deps: AppDeps,
  args: {
    fullName: string;
    branch: string;
    language: string; // e.g. 'TypeScript', from GitHub repos.get
    githubToken: string | null;
    gh?: GithubClient;
  },
): Promise<RepoAnalysis> {
  const [owner, repo] = args.fullName.split('/') as [string, string];
  const gh = args.gh ?? deps.githubClient(args.githubToken);

  const read = async (path: string): Promise<string | null> => {
    try {
      return await gh.getFileContent(owner, repo, path, args.branch);
    } catch (err) {
      logger.warn({ path, err }, 'analyzer: failed to fetch file');
      return null;
    }
  };

  const packageJsonRaw = await read('package.json');
  const packageJson = packageJsonRaw ? tryParseJson(packageJsonRaw) : null;
  const framework = detectFramework(packageJson);
  const testRunner = await detectTestRunner(packageJson, read);
  const packageManager = await detectPackageManager(read);

  // Read up to 3 source files to sniff conventions.
  const sourceCandidates = candidateSourceFiles(packageJson, args.language);
  const sourceContents: string[] = [];
  for (const path of sourceCandidates) {
    const content = await read(path);
    if (content) sourceContents.push(content);
    if (sourceContents.length >= 3) break;
  }
  const conventions = detectConventions(sourceContents, args.language);

  // Off-limits: baseline + parsed .gitignore
  const gitignore = await read('.gitignore');
  const offLimitsPaths = mergeOffLimits(gitignore);

  const generatedRules = renderRules({
    framework,
    testRunner,
    packageManager,
    language: args.language,
    conventions,
    offLimitsPaths,
  });

  return {
    framework,
    testRunner,
    packageManager,
    language: args.language,
    conventions,
    offLimitsPaths,
    generatedRules,
  };
}

export async function triggerRepoAnalysis(
  deps: AppDeps,
  args: {
    repoId: string;
    fullName: string;
    branch: string;
    language: string;
    githubToken: string | null;
  },
): Promise<void> {
  try {
    const analysis = await analyzeRepo(deps, args);
    await deps.repo.setRepoGeneratedRules(args.repoId, analysis.generatedRules);
  } catch (err) {
    logger.warn({ repoId: args.repoId, err }, 'repo analysis failed');
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectFramework(pkg: Record<string, unknown> | null): Framework {
  if (!pkg) return null;
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  for (const [name, markers] of Object.entries(FRAMEWORK_MARKERS) as Array<[Exclude<Framework, null>, string[]]>) {
    if (markers.some((m) => m in deps)) return name;
  }
  return null;
}

async function detectTestRunner(
  pkg: Record<string, unknown> | null,
  read: (path: string) => Promise<string | null>,
): Promise<TestRunner> {
  if (pkg) {
    const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
    const testCmd = scripts.test ?? '';
    if (testCmd.includes('vitest')) return 'vitest';
    if (testCmd.includes('jest')) return 'jest';
    if (testCmd.includes('pytest')) return 'pytest';
    if (testCmd && !testCmd.startsWith('echo')) return 'npm';
  }
  if (await read('jest.config.js')) return 'jest';
  if (await read('jest.config.ts')) return 'jest';
  if (await read('vitest.config.ts')) return 'vitest';
  if (await read('vitest.config.js')) return 'vitest';
  if (await read('pytest.ini')) return 'pytest';
  if (await read('Cargo.toml')) return 'cargo';
  if (await read('go.mod')) return 'go';
  return null;
}

async function detectPackageManager(
  read: (path: string) => Promise<string | null>,
): Promise<PackageManager> {
  if (await read('bun.lockb')) return 'bun';
  if (await read('pnpm-lock.yaml')) return 'pnpm';
  if (await read('yarn.lock')) return 'yarn';
  if (await read('package-lock.json')) return 'npm';
  return null;
}

function candidateSourceFiles(
  pkg: Record<string, unknown> | null,
  language: string,
): string[] {
  const paths: string[] = [];
  const main = pkg?.main;
  if (typeof main === 'string') paths.push(main);
  paths.push(
    'src/index.ts',
    'src/index.tsx',
    'src/index.js',
    'src/main.ts',
    'src/main.py',
    'src/lib.rs',
    'main.go',
    'app/page.tsx',
  );
  void language;
  return paths;
}

function detectConventions(files: string[], language: string): string[] {
  if (files.length === 0) return [];
  const total = files.length;
  let doubleQuote = 0;
  let singleQuote = 0;
  let semicolons = 0;
  let tabs = 0;
  let spaces = 0;
  let explicitReturns = 0;

  for (const file of files) {
    // Count occurrences of "string" and 'string' — rough but stable across files.
    doubleQuote += (file.match(/"[^"\n]*"/g) ?? []).length;
    singleQuote += (file.match(/'[^'\n]*'/g) ?? []).length;
    semicolons += (file.match(/;\n/g) ?? []).length;

    for (const line of file.split('\n')) {
      if (line.startsWith('\t')) tabs++;
      else if (line.startsWith('  ')) spaces++;
    }
    // TS return type annotations like ": Foo {" or ": Promise<...> {"
    explicitReturns += (file.match(/\)\s*:\s*[A-Za-z<>[\],\s|&]+\s*{/g) ?? []).length;
  }

  const conventions: string[] = [];

  const isJsFamily = /Type|Java/.test(language) || files.some((f) => /^\s*import|export/.test(f));
  if (isJsFamily) {
    if (doubleQuote > singleQuote * 1.5) {
      conventions.push('Use double quotes for strings.');
    } else if (singleQuote > doubleQuote * 1.5) {
      conventions.push('Use single quotes for strings.');
    }
    if (semicolons > total * 3) {
      conventions.push('Always include semicolons at the end of statements.');
    } else if (semicolons < total) {
      conventions.push('Omit trailing semicolons.');
    }
    if (explicitReturns > total * 2) {
      conventions.push('Use explicit return type annotations on exported functions.');
    }
  }

  if (tabs > spaces * 2) {
    conventions.push('Use tabs for indentation.');
  } else if (spaces > tabs * 2) {
    conventions.push('Use 2-space indentation.');
  }

  return conventions;
}

function mergeOffLimits(gitignore: string | null): string[] {
  const out = new Set(DEFAULT_OFF_LIMITS);
  if (!gitignore) return Array.from(out);
  for (const raw of gitignore.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // negation, skip
    const cleaned = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) continue;
    out.add(cleaned);
  }
  return Array.from(out);
}

function renderRules(a: {
  framework: Framework;
  testRunner: TestRunner;
  packageManager: PackageManager;
  language: string;
  conventions: string[];
  offLimitsPaths: string[];
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Anvil rules — auto-generated on ${today}`);
  lines.push(`# Review and edit these to match your preferences.`);
  lines.push('');
  lines.push('## Project');
  lines.push(`- Language: ${a.language || 'unknown'}`);
  lines.push(`- Framework: ${a.framework ?? 'not detected'}`);
  lines.push(`- Test runner: ${a.testRunner ?? 'not detected'}`);
  lines.push(`- Package manager: ${a.packageManager ?? 'not detected'}`);
  lines.push('');
  lines.push('## Off-limits paths');
  for (const p of a.offLimitsPaths) lines.push(`- ${p}`);
  lines.push('');
  if (a.conventions.length > 0) {
    lines.push('## Code style');
    for (const c of a.conventions) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push('## Rules');
  lines.push('- Never modify lock files directly.');
  lines.push('- Always preserve existing comments unless explicitly asked to remove them.');
  lines.push('- Run tests after any change to verify nothing is broken.');
  lines.push('');
  return lines.join('\n');
}
