/**
 * Which files a gate walks.
 *
 * Three gates each carried their own idea of "not source" — `.gitignore` listed five
 * directories, `check-docs.mjs` skipped four, `check-duplicates.mjs` skipped five
 * differently — so `tmp/` was excluded from one and scanned by another, and `build/`
 * was excluded from neither consistently. A scratch file dropped in `tmp/` changed
 * `check-docs`'s file count, which is how the divergence was noticed.
 *
 * One definition, taken from the directories `.gitignore` already marks as non-source.
 * A gate that walks a different set than its siblings produces a coverage number that
 * means something different, and the numbers are reported side by side.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'tmp']);

/** Every `.md` file under `root`, excluding the directories above. */
export function markdownFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** A path relative to the repository root, always with forward slashes. */
export const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
