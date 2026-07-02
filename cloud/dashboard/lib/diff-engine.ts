import { structuredPatch } from 'diff';

export interface DiffHunk {
  header: string;
  lines: string[];
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileDiff {
  filepath: string;
  hunks: DiffHunk[];
}

export function generateDiff(
  originalContent: string,
  newContent: string,
  filepath: string,
): FileDiff {
  const patch = structuredPatch(
    filepath,
    filepath,
    originalContent,
    newContent,
    '',
    '',
    { context: 3 },
  );
  const hunks: DiffHunk[] = patch.hunks.map((h) => ({
    header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    lines: h.lines,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
  }));
  return { filepath, hunks };
}

export function applySelectedHunks(
  originalContent: string,
  hunks: DiffHunk[],
  acceptedHunkIndices: Set<number>,
): string {
  const origLines = originalContent.split('\n');
  const resultLines: string[] = [];
  let origPos = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const hunkOrigStart = hunk.oldStart - 1;

    while (origPos < hunkOrigStart) {
      resultLines.push(origLines[origPos++]);
    }

    if (acceptedHunkIndices.has(i)) {
      for (const line of hunk.lines) {
        if (line[0] === '+') {
          resultLines.push(line.slice(1));
        } else if (line[0] === '-') {
          origPos++;
        } else {
          resultLines.push(origLines[origPos++]);
        }
      }
    } else {
      for (let j = 0; j < hunk.oldLines; j++) {
        resultLines.push(origLines[origPos++]);
      }
    }
  }

  while (origPos < origLines.length) {
    resultLines.push(origLines[origPos++]);
  }

  return resultLines.join('\n');
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export function statsForHunks(hunks: DiffHunk[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line[0] === '+') additions++;
      else if (line[0] === '-') deletions++;
    }
  }
  return { additions, deletions };
}
