#!/usr/bin/env node
/**
 * EaPP freeze gate — invariant coverage.
 *
 * The rule this enforces is not invented here:
 *
 *   v3.0 §19.2 (FROZEN): 每个不变量 MUST 至少有一个对应的测试用例
 *   v3.2 §14 (D-38):     every invariant MUST have a test, or carry an explicit
 *                        `[covered by: <path>]` annotation pointing elsewhere;
 *                        a test body MUST NOT be empty.
 *
 * It extracts the invariant IDs a spec declares, extracts the IDs its conformance
 * suite names, and fails when the difference is non-empty in either direction.
 *
 * Usage:  node tools/check-invariants.mjs [--json]
 * Exit:   0 = gate passes, 1 = gate fails
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which conformance suite owns which spec.
 * The IDs are only unique *within* a layer: v3.0 uses L-1..L-6 for Lifecycle while
 * v3.1 uses L-1..L-7 for Lease, and both use CH-*. Coverage is therefore checked
 * per spec, never globally.
 */
const MANIFEST = [
  {
    layer: 'v3.0.0-core',
    spec: 'docs/spec/v3.0.0-core.md',
    tests: ['tests/conformance/core.test.ts'],
  },
  {
    layer: 'v3.1.0-interaction',
    spec: 'docs/spec/v3.1.0-interaction.md',
    tests: ['tests/conformance/interaction.test.ts'],
  },
  {
    layer: 'v3.2.0-state',
    spec: 'docs/spec/v3.2.0-state.md',
    tests: ['tests/conformance/state.test.ts'],
  },
];

/** `ID-1` … `ID-9`, `CH-1..CH-6`, `L-1..L-7` — a summary line starts with the ID. */
const SUMMARY_LINE = /^\s*([A-Z]{1,6}-)(\d{1,3})(?:\s*\.\.\s*(?:([A-Z]{1,6})-)?(\d{1,3}))?\b/;
const COVERED_BY = /\[covered by:\s*([^\]]+)\]/;
const ANY_ID = /\b([A-Z]{1,6}-\d{1,3})\b/g;
/** Only IDs appearing in a test/describe *name* count as coverage. */
const TEST_NAME = /\b(?:test|it|describe)(?:\.\w+)?\(\s*(['"`])([\s\S]*?)\1/g;

function expand(prefix, from, toPrefix, to) {
  const lo = Number(from);
  const hi = to === undefined ? lo : Number(to);
  // `m[3]` captures only the letters of a range's upper bound ('CH' out of 'CH-6'),
  // so the dash has to be restored here. Using `prefix` directly for single IDs keeps
  // `CH-1` and `CH-1..CH-6` producing the same identifiers.
  const head = toPrefix ? `${toPrefix}-` : prefix;
  const out = [];
  for (let i = lo; i <= hi; i += 1) out.push(`${head}${i}`);
  return out;
}

/** Invariants a spec file declares, plus any explicit coverage redirection. */
function extractSpecInvariants(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const lines = text.split(/\r?\n/);

  // Only the dedicated invariant-summary section declares invariants. Scanning the whole
  // document would also pick up cross-layer references — v3.2's prose cites v3.1's CR-3 —
  // which would inflate this layer's declared set with IDs it does not own.
  let start = -1;
  let level = 0;
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading || !/不变量/.test(heading[2])) return;
    start = index + 1;
    level = heading[1].length;
  });
  if (start < 0) throw new Error(`${file}: no invariant summary section found`);

  const declared = new Map(); // id -> { line, coveredBy|null }
  let end = lines.length;

  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    const heading = /^(#{1,6})\s/.exec(raw);
    if (heading && heading[1].length <= level) {
      end = i;
      break;
    }

    const m = SUMMARY_LINE.exec(raw);
    if (!m) continue;
    const [prefix, from, toPrefix, to] = [m[1], m[2], m[3], m[4]];
    const covered = COVERED_BY.exec(raw);
    for (const id of expand(prefix, from, toPrefix, to)) {
      if (!declared.has(id)) {
        declared.set(id, { line: i + 1, coveredBy: covered ? covered[1].trim() : null });
      }
    }
  }

  // The body — everything except the summary block. An invariant that appears ONLY in the
  // summary is listed but never actually stated, which reads as a complete invariant to a
  // reader and to this gate. That is how v3.1 lost CC-1 and CC-2 for a while: the summary
  // carried the IDs, the body stated nothing, and every check still passed.
  const body = [...lines.slice(0, start - 1), ...lines.slice(end)].join('\n');

  return { declared, body };
}

/** Invariant IDs named by a conformance suite, and the ids of tests with empty bodies. */
function extractTestFacts(files) {
  const named = new Set();
  const empty = [];
  const missing = [];

  for (const file of files) {
    const abs = path.join(ROOT, file);
    if (!existsSync(abs)) {
      missing.push(file);
      continue;
    }
    const text = readFileSync(abs, 'utf8');

    for (const m of text.matchAll(TEST_NAME)) {
      const label = m[2];
      for (const id of label.match(ANY_ID) ?? []) named.add(id);
    }

    // Empty-body detection: from each test declaration, walk forward to the opening
    // brace of the callback, brace-match to its close, and look for an assertion.
    const decl = /\b(?:test|it)\(\s*(['"`])([\s\S]*?)\1\s*,\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{|\b(?:test|it)\(\s*(['"`])([\s\S]*?)\3\s*,\s*(?:async\s*)?function\s*\([^)]*\)\s*(?::[^=]+)?\s*\{/g;
    for (const m of text.matchAll(decl)) {
      const label = m[2] ?? m[4];
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) continue;
      const body = text.slice(open + 1, end);
      const asserts =
        /\bexpect\s*\(|\bassert\b|\bexpectTypeOf\b|\.toThrow|\.rejects|\.resolves/.test(body);
      if (!asserts) empty.push({ file, line: text.slice(0, m.index).split('\n').length, label });
    }
  }

  return { named, empty, missing };
}

function main() {
  const asJson = process.argv.includes('--json');
  const report = [];
  let failed = false;

  for (const entry of MANIFEST) {
    const { declared, body } = extractSpecInvariants(entry.spec);
    const { named, empty, missing } = extractTestFacts(entry.tests);

    const uncovered = [];
    const undeclaredInBody = [];
    for (const [id, meta] of declared) {
      // Declared in the summary but never stated in the body: the ID exists, the rule does not.
      if (!new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) {
        undeclaredInBody.push({ id, line: meta.line });
      }
      if (named.has(id)) continue;
      if (meta.coveredBy) continue;
      uncovered.push({ id, line: meta.line });
    }
    uncovered.sort((a, b) => a.line - b.line);
    undeclaredInBody.sort((a, b) => a.line - b.line);

    const unknown = [...named]
      .filter((id) => !declared.has(id))
      .filter((id) => !id.startsWith('EAPP_'))
      .sort();

    if (uncovered.length || undeclaredInBody.length || empty.length || missing.length) {
      failed = true;
    }

    report.push({
      layer: entry.layer,
      spec: entry.spec,
      tests: entry.tests,
      declaredCount: declared.size,
      coveredCount: declared.size - uncovered.length,
      uncovered,
      undeclaredInBody,
      unknown,
      empty,
      missingTestFiles: missing,
    });
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: !failed, report }, null, 2)}\n`);
    process.exit(failed ? 1 : 0);
  }

  const lines = [];
  for (const r of report) {
    lines.push(`\n${r.layer}`);
    lines.push(`  spec      ${r.spec}`);
    lines.push(`  suite     ${r.tests.join(', ')}`);

    lines.push(`  invariant ${r.coveredCount}/${r.declaredCount} covered`);

    if (r.missingTestFiles.length) {
      lines.push(`  MISSING   conformance suite not written yet: ${r.missingTestFiles.join(', ')}`);
      lines.push(`  gate      FAIL`);
      continue;
    }

    for (const u of r.uncovered) lines.push(`    UNCOVERED  ${u.id}  (spec line ${u.line})`);
    for (const d of r.undeclaredInBody) {
      lines.push(`    UNSTATED   ${d.id}  (listed at line ${d.line}, never stated in the body)`);
    }
    for (const e of r.empty) lines.push(`    EMPTY BODY ${e.label}  (${e.file}:${e.line})`);
    if (r.unknown.length) lines.push(`    note       named but not declared: ${r.unknown.join(', ')}`);
    lines.push(
      `  gate      ${r.uncovered.length || r.undeclaredInBody.length || r.empty.length ? 'FAIL' : 'PASS'}`,
    );
  }

  lines.push('');
  lines.push(failed ? 'FREEZE GATE: FAIL' : 'FREEZE GATE: PASS');
  lines.push('');
  process.stdout.write(lines.join('\n'));
  process.exit(failed ? 1 : 0);
}

main();
