/**
 * @eapp/transport-memory — in-process reference transport.
 *
 * Implements both the v3.1 Transport surface and the v3.2 StateTransport surface.
 * `durabilityBoundary` is `'process'`: nothing here survives the process, so this
 * transport must never be presented as strongly consistent across processes (TS-5).
 */

export * from './memory-transport.js';
