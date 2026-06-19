import micromatch from 'micromatch';
import { readFileSync } from 'fs';
import { resolve, relative } from 'path';

const MAX_CHARS = 40_000;

export async function readFile(
  path: string,
  workdir: string,
  startLine?: number,
  endLine?: number,
  ignorePatterns?: string[],
): Promise<string> {
  const fullPath = resolve(workdir, path);

  if (ignorePatterns && ignorePatterns.length > 0) {
    const relPath = relative(workdir, fullPath);
    const normalized = ignorePatterns.map(p => (p.endsWith('/') ? p + '**' : p));
    if (micromatch.isMatch(relPath, normalized, { dot: true })) {
      return `File "${path}" is excluded by .anvil/ignore`;
    }
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    let lines = content.split('\n');

    if (startLine !== undefined || endLine !== undefined) {
      const start = (startLine ?? 1) - 1;
      const end = endLine ?? lines.length;
      lines = lines.slice(start, end);
    }

    const result = lines.join('\n');
    if (result.length > MAX_CHARS) {
      return result.slice(0, MAX_CHARS) + `\n... (truncated, ${result.length - MAX_CHARS} chars omitted)`;
    }
    return result;
  } catch (err) {
    return `Error reading ${path}: ${(err as Error).message}`;
  }
}
