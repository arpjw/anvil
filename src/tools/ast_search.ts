import micromatch from 'micromatch';
import { resolve, join, relative } from 'path';
import { readdirSync, statSync } from 'fs';
import { parseFile, queryNodes, type QueryType } from '../treesitter/index.js';

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', 'build']);
const MAX_OUTPUT_CHARS = 20_000;

export async function astSearch(
  queryType: QueryType,
  searchPath: string,
  workdir: string,
  filePattern?: string,
  ignorePatterns?: string[],
): Promise<string> {
  const fullPath = resolve(workdir, searchPath);
  const files = collectFiles(fullPath, workdir, filePattern, ignorePatterns);

  if (files.length === 0) {
    return `No supported files found at ${searchPath} (supports .ts, .tsx, .js, .py)`;
  }

  const lines: string[] = [];

  for (const file of files) {
    let parsed;
    try {
      parsed = parseFile(file);
    } catch {
      continue;
    }
    if (!parsed) continue;

    const nodes = queryNodes(parsed.tree, queryType);
    if (nodes.length === 0) continue;

    const relPath = relative(workdir, file);
    lines.push(`${relPath}:`);
    for (const node of nodes) {
      lines.push(`  ${node.name}  [${node.kind}, lines ${node.startLine}–${node.endLine}]`);
    }
  }

  if (lines.length === 0) {
    return `No ${queryType} found in ${searchPath}`;
  }

  const result = lines.join('\n');
  if (result.length > MAX_OUTPUT_CHARS) {
    return result.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated)';
  }
  return result;
}

function collectFiles(
  target: string,
  workdir: string,
  filePattern?: string,
  ignorePatterns?: string[],
): string[] {
  try {
    const stat = statSync(target);
    if (stat.isFile()) {
      if (!isSupportedFile(target)) return [];
      if (ignorePatterns && isIgnored(relative(workdir, target), ignorePatterns)) return [];
      return [target];
    }
  } catch {
    return [];
  }

  const results: string[] = [];
  walk(target, workdir, results, filePattern, ignorePatterns);
  return results;
}

function walk(
  dir: string,
  workdir: string,
  out: string[],
  filePattern?: string,
  ignorePatterns?: string[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(workdir, fullPath);

    if (ignorePatterns && isIgnored(relPath, ignorePatterns)) continue;

    if (entry.isDirectory()) {
      walk(fullPath, workdir, out, filePattern, ignorePatterns);
    } else if (isSupportedFile(entry.name) && matchesPattern(entry.name, filePattern)) {
      out.push(fullPath);
    }
  }
}

function isIgnored(relPath: string, patterns: string[]): boolean {
  const normalized = patterns.map(p => (p.endsWith('/') ? p + '**' : p));
  return micromatch.isMatch(relPath, normalized, { dot: true });
}

function isSupportedFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return SUPPORTED_EXTS.has(name.slice(dot));
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(name);
}
