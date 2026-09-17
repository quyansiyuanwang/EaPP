#!/usr/bin/env node
/**
 * Duplicate-declaration audit.
 *
 * The specification defines a type; a reference page restates it so a reader need not
 * open two documents. That restatement is a copy, and copies drift — this exercise
 * found `Criteria.version` described as exact-match long after range matching shipped,
 * and CC-1 / CC-2 sent to a deleted draft. Links, register and page structure cannot
 * see "this text used to match the file it was copied from".
 *
 * ## What is compared
 *
 * **Member by member, over the intersection.** Two copies of `interface X` that share
 * a member must agree on that member's type. A member present in one and absent from
 * the other is not reported: a reference page showing the two fields relevant to its
 * subject is doing its job, and a fragment is not drift.
 *
 * `docs/analysis/` is skipped. It quotes superseded proposals verbatim on purpose —
 * an alternative that differs from the current text is that document working.
 *
 * Read-only. Usage: node tools/check-duplicates.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'dist', 'coverage']);
/** Historical by design: quotes of superseded proposals. */
const SKIP_FILES = [/^docs\/analysis\//];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    const fence = line.match(/^\s*(```|~~~)(\w*)/);
    if (!fence) { if (open) open.lines.push(line); return; }
    if (open === null) open = { start: i + 1, lines: [] };
    else { blocks.push(open); open = null; }
  });
  return blocks;
}

/** Named declarations at brace depth 0 within a block. */
function declarations(block) {
  const source = block.lines.join('\n');
  const found = [];
  const pattern = /^[ \t]*(?:export\s+)?(interface|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    const brace = source.indexOf('{', m.index + m[0].length);
    if (brace === -1) continue;
    let depth = 0;
    let i = brace;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    found.push({
      kind: m[1],
      name: m[2],
      body: source.slice(brace, i + 1),
      line: block.start + m[0].length,
    });
    pattern.lastIndex = i + 1;
  }
  return found;
}

/**
 * Members of a declaration body, as `name -> normalised type`.
 *
 * Only top-level members: a property inside a nested object literal belongs to the
 * field that contains it, and comparing those across copies produces noise rather
 * than signal.
 */
function members(body) {
  const inner = body.slice(1, -1);
  const out = new Map();
  let depth = 0;
  let current = '';

  const flush = () => {
    const text = current.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    current = '';
    if (text.length === 0) return;
    const m = text.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:\s*([\s\S]+?)\s*;?$/);
    if (!m) return;
    const type = `${m[3]
      .replace(/\s+/g, ' ')
      .replace(/\s*([<>|&\[\]{}()])\s*/g, '$1')
      .replace(/;\s*\}/g, '}')          // trailing separator inside an object type
      .trim()}${m[2] === '?' ? ' (optional)' : ''}`;
    out.set(m[1], type);
  };

  for (const ch of inner) {
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth -= 1;
    if (ch === ';' && depth === 0) { flush(); continue; }
    current += ch;
  }
  flush();
  return out;
}

const byName = new Map();
const files = walk(ROOT)
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  .filter((rel) => !SKIP_FILES.some((re) => re.test(rel)))
  .sort();

for (const rel of files) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  for (const block of fencedBlocks(text)) {
    for (const declaration of declarations(block)) {
      // A class and an interface may share a name and describe different things —
      // `class EappError` always has a `retryable`, the §16 interface declares it
      // optional. Comparing across kinds would report that as drift every time.
      const key = `${declaration.kind} ${declaration.name}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({
        file: rel,
        line: declaration.line,
        members: members(declaration.body),
      });
    }
  }
}

/**
 * Members that legitimately differ, with the reason.
 *
 * A named type alias and its expansion are the same type; a tool cannot know that
 * without a type environment, and pretending otherwise would force every page to
 * spell out what the specification chose to name.
 */
const ALLOWED = new Map([
  ['interface DiscoveryScope.trustLevel', 'spec 用字面量联合，参考页用其别名 TrustLevel'],
]);

const problems = [];
let shared = 0;

/** `interface Foo` → `Foo`, for a stable key in ALLOWED. */
const label = (key) => {
  const [kind, name] = key.split(' ');
  return `${kind} ${name}`;
};

for (const [key, copies] of byName) {
  if (new Set(copies.map((c) => c.file)).size < 2) continue;
  shared += 1;

  const names = new Set();
  for (const copy of copies) for (const member of copy.members.keys()) names.add(member);

  for (const member of names) {
    const present = copies.filter((c) => c.members.has(member));
    if (present.length < 2) continue;
    const types = new Set(present.map((c) => c.members.get(member)));
    if (types.size > 1 && !ALLOWED.has(`${label(key)}.${member}`)) {
      problems.push({
        name: key,
        member,
        variants: [...types].map((type) => ({
          type,
          files: present.filter((c) => c.members.get(member) === type).map((c) => `${c.file}:${c.line}`),
        })),
      });
    }
  }
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ files: files.length, shared, problems }, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

process.stdout.write(`${files.length} document(s) compared\n`);
process.stdout.write(`${shared} declaration(s) restated in more than one document\n\n`);

if (problems.length === 0) {
  process.stdout.write('no member is described differently in two places\n');
  process.exit(0);
}

for (const problem of problems) {
  process.stdout.write(`${problem.name}.${problem.member}\n`);
  for (const variant of problem.variants) {
    process.stdout.write(`  ${variant.type}\n`);
    process.stdout.write(`      ${variant.files.join(', ')}\n`);
  }
}
process.stdout.write(`\n${problems.length} member(s) described differently in two places\n`);
process.exit(1);
