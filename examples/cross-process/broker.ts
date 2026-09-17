/**
 * The broker process — the only process that owns the log.
 *
 *   npx tsx examples/cross-process/broker.ts
 *
 * Started by `examples/cross-process/index.ts`, not usually by hand. It prints one
 * line of JSON on stdout when it is listening, and then stays alive until it is
 * signalled.
 */

import { SocketBroker } from '../../packages/transport/socket/src/index.js';

const broker = await SocketBroker.listen({ id: 'xproc' });

// The parent reads exactly this line to learn where to connect. Printing the port
// rather than agreeing on one up front means several of these can run at once.
process.stdout.write(`${JSON.stringify({ type: 'ready', port: broker.port, id: broker.id })}\n`);

const stop = (): void => {
  void broker.close().then(() => process.exit(0));
  // A broker that ignored the signal would leave the parent waiting on its exit.
  setTimeout(() => process.exit(0), 500).unref();
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Keep the event loop alive without a timer: the socket server alone is not
// guaranteed to hold the process open in every Node version.
process.stdin.resume();
