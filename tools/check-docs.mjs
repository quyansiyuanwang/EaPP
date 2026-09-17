#!/usr/bin/env node
/**
 * Documentation gate. Two independent rules, both of which had drifted before
 * anything checked them:
 *
 *   1. Every relative link resolves. Markdown gives no compile-time help, and the
 *      reference pages cross-link heavily, so a rename or a typo produces a dead
 *      link silently.
 *
 *   2. Prose register. `docs/STYLE.md` §5 forbids the second person, and that rule
 *      was written down and then violated throughout — including by the documents
 *      that state it. A style rule nothing enforces is a style preference.
 *
 * Deliberately narrow: links are checked RELATIVE only (a network check would make
 * `pnpm run verify` fail for reasons unrelated to the change), and the register
 * rule checks for markers that are unambiguous rather than attempting to judge
 * prose.
 *
 * Usage:  node tools/check-docs.mjs [--json]
 * Exit:   0 = all rules pass, 1 = at least one violation
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

/**
 * Every .md file in the repository is in scope, not just `docs/`. A document that lives
 * outside the scanned set is a document whose links are never checked — and the examples
 * index cross-links back into `docs/`, so leaving it out would have made the gate quietly
 * narrower than the documentation surface it claims to cover.
 */
const roots = ['README.md', 'CONTRIBUTING.md', 'GOVERNANCE.md', 'CHANGELOG.md', 'docs', 'examples']
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

// ---------------------------------------------------------------------------
// Rule 2: prose register (docs/STYLE.md §5)
// ---------------------------------------------------------------------------

/**
 * Files that may contain the second person, and why.
 *
 * `docs/STYLE.md` states the rule and `_TEMPLATE.md` restates it for reference-page
 * authors; both necessarily quote the construction they forbid. An allowlist of two
 * files whose reason is "they are where the rule is written" is not a loophole —
 * anything else needs to pass.
 */
const REGISTER_ALLOWED = new Set(['docs/STYLE.md', 'docs/reference/_TEMPLATE.md']);

/** Unambiguous markers of conversational register. Judgement calls are left to review. */
const REGISTER_RULES = [
  { pattern: /你/g, why: '第二人称（STYLE §5：直接陈述约束，不面向读者说话）' },
  { pattern: /说白了|就是说吧|别用|别把|这不是吗/g, why: '口语化措辞' },
  { pattern: /说到底|归根结底就是/g, why: '修辞性收束' },
];

const register = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (REGISTER_ALLOWED.has(rel)) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return; // code samples are verbatim, not prose
    for (const rule of REGISTER_RULES) {
      if (rule.pattern.test(line)) {
        register.push({ file: rel, line: index + 1, why: rule.why, text: line.trim().slice(0, 80) });
      }
      rule.pattern.lastIndex = 0;
    }
  });
}

// ---------------------------------------------------------------------------

if (process.argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({ ok: broken.length === 0 && register.length === 0, checked, broken, register }, null, 2)}\n`,
  );
  process.exit(broken.length === 0 && register.length === 0 ? 0 : 1);
}

if (broken.length === 0 && register.length === 0) {
  process.stdout.write(`doc links: ${checked} relative link(s) checked, all resolve\n`);
  process.stdout.write(`doc register: ${files.length} file(s) checked, no violations\n`);
  process.exit(0);
}

const lines = [];
if (broken.length > 0) {
  lines.push(`doc links: ${broken.length} broken of ${checked} checked`, '');
  for (const item of broken) lines.push(`  ${item.file}:${item.line}  ->  ${item.link}`);
  lines.push('');
}
if (register.length > 0) {
  lines.push(`doc register: ${register.length} violation(s)`, '');
  for (const item of register) lines.push(`  ${item.file}:${item.line}  ${item.why}\n      ${item.text}`);
  lines.push('');
}
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(1);
