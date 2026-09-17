/**
 * A consumer process.
 *
 *   npx tsx examples/cross-process/worker.ts --port 12345 --name alpha \
 *       --orders "<channelId>" --counter "<channelId>"
 *
 * It is a normal EaPP runtime: it registers plugins, subscribes to a Channel, and
 * shares state with CAS. The only unusual thing about it is that the transport
 * underneath belongs to a different process.
 */

import { EappError } from '../../packages/core/src/index.js';
import { EappRuntime } from '../../packages/runtime/src/index.js';
import type { StateChannel } from '../../packages/state/src/index.js';
import { SocketTransport } from '../../packages/transport/socket/src/index.js';

import { COUNTER, COUNTER_BINDING, FULFILMENT, LEDGER, channelId, emit, parseArgs, type Order } from './shared.js';

const args = parseArgs(process.argv.slice(2));
const name = args.name ?? 'worker';
const port = Number(args.port);
const ordersChannel = args.orders ?? '';
const counterChannel = args.counter ?? '';
const rounds = Number(args.rounds ?? '1');

const transport = await SocketTransport.connect({ port });
const runtime = EappRuntime.create({ domain: 'eapp.xproc', transport, channelId });

/**
 * A CAS retry loop, which is the whole point of the state half of this example.
 *
 * Two processes are incrementing the same counter at the same time. Neither can
 * see the other's memory; the only thing they share is the broker's log. CAS is
 * what makes that safe: a writer whose token has gone stale is told so, and
 * re-reads. Losing the update would look exactly like success, which is why the
 * retry cannot be skipped.
 */
async function increment(state: StateChannel, by: number): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const cell = await state.get('processed');
    const current = typeof cell?.value === 'number' ? cell.value : 0;
    try {
      await state.set({
        key: 'processed',
        value: current + by,
        expectedRevision: cell?.revision ?? null,
      });
      return attempt + 1;
    } catch (error) {
      // EAPP_REVISION_CONFLICT is the one code the stack marks retryable by default.
      if (error instanceof EappError && error.code === 'EAPP_REVISION_CONFLICT') continue;
      throw error;
    }
  }
  throw new Error(`${name}: gave up after 500 CAS conflicts`);
}

// The counter channel is derived, not created: every process that names the same
// binding gets the same Channel. This is what makes two processes share one key.
const counter = await runtime.stateChannel({
  from: runtime.register({
    manifest: { identity: LEDGER, capabilities: [COUNTER] },
    handlers: {},
  }),
  to: runtime.register({
    manifest: { identity: FULFILMENT, capabilities: [] },
  }),
  capability: COUNTER_BINDING.capability,
});

const seen: number[] = [];
let retries = 0;

emit({ type: 'ready', name, pid: process.pid, counterChannel });

const subscription = await runtime.subscribe(ordersChannel, { all: true });
// The cursor is a position in the shared log. This process starts at 'latest',
// so it sees only what is published after it attaches.
for await (const message of subscription) {
  const order = message.payload as Order;
  retries += await increment(counter, 1);
  seen.push(order.id);
  // CR-1: only the ack moves the cursor, and the cursor is a shared position
  // rather than per-process state.
  await message.ack();
  emit({ type: 'order', name, pid: process.pid, id: order.id, cursor: message.cursor });
  if (seen.length >= rounds) break;
}

await subscription.close();
emit({ type: 'done', name, pid: process.pid, seen, retries, counter: (await counter.get('processed'))?.value });

await runtime.shutdown();
