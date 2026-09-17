/**
 * What every process in this example has to agree on.
 *
 * The point of this file is that it is the *only* shared thing. The three
 * processes import the same identities and the same capability names — and nothing
 * else. No shared memory, no shared module state: they meet on the socket.
 */

import type { Binding } from '../../packages/core/src/index.js';
import type { ChannelMode, EappRuntime } from '../../packages/runtime/src/index.js';

export const ORDERS = { name: 'orders.feed', version: '1.0.0' };
export const COUNTER = { name: 'orders.counter', version: '1.0.0' };
export const PRICING = { name: 'pricing.quote', version: '1.0.0' };

/** Identities, written out identically in every process. */
export const SHOP = { domain: 'acme.shop', id: 'shop', instance: 'shop-1' };
export const FULFILMENT = { domain: 'acme.shop', id: 'fulfilment', instance: 'fulfilment-1' };
export const LEDGER = { domain: 'acme.shop', id: 'ledger', instance: 'ledger-1' };
/** Provides `pricing.quote`, and is executed in its own process. */
export const PRICING_PROVIDER = { domain: 'acme.shop', id: 'pricing', instance: 'pricing-1' };
export const CHECKOUT = { domain: 'acme.shop', id: 'checkout', instance: 'checkout-1' };

/**
 * The binding both sides use for the shared counter.
 *
 * It has to be byte-identical in every process, because the Channel id is derived
 * from it. Reusing an already-registered identity here would fail with
 * EAPP_IDENTITY_DUPLICATE, which is ID-3 working as intended — so the counter gets
 * its own pair rather than sharing the orders one.
 */
export const COUNTER_BINDING = { from: LEDGER, to: FULFILMENT, capability: COUNTER };

/**
 * The binding for the request-mode call, shared for the same reason.
 *
 * `from` is the provider because that is what a Binding means (v3.0 §4.4). Note
 * that `invoke()` takes the opposite order — its `from` is the caller — which is
 * the one place these names mean different things on the two sides.
 */
export const PRICING_BINDING = { from: PRICING_PROVIDER, to: CHECKOUT, capability: PRICING };

/**
 * How a Channel is named.
 *
 * A Channel's id is the key its messages are stored under, so every process that
 * shares the log MUST arrive at the same string. A per-runtime counter cannot do
 * that: each process would name its first channel `ch-1` and they would each be
 * reading their own log while agreeably using the same name for it.
 *
 * The Binding is the only genuinely shared thing — `from`, `to` and the capability
 * are all plain data that every participant knows — so the id is derived from it.
 * That is also what the spec means by saying a Channel is *derived from* a Binding.
 */
export function channelId(context: {
  bindingId: string;
  mode: ChannelMode;
  binding: Binding | undefined;
}): string {
  const { binding, mode } = context;
  if (!binding) return `adhoc#${mode}`;
  const from = `${binding.from.domain}/${binding.from.id}/${binding.from.instance}`;
  const to = `${binding.to.domain}/${binding.to.id}/${binding.to.instance}`;
  return `${from}->${to}:${binding.capability.name}@${binding.capability.version}#${mode}`;
}

export type Runtime = EappRuntime;

/** One JSON object per line on stdout; the parent reads them. */
export function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--') && value !== undefined) out[key.slice(2)] = value;
  }
  return out;
}

export interface Order {
  id: number;
  total: number;
}
