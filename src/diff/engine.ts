import { applyPatch, structuredPatch } from 'diff';

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
  for (const index of acceptedHunkIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length) {
      throw new Error(`Invalid hunk index: ${index}`);
    }
  }
  // Let diff handle empty files, EOF markers, CRLF, and insertion offsets.
  let offset = 0;
  const selected = hunks.flatMap((hunk, index) => {
    if (!acceptedHunkIndices.has(index)) return [];
    const next = { ...hunk, newStart: hunk.oldStart + offset };
    offset += hunk.newLines - hunk.oldLines;
    return [next];
  });
  if (selected.length === 0) return originalContent;
  const result = applyPatch(originalContent, { oldFileName: 'file', newFileName: 'file', oldHeader: '', newHeader: '', hunks: selected });
  if (result === false) throw new Error('Selected diff no longer applies to the original file.');
  return result;
}
