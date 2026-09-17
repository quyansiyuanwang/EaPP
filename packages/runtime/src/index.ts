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
