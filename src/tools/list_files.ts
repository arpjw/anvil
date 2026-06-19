import micromatch from 'micromatch';
import { readdirSync } from 'fs';
import { resolve, join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
const MAX_ENTRIES = 500;

export async function listFiles(
  path: string,
  workdir: string,
  pattern?: string,
  ignorePatterns?: string[],
): Promise<string> {
  const fullPath = resolve(workdir, path);
  const results: string[] = [];
  try {
    walk(fullPath, results, workdir, pattern, ignorePatterns);
    if (results.length === 0) return 'No files found';
    const truncated = results.length > MAX_ENTRIES;
    const output = results.slice(0, MAX_ENTRIES).join('\n');
    return truncated ? output + `\n... (${results.length - MAX_ENTRIES} more entries omitted)` : output;
  } catch (err) {
    return `Error listing ${path}: ${(err as Error).message}`;
  }
}

function walk(
  dir: string,
  out: string[],
  workdir: string,
  pattern?: string,
  ignorePatterns?: string[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(workdir, fullPath);

    if (ignorePatterns && isIgnored(relPath, ignorePatterns)) continue;

    if (entry.isDirectory()) {
      out.push(`${relPath}/`);
      walk(fullPath, out, workdir, pattern, ignorePatterns);
    } else if (!pattern || matchGlob(entry.name, pattern)) {
      out.push(relPath);
    }
  }
}

function isIgnored(relPath: string, patterns: string[]): boolean {
  const normalized = patterns.map(p => (p.endsWith('/') ? p + '**' : p));
  return micromatch.isMatch(relPath, normalized, { dot: true });
}

function matchGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(name);
}
