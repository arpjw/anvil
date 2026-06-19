import { simpleGit, type DefaultLogFields } from 'simple-git';

export async function gitLog(workdir: string, limit = 10): Promise<string> {
  const git = simpleGit(workdir);
  const log = await git.log({ maxCount: limit });

  if (log.total === 0) return 'No commits found.';

  const lines: string[] = [];
  for (const commit of log.all as DefaultLogFields[]) {
    // Summarize files changed per commit; skip if this is the root commit.
    let filesSummary = '';
    try {
      const diff = await git.diffSummary([`${commit.hash}^`, commit.hash]);
      const names = diff.files.map((f: { file: string }) => f.file).slice(0, 5);
      filesSummary = names.length ? `  files: ${names.join(', ')}` : '';
    } catch {}

    lines.push(
      `${commit.hash.slice(0, 7)} | ${commit.date.slice(0, 10)} | ${commit.author_name} | ${commit.message}` +
      (filesSummary ? `\n${filesSummary}` : ''),
    );
  }

  return lines.join('\n\n');
}
