/**
 * @eapp/runtime — the EaPP plugin composition runtime.
 *
 *   discover      find plugins that declare a capability
 *   connect       bind two plugins and derive a Channel between them
 *   activate      move a plugin into Active Composition
 *   communicate   exchange messages, or share state, over that Channel
 *   invoke        request/response with correlation and deadlines
 *
 * The runtime adds no semantics of its own — every operation is a composition of the
 * frozen v3.0 / v3.1 / v3.2 layers.
 */

export * from './plugin.js';
export * from './bootstrap.js';
export * from './runtime.js';

/**
 * Re-exported so a plugin author needs exactly one import.
 *
 * Without this, every plugin that wants to throw a protocol error — or to catch one and
 * inspect its `code` — has to reach past the runtime into `@eapp/core`. That is a
 * needless leak of the layer structure into plugin code.
 */
export { EappError, identityKey, isEappError } from '@eapp/core';
export type { Capability, EappErrorShape, Identity, PluginRef } from '@eapp/core';
export type { ChannelMode, Subscription } from '@eapp/interaction';
export type { StateChannel, StateCell, Revision } from '@eapp/state';
