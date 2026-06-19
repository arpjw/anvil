import { simpleGit } from 'simple-git';

export async function gitDiff(
  workdir: string,
  mode: 'staged' | 'unstaged' | 'all' = 'all',
): Promise<string> {
  const git = simpleGit(workdir);

  let staged = '';
  let unstaged = '';

  if (mode === 'staged' || mode === 'all') {
    staged = await git.diff(['--cached']);
  }
  if (mode === 'unstaged' || mode === 'all') {
    unstaged = await git.diff();
  }

  const parts: string[] = [];
  if (staged) parts.push(`=== staged ===\n${staged}`);
  if (unstaged) parts.push(`=== unstaged ===\n${unstaged}`);

  return parts.join('\n') || '(no changes)';
}
