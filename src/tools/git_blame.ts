import { execa } from 'execa';
import { resolve } from 'path';

interface BlameLine {
  lineNum: number;
  hash: string;
  author: string;
  date: string;
  summary: string;
  content: string;
}

export async function gitBlame(
  filepath: string,
  lineStart: number,
  lineEnd: number,
  workdir?: string,
): Promise<string> {
  const absPath = workdir ? resolve(workdir, filepath) : filepath;

  let stdout: string;
  try {
    const result = await execa(
      'git',
      ['blame', '--line-porcelain', `-L${lineStart},${lineEnd}`, absPath],
      { cwd: workdir },
    );
    stdout = result.stdout;
  } catch (err) {
    return `git blame failed: ${(err as Error).message}`;
  }

  return parsePorcelain(stdout, lineStart);
}

function parsePorcelain(output: string, startLine: number): string {
  const lines = output.split('\n');
  const result: BlameLine[] = [];

  let i = 0;
  let lineNum = startLine;
  while (i < lines.length) {
    const header = lines[i];
    if (!header || !/^[0-9a-f]{40}/.test(header)) { i++; continue; }

    const hash = header.slice(0, 7);
    let author = '';
    let date = '';
    let summary = '';

    // Read key-value headers until we hit the tab-prefixed content line.
    i++;
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const line = lines[i];
      if (line.startsWith('author ') && !line.startsWith('author-')) author = line.slice(7);
      else if (line.startsWith('author-time ')) {
        const ts = parseInt(line.slice(12), 10);
        date = new Date(ts * 1000).toISOString().slice(0, 10);
      } else if (line.startsWith('summary ')) summary = line.slice(8);
      i++;
    }

    const content = lines[i] ? lines[i].slice(1) : '';
    result.push({ lineNum, hash, author, date, summary, content });
    lineNum++;
    i++;
  }

  if (result.length === 0) return '(no blame data found)';

  const rows = result.map(r =>
    `${String(r.lineNum).padStart(4)} ${r.hash} ${r.date} ${r.author.padEnd(20).slice(0, 20)} ${r.summary.slice(0, 40).padEnd(40)} │ ${r.content}`,
  );

  return ['line hash    date       author               commit message                           │ content', ...rows].join('\n');
}
