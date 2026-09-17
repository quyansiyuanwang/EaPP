/**
 * @eapp/transport-socket — EaPP over a TCP socket.
 *
 * The memory transport proves the protocol works inside one process. This package
 * proves it works **between** processes, which is the only version of the claim
 * that matters: what a protocol is worth depends on whether an implementation
 * that has never seen the reference implementation can still interoperate.
 *
 * One process owns the log (the broker). Every other process gets a
 * `SocketTransport`, which is a real v3.1 / v3.2 Transport — the three layers
 * above it cannot tell the difference.
 *
 *   const broker = await SocketBroker.listen();
 *   const transport = await SocketTransport.connect({ port: broker.port });
 *
 * Nothing about the wire protocol is normative. It is one implementation's
 * choice; the normative part is that the *semantics* of `Transport` survive it.
 */

export * from './wire.js';
export * from './broker.js';
export * from './socket-transport.js';
