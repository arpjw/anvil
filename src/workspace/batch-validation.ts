import ts from 'typescript';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const EXCLUDED = new Set(['.git', '.anvil', 'node_modules']);
export interface Snapshot { fingerprint: string; configs: string[] }

/** Snapshot project files only. Dependencies are read by the compiler, never executed. */
export function snapshotProject(root: string, destination?: string): Snapshot {
  const hash = createHash('sha256');
  const configs: string[] = [];
  let bytes = 0, count = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (EXCLUDED.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) {
        if (destination && entry.name === 'node_modules') {
          const dest = join(destination, rel);
          mkdirSync(dirname(dest), { recursive: true });
          symlinkSync(realpathSync(path), dest, 'junction');
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Never stage a writable alias to the source checkout.
        throw new Error(`Transaction cannot snapshot symlink: ${rel}`);
      }
      if (entry.isDirectory()) { if (destination) mkdirSync(join(destination, rel), { recursive: true }); walk(path); }
      else if (entry.isFile()) {
        const stat = lstatSync(path);
        if (++count > 20_000 || (bytes += stat.size) > 100 * 1024 * 1024) throw new Error('Transaction snapshot exceeds 20,000 files or 100 MiB.');
        const content = readFileSync(path);
        hash.update(rel).update('\0').update(String(stat.mode)).update('\0').update(content).update('\0');
        if (destination) copyFileSync(path, join(destination, rel));
        if (entry.name === 'tsconfig.json' || /^tsconfig\..+\.json$/.test(entry.name)) configs.push(rel);
      }
    }
  };
  walk(root);
  return { fingerprint: hash.digest('hex'), configs };
}

export function validateCandidate(root: string, changedPaths: string[]): string[] {
  for (const path of changedPaths) {
    if (path.endsWith('.json') && basename(path) !== 'tsconfig.json' && !basename(path).startsWith('tsconfig.') && existsSync(join(root, path))) {
      try { JSON.parse(readFileSync(join(root, path), 'utf8')); }
      catch (error) { return [`${path}: ${(error as Error).message}`]; }
    }
  }
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  const diagnostics: ts.Diagnostic[] = [];
  const seen = new Set<string>();
  const inside = (path: string): boolean => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };
  const checkProgram = (program: ts.Program): void => {
    for (const source of program.getSourceFiles()) {
      if (!source.isDeclarationFile && !inside(source.fileName) && !source.fileName.split(/[\\/]/).includes('node_modules')) {
        throw new Error(`Batch validation cannot use source outside the staged project: ${source.fileName}`);
      }
    }
    diagnostics.push(...ts.getPreEmitDiagnostics(program));
  };
  const checkConfig = (path: string): void => {
    if (!inside(path)) throw new Error('Batch validation cannot follow a project reference outside the staged project.');
    if (seen.has(path)) return;
    seen.add(path);
    const raw = ts.readConfigFile(path, ts.sys.readFile);
    if (raw.error) { diagnostics.push(raw.error); return; }
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(path), { noEmit: true }, path);
    diagnostics.push(...parsed.errors);
    for (const ref of parsed.projectReferences ?? []) checkConfig(ts.resolveProjectReferencePath(ref));
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
    checkProgram(program);
  };
  if (configPath && relative(root, configPath).split(/[\\/]/)[0] !== '..') checkConfig(configPath);
  // Nested packages are checked independently when a changed file belongs to them.
  for (const file of changedPaths.filter(f => /\.[cm]?[jt]sx?$/.test(f) || /^tsconfig(?:\..+)?\.json$/.test(basename(f)))) {
    let dir = dirname(join(root, file));
    while (dir.startsWith(root) && dir !== root) {
      const config = join(dir, 'tsconfig.json');
      if (existsSync(config)) { checkConfig(config); break; }
      dir = dirname(dir);
    }
  }
  if (!seen.size) {
    const paths = changedPaths.filter(f => /\.[cm]?[jt]sx?$/.test(f) && existsSync(join(root, f))).map(f => join(root, f));
    if (paths.length) checkProgram(ts.createProgram(paths, {
      noEmit: true, allowJs: true, checkJs: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.ReactJSX,
    }));
  }
  return diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).slice(0, 40).map(d => {
    const loc = d.file && d.start !== undefined ? `${relative(root, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ` : '';
    return `${loc}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}
