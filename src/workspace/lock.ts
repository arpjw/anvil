import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function workspaceStatePath(root: string, kind: string): string {
  const dir = join(tmpdir(), 'anvil-workspace-state');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${createHash('sha256').update(root).digest('hex')}.${kind}`);
}

/** Exclusive process lease. Reclaim dead owners under a separate recovery lease. */
export function lockWorkspace(root: string, kind: string): () => void {
  const path = workspaceStatePath(root, `${kind}.lock`);
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const acquire = () => writeFileSync(path, token, { flag: 'wx', mode: 0o600 });
  try { acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recovery = `${path}.reclaim`;
    try { mkdirSync(recovery); }
    catch { throw new Error(`Workspace ${kind} recovery is already in progress.`); }
    try {
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid workspace lock.');
        let alive = true;
        try { process.kill(owner.pid, 0); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error(`Workspace ${kind} is already active (PID ${owner.pid}).`);
        rmSync(path);
      }
      acquire();
    } finally { rmSync(recovery, { recursive: true }); }
  }
  return () => {
    if (existsSync(path) && readFileSync(path, 'utf8') === token) rmSync(path);
  };
}
