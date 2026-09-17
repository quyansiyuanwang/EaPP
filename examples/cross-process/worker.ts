/**
 * A worker process.
 *
 *   npx tsx examples/cross-process/worker.ts --port 12345 --name alpha \
 *       --orders "<channelId>" --counter "<channelId>"
 *
 * It is a normal EaPP runtime: it registers plugins, joins a ConsumerGroup, and
 * shares state with CAS. The only unusual thing is that the transport underneath
 * belongs to a different process — and that the group it joins has members in other
 * processes too.
 *
 * It stops when the parent writes anything to its stdin.
 */

import { EappError } from '../../packages/core/src/index.js';
import { EappRuntime } from '../../packages/runtime/src/index.js';
import type { StateChannel } from '../../packages/state/src/index.js';
import { SocketTransport } from '../../packages/transport/socket/src/index.js';

import {
  COUNTER,
  COUNTER_BINDING,
  FULFILMENT,
  LEDGER,
  ORDERS,
  SHOP,
  channelId,
  emit,
  parseArgs,
  type Order,
} from './shared.js';

const args = parseArgs(process.argv.slice(2));
const name = args.name ?? 'worker';
const port = Number(args.port);
const ordersChannel = args.orders ?? '';
const counterChannel = args.counter ?? '';

const transport = await SocketTransport.connect({ port });
const runtime = EappRuntime.create({ domain: 'eapp.xproc', transport, channelId });

/**
 * A CAS retry loop, which is the whole point of the state half of this example.
 *
 * Several processes are incrementing the same counter at the same time. None of
 * them can see another's memory; the only thing they share is the broker's log.
 * CAS is what makes that safe: a writer whose token has gone stale is told so, and
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
// binding gets the same Channel.
const ledger = runtime.register({
  manifest: { identity: LEDGER, capabilities: [COUNTER] },
  handlers: {},
});
const fulfilment = runtime.register({
  manifest: { identity: FULFILMENT, capabilities: [] },
});
const counter = await runtime.stateChannel({
  from: ledger,
  to: fulfilment,
  capability: COUNTER_BINDING.capability,
});

/**
 * Materialise the orders Channel locally.
 *
 * A Channel cannot be addressed without a Binding: CG-7 makes a ConsumerGroup
 * depend on a live Channel, and a Channel is *derived from* a Binding, so every
 * participant has to know the binding's shape — the two identities and the
 * capability — and build the same one. That is why those identities are part of
 * the shared contract in `shared.ts` and not an implementation detail.
 *
 * This worker does not publish anything; it registers the provider end because the
 * Binding has two ends and both must exist locally for the Channel to be created.
 */
const shop = runtime.register({
  manifest: { identity: SHOP, capabilities: [ORDERS] },
  handlers: {},
});
await runtime.activate(shop);
await runtime.activate(fulfilment);
const { channel } = await runtime.connect({
  from: shop,
  to: fulfilment,
  capability: ORDERS,
  mode: 'stream',
});
if (channel.id !== ordersChannel) {
  throw new Error(`${name}: derived channel '${channel.id}' does not match '${ordersChannel}'`);
}

/**
 * Join the group rather than subscribing.
 *
 * An exclusive subscription would deliver every order to every process — fan-out.
 * A group delivers each one to exactly one member, which is what makes a pool of
 * workers out of a pool of processes.
 *
 * `prefetch: 1` matters here in a way it does not inside one process. The default
 * is 16, and the first member awake claims everything currently visible: the second
 * worker would then sit idle until the first had worked through its batch. CG-3
 * promises exclusivity, not fairness, so the batch size is the only lever — and
 * across processes it is the difference between a pool and one overworked member.
 */
await runtime.openConsumerGroup(ordersChannel, { name: 'workers', prefetch: 1 });
const member = await runtime.joinConsumerGroup(ordersChannel, 'workers');

// The parent tells us when it has finished publishing. Closing the member is what
// unblocks the loop below: an idle member is parked waiting for a wakeup, and a
// flag alone would never be noticed.
let stopping = false;
process.stdin.on('data', () => {
  stopping = true;
  void member.close();
});

const seen: number[] = [];
let retries = 0;

emit({ type: 'ready', name, pid: process.pid, counterChannel });

for await (const message of member) {
  if (stopping) break;
  const order = message.payload as Order;
  // Claimed exclusively: no other member of this group can be holding this order,
  // in this process or any other.
  retries += await increment(counter, 1);
  seen.push(order.id);
  // CR-1: only the ack moves the group's cursor, and that cursor is a shared
  // position on the broker.
  await message.ack();
  emit({ type: 'order', name, pid: process.pid, id: order.id, cursor: message.cursor });
}

// Read the final value BEFORE shutting down: `shutdown()` closes the transport, and
// the counter lives on the other side of it.
const final = (await counter.get('processed'))?.value;
await runtime.shutdown();
emit({
  type: 'done',
  name,
  pid: process.pid,
  seen,
  retries,
  counter: final,
});
