import { resolve, join } from 'path';
import { readFileSync, readdirSync, statSync } from 'fs';
import { getLspClient, formatLocation } from '../lsp/client.js';

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '__pycache__']);

// Delay after opening all files to give LSP time to index the workspace
const INDEX_DELAY_MS = 1500;

export async function findSymbol(
  symbol: string,
  file: string,
  workdir: string,
): Promise<string> {
  const absWorkdir = resolve(workdir);
  const absFile = resolve(workdir, file);

  let client;
  try {
    client = await getLspClient(absWorkdir);
  } catch (err) {
    return `LSP unavailable: ${(err as Error).message}`;
  }

  // Open every TS/JS file in the workspace so the LSP can resolve cross-file refs.
  // openDocument is idempotent (skips already-opened files).
  const allFiles = collectTsFiles(absWorkdir);
  for (const f of allFiles) client.openDocument(f);

  // Find where the symbol appears in the requested file
  let content: string;
  try {
    content = readFileSync(absFile, 'utf-8');
  } catch (err) {
    return `Cannot read ${file}: ${(err as Error).message}`;
  }

  const lines = content.split('\n');
  const symbolRe = new RegExp(`\\b${escapeRegex(symbol)}\\b`);

  let foundLine = -1;
  let foundChar = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = symbolRe.exec(lines[i]);
    if (m) {
      foundLine = i;
      foundChar = m.index;
      break;
    }
  }

  if (foundLine === -1) {
    return `Symbol '${symbol}' not found in ${file}`;
  }

  // Wait for LSP to process the opened files
  await delay(INDEX_DELAY_MS);

  const out: string[] = [];

  // Definition
  try {
    const defs = await client.getDefinition(absFile, foundLine, foundChar);
    if (defs.length > 0) {
      out.push(`Definition of '${symbol}':`);
      for (const loc of defs) {
        out.push(`  ${formatLocation(loc, absWorkdir)}`);
      }
    } else {
      out.push(`Definition of '${symbol}': not found`);
    }
  } catch (err) {
    out.push(`Definition lookup failed: ${(err as Error).message}`);
  }

  // References (from definition location for best cross-file coverage)
  const defFile = absFile;
  const defLine = foundLine;
  const defChar = foundChar;

  try {
    const refs = await client.getReferences(defFile, defLine, defChar);
    if (refs.length > 0) {
      out.push(`\nReferences to '${symbol}' (${refs.length}):`);
      for (const loc of refs.slice(0, 25)) {
        out.push(`  ${formatLocation(loc, absWorkdir)}`);
      }
      if (refs.length > 25) out.push(`  … and ${refs.length - 25} more`);
    } else {
      out.push(`\nNo references found for '${symbol}'`);
    }
  } catch (err) {
    out.push(`References lookup failed: ${(err as Error).message}`);
  }

  return out.join('\n');
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  walkTs(dir, results);
  return results;
}

function walkTs(dir: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, out);
    } else {
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && TS_EXTS.has(entry.name.slice(dot))) {
        out.push(full);
      }
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
