import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIPPED = new Set(['node_modules', '.next', '.git', 'dist', 'coverage']);

/** Every file under `dir` whose name ends with one of `extensions`, depth-first, paths absolute. */
export function walkFiles(dir: string, extensions: readonly string[] = ['.ts', '.tsx']): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walkFiles(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}
