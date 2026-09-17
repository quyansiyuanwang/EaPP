/**
 * @eapp/state — EaPP v3.2.0 State Mode.
 *
 * The fourth interaction mode: how composed parties share state.
 *
 *   StateCell    defines what is shared
 *   Revision     is the position of a write in the channel log
 *   StateUpdate   defines a change
 *   StateWatcher defines observation
 *   CAS          defines conflict resolution
 */

export * from './errors.js';
export * from './types.js';
export * from './validate.js';
export * from './state-transport.js';
export * from './state-watcher.js';
export * from './state-channel.js';
