import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export async function writeFile(
  path: string,
  content: string,
  workdir: string,
): Promise<string> {
  const fullPath = resolve(workdir, path);
  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    return `Wrote ${fullPath}`;
  } catch (err) {
    return `Error writing ${path}: ${(err as Error).message}`;
  }
}
