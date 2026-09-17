/**
 * A provider process.
 *
 *   npx tsx examples/cross-process/provider.ts --port 12345
 *
 * It hosts a plugin and **serves** it: `runtime.serve()` starts the side of request
 * mode that answers. Nothing about this differs from a single-process provider
 * except that the caller is somewhere else.
 *
 * v3.0 §5.2 refuses to require that every Plugin has the same implementation shape —
 * "它可以是进程内模块、独立进程、worker、远程服务、一台设备". This file is the
 * second item on that list taken literally.
 */

import { EappRuntime } from '../../packages/runtime/src/index.js';
import { SocketTransport } from '../../packages/transport/socket/src/index.js';

import { CHECKOUT, PRICING, PRICING_BINDING, PRICING_PROVIDER, channelId, emit, parseArgs } from './shared.js';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port);

const transport = await SocketTransport.connect({ port });
const runtime = EappRuntime.create({ domain: 'eapp.xproc', transport, channelId });

const pricing = runtime.register({
  manifest: { identity: PRICING_PROVIDER, capabilities: [PRICING] },
  handlers: {
    'pricing.quote': async (payload) => {
      const { quantity = 1, unit = 10 } = (payload ?? {}) as { quantity?: number; unit?: number };
      // Reporting the pid is how the example proves the handler ran *here* rather
      // than being answered by the caller's own dispatcher.
      emit({ type: 'call', pid: process.pid, quantity });
      return { total: quantity * unit, servedBy: process.pid };
    },
  },
});

// The other end of the Binding. A Channel is derived from a Binding and both ends
// must exist locally for it to be created (CG-7), so a provider materialises it the
// same way any participant does.
const checkout = runtime.register({ manifest: { identity: CHECKOUT, capabilities: [] } });
await runtime.activate(pricing);
await runtime.activate(checkout);

/**
 * `serve()` takes the Channel's server role.
 *
 * In one process the caller's own dispatcher answers, which is why `invoke()` alone
 * appears to work. Across processes that dispatcher belongs to a runtime that does
 * not host the plugin — left to itself it would reply `EAPP_CAPABILITY_NOT_EXPOSED`,
 * racing the real answer. A caller therefore registers the provider as *remote*, and
 * the provider's process says "I serve this Channel".
 *
 * Only one process can hold the role. If another already does, `serve()` fails
 * loudly rather than letting two processes run the handler and have the duplicate
 * reply discarded as if nothing happened.
 */
const channel = await runtime.serve(PRICING_BINDING);

emit({ type: 'ready', pid: process.pid, name: 'pricing', channel: channel.id });

// Stay up until the parent says otherwise. The dispatcher keeps the loop alive;
// this only provides a clean way out.
process.stdin.on('data', () => {
  void runtime.shutdown().then(() => {
    emit({ type: 'done', pid: process.pid, name: 'pricing' });
  });
});
