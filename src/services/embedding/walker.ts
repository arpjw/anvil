import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import micromatch from 'micromatch';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo',
  '.venv', 'venv', '__pycache__', '.pytest_cache', 'target',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.rb', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs',
  '.md', '.json', '.yaml', '.yml', '.toml',
]);

const MAX_FILES = 3000;

// Walks a workdir and returns absolute paths of code files to embed.
export function listFilesWalk(workdir: string, ignorePatterns?: string[]): string[] {
  const out: string[] = [];
  const patterns = ignorePatterns ?? [];

  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const rel = relative(workdir, abs);
      if (patterns.length > 0 && micromatch.isMatch(rel, patterns)) continue;

      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(abs);
      } else if (s.isFile()) {
        const dot = name.lastIndexOf('.');
        if (dot === -1) continue;
        const ext = name.slice(dot).toLowerCase();
        if (!CODE_EXTS.has(ext)) continue;
        out.push(abs);
      }
    }
  };

  walk(workdir);
  return out;
}
