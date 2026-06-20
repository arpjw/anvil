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

export function generateDiff(originalContent: string, newContent: string, filepath: string): FileDiff {
  const patch = structuredPatch(filepath, filepath, originalContent, newContent, '', '', { context: 3 });
  const hunks: DiffHunk[] = patch.hunks.map(h => ({
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
    const hunkOrigStart = hunk.oldStart - 1; // convert to 0-indexed

    // Copy lines before this hunk
    while (origPos < hunkOrigStart) {
      resultLines.push(origLines[origPos++]);
    }

    if (acceptedHunkIndices.has(i)) {
      // Apply the hunk: output '+' lines, skip '-' lines, copy ' ' lines
      for (const line of hunk.lines) {
        if (line[0] === '+') {
          resultLines.push(line.slice(1));
        } else if (line[0] === '-') {
          origPos++; // consume original line without emitting
        } else {
          resultLines.push(origLines[origPos++]); // context line
        }
      }
    } else {
      // Reject the hunk: keep original lines
      for (let j = 0; j < hunk.oldLines; j++) {
        resultLines.push(origLines[origPos++]);
      }
    }
  }

  // Copy remaining lines after last hunk
  while (origPos < origLines.length) {
    resultLines.push(origLines[origPos++]);
  }

  return resultLines.join('\n');
}
