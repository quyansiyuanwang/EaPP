#!/usr/bin/env node
/**
 * Language-neutral conformance harness for EaPP.
 *
 *   node conformance/harness/run.mjs                       # every driver shipped here
 *   node conformance/harness/run.mjs --driver "go run ./cmd/eapp-driver" --cwd implementations/go
 *   node conformance/harness/run.mjs --only B-3            # one invariant
 *   node conformance/harness/run.mjs --list                # what is covered
 *
 * This file imports **nothing** from any EaPP implementation. It spawns a driver,
 * speaks the protocol in `conformance/driver.md`, and judges only what comes back.
 * That is the point: an implementation cannot pass by being the reference one.
 *
 * Exit: 0 = every check passed for every driver, 1 = at least one did not.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Driver } from './driver.mjs';
import { CORE_CHECKS } from './checks/core.mjs';
import { INTERACTION_CHECKS } from './checks/interaction.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/**
 * Checks grouped by the layer they exercise.
 *
 * A driver declares the layers it covers in its hello line, and only those layers'
 * checks run against it — a Go implementation of Composition Core alone is not
 * failing the Interaction layer, it is not claiming it. The alternative, running
 * everything and reporting failures for unclaimed layers, would make the harness
 * report a conformant implementation as broken.
 */
const CHECKS_BY_LAYER = {
  core: CORE_CHECKS,
  interaction: INTERACTION_CHECKS,
};

/** The order layers are reported in: dependency order, so a gap reads top-down. */
const LAYER_ORDER = ['core', 'interaction'];

// Resolving the TypeScript runner is tooling, not implementation: the harness still
// imports nothing from `@eapp/*`.
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

/** The drivers this repository ships, so the harness is useful with no arguments. */
const BUILT_IN = [
  {
    name: 'eapp-go (independent implementation)',
    command: 'go',
    args: ['run', './cmd/eapp-driver'],
    cwd: path.join(ROOT, 'implementations', 'go'),
  },
  {
    name: 'eapp-ts (reference implementation)',
    command: process.execPath,
    args: [tsx, path.join(ROOT, 'conformance', 'drivers', 'reference.ts')],
    cwd: ROOT,
  },
];

function parseArgs(argv) {
  const out = { verbose: false, list: false, json: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--only') out.only.push(argv[++i]);
    else if (arg === '--driver') out.driver = argv[++i];
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--debug') out.debug = true;
  }
  return out;
}

/**
 * What each check gets to work with.
 *
 * `driver` is the only capability, deliberately: a check that could reach into an
 * implementation would stop being a conformance check.
 */
function makeTester(driver) {
  return {
    driver,
    assert(condition, message) {
      if (!condition) throw new Error(message);
    },
    equal(actual, expected, message) {
      if (actual !== expected) {
        throw new Error(`${message} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      }
    },
    deepEqual(actual, expected, message) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`${message} — got ${a}, expected ${b}`);
    },
  };
}

function selectChecks(only, layers) {
  const pool = LAYER_ORDER.filter((layer) => layers.includes(layer)).flatMap(
    (layer) => CHECKS_BY_LAYER[layer] ?? [],
  );
  if (only.length === 0) return pool;
  return pool.filter((check) =>
    only.some((wanted) => check.id === wanted || check.id.split(' / ').includes(wanted)),
  );
}

async function runDriver(spec, options) {
  const results = [];

  let driver;
  try {
    driver = await Driver.start({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      debug: options.debug,
    });
  } catch (error) {
    return { spec, results, startupError: error };
  }

  const declared = driver.hello.layers ?? [];
  const layers = declared.filter((layer) => layer in CHECKS_BY_LAYER);
  // Layers the driver claims that this harness has no checks for. Reported rather than
  // ignored: silence here would read as "covered and passing" for a layer nobody checked.
  const uncovered = declared.filter((layer) => !(layer in CHECKS_BY_LAYER));

  if (layers.length === 0) {
    await driver.close();
    return {
      spec,
      results: [],
      layers: declared,
      startupError: new Error(
        `driver claims layers [${declared.join(', ')}], none of which this harness has checks for`,
      ),
    };
  }

  // A layer's checks may build on the layer below, so run them in dependency order.
  const checks = selectChecks(options.only, layers).sort(
    (a, b) => LAYER_ORDER.findIndex((l) => CHECKS_BY_LAYER[l].includes(a))
      - LAYER_ORDER.findIndex((l) => CHECKS_BY_LAYER[l].includes(b)),
  );

  for (const check of checks) {
    const tester = makeTester(driver);
    const started = Date.now();
    try {
      // Each check starts from a clean runtime. Sharing state between checks would
      // make a failure depend on the order they happened to run in.
      await driver.request('reset', {}, 10_000);
      await check.run(tester);
      results.push({ check, ok: true, ms: Date.now() - started });
    } catch (error) {
      results.push({ check, ok: false, ms: Date.now() - started, error });
    }
  }

  await driver.close();
  return { spec, results, layers, uncovered, stderrTail: driver.stderrTail };
}

function report(run, options) {
  const lines = [];
  const failed = run.results.filter((r) => !r.ok);

  lines.push(`\n${run.spec.name}`);
  lines.push(`  driver  ${run.spec.command} ${(run.spec.args ?? []).join(' ')}`);

  if (run.startupError) {
    lines.push(`  \x1b[31mFAILED TO START\x1b[0m ${run.startupError.message}`);
    if (run.stderrTail) lines.push(`  stderr:\n${indent(run.stderrTail.trim())}`);
    return { text: lines.join('\n'), failed: 1, total: 0 };
  }

  lines.push(`  layers  ${(run.layers ?? run.spec.layers ?? []).join(', ')}`);
  if ((run.uncovered ?? []).length > 0) {
    lines.push(
      `  \x1b[33mnote\x1b[0m    claimed but not checked by this harness: ${run.uncovered.join(', ')}`,
    );
  }

  for (const result of run.results) {
    if (result.ok && !options.verbose) continue;
    const mark = result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    lines.push(`  ${mark} ${result.check.id.padEnd(14)} ${result.check.rule}`);
    if (!result.ok) {
      lines.push(`      ${indent(String(result.error?.message ?? result.error))}`);
    }
  }

  const summary = failed.length === 0
    ? `\x1b[32m${run.results.length}/${run.results.length} checks passed\x1b[0m`
    : `\x1b[31m${failed.length}/${run.results.length} checks failed\x1b[0m`;
  if (!options.verbose || failed.length > 0) lines.push(`  ${summary}`);

  return { text: lines.join('\n'), failed: failed.length, total: run.results.length };
}

const indent = (text) => text.split('\n').map((line) => `      ${line}`).join('\n');

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    for (const layer of LAYER_ORDER) {
      const checks = CHECKS_BY_LAYER[layer] ?? [];
      process.stdout.write(`\n${layer}\n`);
      for (const check of checks) {
        process.stdout.write(`  ${check.id.padEnd(14)} ${check.rule}\n`);
      }
      process.stdout.write(`  ${checks.length} check(s)\n`);
    }
    const total = LAYER_ORDER.reduce((sum, layer) => sum + (CHECKS_BY_LAYER[layer]?.length ?? 0), 0);
    process.stdout.write(`\n${total} checks across ${LAYER_ORDER.length} layer(s)\n`);
    return 0;
  }

  const specs = options.driver
    ? [{ name: options.driver, command: options.driver.split(' ')[0], args: options.driver.split(' ').slice(1), cwd: options.cwd ?? ROOT }]
    : BUILT_IN;

  const runs = [];
  for (const spec of specs) {
    process.stdout.write(`\n\x1b[1mconformance\x1b[0m  ${spec.name}\n`);
    const run = await runDriver(spec, options);
    runs.push(run);
  }

  let totalFailed = 0;
  let totalChecks = 0;
  const output = [];
  for (const run of runs) {
    const { text, failed, total } = report(run, options);
    output.push(text);
    totalFailed += failed;
    totalChecks += total;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(runs.map((run) => ({
      driver: run.spec.name,
      checks: run.results.map((r) => ({
        id: r.check.id,
        rule: r.check.rule,
        ok: r.ok,
        error: r.ok ? undefined : String(r.error?.message ?? r.error),
      })),
    })), null, 2)}\n`);
  } else {
    process.stdout.write(`${output.join('\n')}\n`);
  }

  process.stdout.write(
    totalFailed === 0
      ? `\n\x1b[32m${totalChecks} checks passed across ${runs.length} driver(s)\x1b[0m\n`
      : `\n\x1b[31m${totalFailed} of ${totalChecks} checks failed\x1b[0m\n`,
  );

  return totalFailed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`harness error: ${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  },
);
