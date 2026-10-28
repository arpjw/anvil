import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';

/** Resolve a project file, including symlinks, without allowing workspace escapes. */
export function workspacePath(workdir: string, path: string): string {
  if (!path || path.includes('\0')) throw new Error('A valid file path is required.');
  const lexicalRoot = resolve(workdir);
  const root = realpathSync(lexicalRoot);
  const requested = resolve(lexicalRoot, path);
  const lexicalRel = relative(lexicalRoot, requested);
  const target = lexicalRel !== '..' && !lexicalRel.startsWith(`..${sep}`) && !isAbsolute(lexicalRel)
    ? resolve(root, lexicalRel) : requested;
  const inside = (candidate: string): boolean => {
    const rel = relative(root, candidate);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(target) || target === root) throw new Error('File must be inside the workspace.');
  if (relative(root, target).split(sep).includes('.git')) throw new Error('Editing Git metadata is not allowed.');
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realAncestor = realpathSync(ancestor);
  if (!inside(realAncestor) || relative(root, realAncestor).split(sep).includes('.git')) {
    throw new Error('Symlink points outside the workspace or into Git metadata.');
  }
  return target;
}
