#!/usr/bin/env node
/**
 * Specification gate. The rules here are the ones that make the normative text
 * checkable *by itself*, now that the implementations and their gates live on the
 * `reference` branch and nothing in this repository executes the protocol.
 *
 *   1. Section numbering. One document means one namespace. A gap or a repeat means
 *      a section was deleted without renumbering, or merged twice.
 *
 *   2. Section references. `§N.M` is how the text points at itself, and nothing
 *      checked it before. Both defects this rule catches were real: an interaction
 *      section that said `（§3.5）` when no §3.5 existed, and a frozen `§1` that had
 *      been deleted while a sentence still claimed errata were merged into it.
 *
 *   3. Invariants. Every id the appendix declares must be stated somewhere outside
 *      the appendix. A summary line alone reads as a complete invariant to a reader
 *      and to any gate that only counts ids — which is how two layers each lost rules
 *      in the past.
 *
 *   4. Self-sufficiency. The normative text MUST NOT link outside `docs/spec/`.
 *      GOVERNANCE states this; nothing enforced it, and one normative sentence
 *      depended on a change log to be understandable.
 *
 *   5. No implementation references. A protocol that names a package has stopped
 *      being language-neutral, and the two places where it did are exactly the two
 *      places a reader was told to go read code.
 *
 *   6. No language-tagged code blocks. Every signature used to be written as
 *      TypeScript, in a document whose opening paragraph promised that any language
 *      could implement it. A tagged block is a language commitment; the notation is
 *      defined in §1.2 instead.
 *
 *   7. No section references inside appendix B. A section reference that resolves is
 *      not thereby correct: after the three documents were merged, four references in
 *      the appendix still carried the *old* numbering — `ConsumerGroup（§8）` pointed
 *      at Plugin, `Request 模式（§3）` at the version rules. Rule 2 cannot see that.
 *      The appendix is a declaration list; pointers to sections belong in the body,
 *      where a reader can follow them.
 *
 * Usage:  node tools/check-spec.mjs [--json]
 * Exit:   0 = gate passes, 1 = at least one violation
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'docs/spec/eapp.md';

/** `ID-1 … ID-9`, `CH-1..CH-6`, `LC-1..LC-6` — a summary line starts with the id. */
const SUMMARY_LINE = /^\s*([A-Z]{1,6}-)(\d{1,3})(?:\s*\.\.\s*(?:([A-Z]{1,6})-)?(\d{1,3}))?\b/;
/** Implementation artefacts that MUST NOT appear in normative text. */
const IMPLEMENTATION_REFERENCE = /@eapp\/|\bpackages\/|\bimplementations\/|\btests\//;
const LINK = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function expand(prefix, from, toPrefix, to) {
  const head = toPrefix ? `${toPrefix}-` : prefix;
  const lo = Number(from);
  const hi = to === undefined ? lo : Number(to);
  const out = [];
  for (let i = lo; i <= hi; i += 1) out.push(`${head}${i}`);
  return out;
}

function main() {
  const asJson = process.argv.includes('--json');
  const text = readFileSync(path.join(ROOT, SPEC), 'utf8');
  const lines = text.split(/\r?\n/);

  const sections = new Map();
  const subsections = new Set();
  let fence = false;

  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    let m = /^## (\d+)\./.exec(line);
    if (m) sections.set(Number(m[1]), index + 1);
    m = /^### (\d+)\.(\d+)/.exec(line);
    if (m) subsections.add(`${Number(m[1])}.${Number(m[2])}`);
  });

  // -- R1 -------------------------------------------------------------------
  const numbering = [];
  const ordered = [...sections.entries()].sort((a, b) => a[1] - b[1]);
  ordered.forEach(([num, line], i) => {
    if (num !== i + 1) numbering.push({ line, expected: i + 1, found: num });
  });

  // -- R2 -------------------------------------------------------------------
  const references = [];
  let refsChecked = 0;
  fence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    for (const m of line.matchAll(/§\s*(\d+)(?:\.(\d+))?/g)) {
      refsChecked += 1;
      const top = Number(m[1]);
      const sub = m[2] === undefined ? null : Number(m[2]);
      if (!sections.has(top)) references.push({ line: index + 1, ref: `§${m[1]}`, why: 'no such section' });
      else if (sub !== null && !subsections.has(`${top}.${sub}`)) references.push({ line: index + 1, ref: `§${m[1]}.${m[2]}`, why: 'no such subsection' });
    }
  });

  // -- R3 -------------------------------------------------------------------
  const appendixStart = lines.findIndex((l) => /^## 附录 B/.test(l));
  const appendixEnd = lines.findIndex((l, i) => i > appendixStart && /^## 附录 C/.test(l));
  if (appendixStart < 0 || appendixEnd < 0) {
    process.stdout.write(`${SPEC}: appendix B (invariants) not found\n`);
    process.exit(1);
  }

  const declared = [];
  for (let i = appendixStart; i < appendixEnd; i += 1) {
    const m = SUMMARY_LINE.exec(lines[i]);
    if (!m) continue;
    for (const id of expand(m[1], m[2], m[3], m[4])) declared.push({ id, line: i + 1 });
  }
  const bodies = new Map();
  for (const d of declared) bodies.set(d.id, (bodies.get(d.id) ?? 0) + 1);

  const duplicated = [...bodies.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const body = [...lines.slice(0, appendixStart), ...lines.slice(appendixEnd)].join('\n');
  const unstated = declared
    .filter((d) => !new RegExp(`\\b${d.id.replace(/-/g, '\\-')}\\b`).test(body))
    .map((d) => d);

  // -- R4 / R5 --------------------------------------------------------------
  const links = [];
  lines.forEach((line, index) => {
    for (const m of line.matchAll(LINK)) {
      const raw = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
      links.push({ line: index + 1, target: raw });
    }
  });

  const implementationRefs = [];
  lines.forEach((line, index) => {
    if (IMPLEMENTATION_REFERENCE.test(line)) {
      implementationRefs.push({ line: index + 1, text: line.trim().slice(0, 100) });
    }
  });

  // -- R6 -------------------------------------------------------------------
  const taggedBlocks = [];
  fence = false;
  lines.forEach((line, index) => {
    const m = /^\s*```(\w+)/.exec(line);
    if (/^\s*```/.test(line)) {
      if (fence) { fence = false; return; }
      fence = true;
      if (m && m[1] !== 'text') taggedBlocks.push({ line: index + 1, lang: m[1] });
      return;
    }
  });

  // -- R7 -------------------------------------------------------------------
  const appendixRefs = [];
  for (let i = appendixStart; i < appendixEnd; i += 1) {
    // The `### B.n` headings carry the part's section range; the blocks are declarative.
    if (/^###/.test(lines[i])) continue;
    if (/§\s*\d/.test(lines[i])) appendixRefs.push({ line: i + 1, text: lines[i].trim().slice(0, 100) });
  }

  // -------------------------------------------------------------------------
  const failed =
    numbering.length > 0 || references.length > 0 || duplicated.length > 0 ||
    unstated.length > 0 || links.length > 0 || implementationRefs.length > 0 ||
    taggedBlocks.length > 0 || appendixRefs.length > 0;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ok: !failed,
      sections: sections.size,
      referencesChecked: refsChecked,
      invariants: declared.length,
      numbering, references, duplicated, unstated, links, implementationRefs, taggedBlocks, appendixRefs,
    }, null, 2)}\n`);
    process.exit(failed ? 1 : 0);
  }

  const out = [];
  out.push(`spec sections: ${sections.size}, numbered 1..${sections.size}${numbering.length ? ' — GAPS' : ''}`);
  out.push(`spec references: ${refsChecked} § reference(s) checked, ${references.length} dangling, ${appendixRefs.length} inside appendix B`);
  out.push(`spec invariants: ${declared.length} declared, ${duplicated.length} declared twice, ${unstated.length} never stated`);
  out.push(`spec self-sufficiency: ${links.length} link(s) out of docs/spec/`);
  out.push(`spec language neutrality: ${implementationRefs.length} implementation reference(s), ${taggedBlocks.length} language-tagged block(s)`);
  out.push('');

  const detail = [];
  for (const n of numbering) detail.push(`  numbering  line ${n.line}: expected §${n.expected}, found §${n.found}`);
  for (const r of references) detail.push(`  reference  line ${r.line}: ${r.ref} — ${r.why}`);
  for (const id of duplicated) detail.push(`  duplicate  ${id}`);
  for (const u of unstated) detail.push(`  UNSTATED   ${u.id}  (listed at line ${u.line}, never stated in the body)`);
  for (const l of links) detail.push(`  link       line ${l.line}: ${l.target}`);
  for (const i of implementationRefs) detail.push(`  names an implementation  line ${i.line}: ${i.text}`);
  for (const t of taggedBlocks) detail.push(`  language-tagged block  line ${t.line}: \`\`\`${t.lang}`);
  for (const a of appendixRefs) detail.push(`  appendix B points at a section  line ${a.line}: ${a.text}`);

  if (detail.length) out.push(...detail, '');
  out.push(failed ? 'SPEC GATE: FAIL' : 'SPEC GATE: PASS');
  out.push('');
  process.stdout.write(out.join('\n'));
  process.exit(failed ? 1 : 0);
}

main();
