import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, type Harness } from './harness';
import { analyzeRepo } from '../github/analyzer';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('analyzeRepo', () => {
  test('detects Next.js + vitest + pnpm from package.json + lockfile', async () => {
    h.github.contents.set(
      'octocat/hello:package.json',
      JSON.stringify({
        name: 'hello',
        dependencies: { next: '^16.0.0', react: '^19.0.0' },
        devDependencies: { vitest: '^1.0.0' },
        scripts: { test: 'vitest run' },
      }),
    );
    h.github.contents.set('octocat/hello:pnpm-lock.yaml', 'lockfileVersion: 6.0');
    h.github.contents.set(
      'octocat/hello:.gitignore',
      'node_modules\n.next\ncoverage\nprivate-notes/\n',
    );
    h.github.contents.set(
      'octocat/hello:src/index.ts',
      'import { foo } from "./foo";\nexport function hi(): number {\n  return 1;\n}\n',
    );

    const analysis = await analyzeRepo(h.deps, {
      fullName: 'octocat/hello',
      branch: 'main',
      language: 'TypeScript',
      githubToken: 'gho_x',
    });

    expect(analysis.framework).toBe('next');
    expect(analysis.testRunner).toBe('vitest');
    expect(analysis.packageManager).toBe('pnpm');
    expect(analysis.offLimitsPaths).toContain('node_modules');
    expect(analysis.offLimitsPaths).toContain('private-notes');
    expect(analysis.generatedRules).toContain('# Anvil rules');
    expect(analysis.generatedRules).toContain('Framework: next');
    expect(analysis.generatedRules).toContain('Test runner: vitest');
    expect(analysis.generatedRules).toContain('Package manager: pnpm');
    expect(analysis.generatedRules).toContain('Never modify lock files directly');
  });

  test('detects Django + pytest + explicit test config', async () => {
    h.github.contents.set(
      'octocat/api:requirements.txt',
      'django==5.0\npytest==8.0\n',
    );
    // No package.json → detectFramework returns null from package.json,
    // and detectTestRunner looks at pytest.ini
    h.github.contents.set('octocat/api:pytest.ini', '[pytest]\ntestpaths = tests\n');

    const analysis = await analyzeRepo(h.deps, {
      fullName: 'octocat/api',
      branch: 'main',
      language: 'Python',
      githubToken: 'gho_x',
    });

    expect(analysis.framework).toBeNull();
    expect(analysis.testRunner).toBe('pytest');
    expect(analysis.generatedRules).toContain('Language: Python');
    expect(analysis.generatedRules).toContain('Test runner: pytest');
  });

  test('handles a bare repo — no lockfile / no test config / no source', async () => {
    const analysis = await analyzeRepo(h.deps, {
      fullName: 'octocat/empty',
      branch: 'main',
      language: 'Rust',
      githubToken: 'gho_x',
    });

    expect(analysis.framework).toBeNull();
    expect(analysis.testRunner).toBeNull();
    expect(analysis.packageManager).toBeNull();
    // Baseline off-limits are still present.
    expect(analysis.offLimitsPaths).toContain('node_modules');
    expect(analysis.offLimitsPaths).toContain('target');
    expect(analysis.generatedRules).toContain('Language: Rust');
    expect(analysis.generatedRules).toContain('Framework: not detected');
  });

  test('conventions section reflects sniffed source style', async () => {
    h.github.contents.set(
      'octocat/hello:package.json',
      JSON.stringify({ name: 'x', dependencies: {} }),
    );
    // Aggressive semicolons + double quotes.
    h.github.contents.set(
      'octocat/hello:src/index.ts',
      Array.from({ length: 40 })
        .map((_, i) => `const x${i} = "value";`)
        .join('\n'),
    );

    const analysis = await analyzeRepo(h.deps, {
      fullName: 'octocat/hello',
      branch: 'main',
      language: 'TypeScript',
      githubToken: 'gho_x',
    });

    expect(analysis.conventions.some((c) => c.includes('double quotes'))).toBe(true);
    expect(analysis.conventions.some((c) => c.includes('semicolons'))).toBe(true);
  });
});
