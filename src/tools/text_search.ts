import { execa } from 'execa';
import { resolve } from 'path';

const MAX_CHARS = 20_000;

interface SearchOptions {
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export async function textSearch(
  pattern: string,
  path: string,
  workdir: string,
  options: SearchOptions = {},
): Promise<string> {
  const fullPath = resolve(workdir, path);
  const args: string[] = ['--line-number', '--with-filename', '--color=never'];

  if (!options.caseSensitive) args.push('--ignore-case');
  if (options.filePattern) args.push('--glob', options.filePattern);
  if (options.maxResults) args.push('--max-count', String(options.maxResults));

  args.push(pattern, fullPath);

  try {
    const { stdout } = await execa('rg', args);
    if (!stdout) return 'No matches found';
    if (stdout.length > MAX_CHARS) {
      return stdout.slice(0, MAX_CHARS) + `\n... (truncated)`;
    }
    return stdout;
  } catch (err: unknown) {
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (exitCode === 1) return 'No matches found';
    return `Search error: ${(err as Error).message}`;
  }
}
