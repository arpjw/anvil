import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type CommandPolicy = 'ask' | 'allow' | 'deny';
export interface ExecutionContext {
  root: string;
  commands: CommandPolicy;
}
const storage = new AsyncLocalStorage<ExecutionContext>();
export const withExecutionContext = <T>(context: ExecutionContext, fn: () => T): T => storage.run(context, fn);
export const executionContext = (): ExecutionContext | undefined => storage.getStore();

export function commandDirectory(workdir: string): string {
  const dir = realpathSync(resolve(workdir));
  const context = storage.getStore();
  if (context) {
    const rel = relative(realpathSync(context.root), dir);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes('.git')) {
      throw new Error('Command working directory must be inside the session workspace.');
    }
  }
  return dir;
}
