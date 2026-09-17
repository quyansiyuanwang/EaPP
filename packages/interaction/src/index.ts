/**
 * @eapp/interaction — EaPP v3.1.0 Interaction Layer.
 *
 * Owns how composed parties interact: Channel / Subscription / Cursor / AckContext /
 * Lease, and the Transport boundary. State Mode (v3.2) builds on this package and
 * MUST NOT redefine any of these primitives.
 */

export * from './errors.js';
export * from './cursor.js';
export * from './ack.js';
export * from './lease.js';
export * from './channel.js';
export * from './messages.js';
export * from './transport.js';
export * from './subscription.js';
export * from './group-store.js';
export * from './consumer-group.js';
export * from './interaction-layer.js';
