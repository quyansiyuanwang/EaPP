#!/usr/bin/env node
/**
 * Count gate.
 *
 * The invariant counts appear in twenty-odd places across the documentation: the
 * README badge block, the conformance claim, the coverage tables, two guides, the
 * changelog, the harness README. Every one of them is a number a human typed, and
 * every one of them has been wrong at least once — 50/50 when v3.0 had 51, 74/74 when
 * v3.1 had 75, 209/209 when the stack had 210. Each was found by someone noticing,
 * which is not a mechanism.
 *
 * The counts are already computed: `check-invariants --json` returns the declared and
 * covered count for each layer. This compares the prose against that.
 *
 * Deliberately narrow. It checks the numbers that appear in an invariant context —
 * `N / M` beside 不变量, `N 条` before it, the claim's passed/total pair, and the
 * per-layer rows that name a layer. It does not try to check every integer in the
 * documentation; that would report the harness's 33 and the suite's 200 as errors.
 *
 * Usage: node tools/check-counts.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The gate the counts are derived from — never a hard-coded literal. */
const report = JSON.parse(
  execFileSync('node', [path.join(ROOT, 'tools', 'check-invariants.mjs'), '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  }),
).report;

const layers = new Map();
for (const entry of report) {
  layers.set(entry.layer, { declared: entry.declaredCount, covered: entry.coveredCount });
}
const totalDeclared = [...layers.values()].reduce((sum, l) => sum + l.declared, 0);
const totalCovered = [...layers.values()].reduce((sum, l) => sum + l.covered, 0);

const DOCS = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'docs/README.md',
  'docs/CONFORMANCE.md',
  'docs/spec/CHANGELOG.md',
  'docs/guides/getting-started.md',
  'docs/guides/implement-in-another-language.md',
  'conformance/README.md',
  'conformance/driver.md',
];

const problems = [];
const check = (file, line, what, got, want) => {
  if (got !== want) problems.push({ file, line, what, got, want });
};

/**
 * A changelog's older sections state the counts of *that release* — a 3.2.0 entry
 * saying v3.1 had 74 invariants was true then and becomes a lie if updated. Only the
 * newest section is current, so only that one is checked.
 */
function currentSection(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) starts.push(i);
  });
  if (starts.length === 0) return { from: 0, to: lines.length };
  return { from: starts[0], to: starts.length > 1 ? starts[1] : lines.length };
}

for (const rel of DOCS) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  const isChangelog = /CHANGELOG\.md$/.test(rel);
  const { from, to } = isChangelog ? currentSection(text) : { from: 0, to: Number.MAX_SAFE_INTEGER };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (isChangelog && (index < from || index >= to)) return;
    const tag = `**${raw.trim().slice(0, 90)}**`;

    // `210 / 210 不变量`, `51 / 51 不变量` — covered over declared on the same line.
    const ratio = raw.match(/(\d+)\s*\/\s*(\d+)[^\n]*不变量/);
    if (ratio) {
      const [, covered, declared] = ratio.map(Number);
      const layer = [...layers.entries()].find(([, v]) => v.declared === declared && v.covered === covered);
      const isTotal = declared === totalDeclared && covered === totalCovered;
      if (!layer && !isTotal) {
        problems.push({ file: rel, line, what: tag, got: `${covered}/${declared}`, want: 'a layer or the stack total' });
      }
    }

    // `210 条不变量` — the number immediately qualifies 不变量. A looser match picks up
    // the harness's check count and the suite's test count on the same line.
    for (const m of raw.matchAll(/(\d+)\s*条\s*不变量/g)) {
      const n = Number(m[1]);
      const known = [totalDeclared, ...[...layers.values()].map((l) => l.declared)];
      if (!known.includes(n)) {
        problems.push({ file: rel, line, what: tag, got: `${n} 条不变量`, want: `one of ${known.join(', ')}` });
      }
    }

    // The conformance claim's passed/total pair.
    const claim = raw.match(/"passed":\s*(\d+)\s*,\s*"total":\s*(\d+)/);
    if (claim) {
      check(rel, line, `${tag} (passed)`, Number(claim[1]), totalCovered);
      check(rel, line, `${tag} (total)`, Number(claim[2]), totalDeclared);
    }

    // A per-layer coverage row that names the layer.
    const row = raw.match(/^\|\s*(v3\.\d\.\d-\w+)\s*\|/);
    if (row) {
      const layer = layers.get(row[1]);
      if (layer) {
        for (const m of raw.matchAll(/\*\*(\d+)\s*\/\s*(\d+)\*\*|(\d+)\s*\/\s*(\d+)/g)) {
          const covered = Number(m[1] ?? m[3]);
          const declared = Number(m[2] ?? m[4]);
          check(rel, line, `${tag} → ${row[1]}`, `${covered}/${declared}`, `${layer.covered}/${layer.declared}`);
        }
      }
    }
  });
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ totals: { totalDeclared, totalCovered }, problems }, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

process.stdout.write(
  `counts: ${totalCovered}/${totalDeclared} across ${layers.size} layer(s), checked against ${DOCS.length} document(s)\n`,
);

if (problems.length === 0) {
  process.exit(0);
}

process.stdout.write(`\n${problems.length} stale count(s):\n\n`);
for (const p of problems) {
  process.stdout.write(`  ${p.file}:${p.line}\n      ${p.what}\n      says ${p.got}, should be ${p.want}\n`);
}
process.exit(1);
