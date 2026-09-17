#!/usr/bin/env node
/**
 * Documentation link gate.
 *
 * The reference pages cross-link heavily and are written per layer, so a renamed file or a
 * typo silently produces a dead link. Markdown gives no compile-time help, so this walks
 * every document and verifies that each relative link resolves to something on disk.
 *
 * Deliberately narrow: it checks RELATIVE links only. External URLs are not fetched —
 * a network check would make `pnpm run verify` fail for reasons unrelated to the change.
 *
 * Usage:  node tools/check-docs.mjs [--json]
 * Exit:   0 = every relative link resolves, 1 = at least one does not
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
/** Files that are templates rather than documents, and may reference examples. */
const SKIP_FILES = new Set(['docs/reference/_TEMPLATE.md']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const roots = ['README.md', 'CONTRIBUTING.md', 'GOVERNANCE.md', 'CHANGELOG.md', 'docs']
  .map((p) => path.join(ROOT, p))
  .filter((p) => existsSync(p));

const files = [];
for (const entry of roots) {
  if (statSync(entry).isDirectory()) walk(entry, files);
  else files.push(entry);
}

/** `[text](target)` -- but not `![...]` images inside code fences. */
const LINK = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

let checked = 0;
const broken = [];

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (SKIP_FILES.has(rel)) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    for (const match of line.matchAll(LINK)) {
      const raw = match[1];
      if (!raw) continue;
      // Only relative links are in scope.
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      if (raw.startsWith('#')) continue;

      const target = raw.split('#')[0];
      if (target === '') continue;

      checked += 1;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      if (!existsSync(resolved)) {
        broken.push({ file: rel, line: index + 1, link: raw });
      }
    }
  });
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ok: broken.length === 0, checked, broken }, null, 2)}\n`);
  process.exit(broken.length === 0 ? 0 : 1);
}

if (broken.length === 0) {
  process.stdout.write(`doc links: ${checked} relative link(s) checked, all resolve\n`);
  process.exit(0);
}

const lines = [`doc links: ${broken.length} broken of ${checked} checked`, ''];
for (const item of broken) lines.push(`  ${item.file}:${item.line}  ->  ${item.link}`);
lines.push('');
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(1);
