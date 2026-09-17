/**
 * `@eapp/core` — EaPP v3.0.0 Composition Core (FROZEN) reference implementation.
 *
 * Five concepts: Identity / Capability / Plugin / Binding / Lifecycle.
 * Two discovery operations: find / watch.
 * Six composition & lifecycle primitives: bind / unbind / activate / deactivate /
 * suspend / resume.
 *
 * Layers above (Interaction, Transport) MUST NOT redefine these semantics; the
 * core MUST NOT define Channel interaction semantics (CH-1).
 */

export { EappError, RETRYABLE_CODES, isEappError } from './errors.js';
export type { EappCoreErrorCode, EappErrorShape } from './errors.js';

export { IdentityRegistry, assertValidIdentity, identityKey } from './identity.js';
export type { Identity } from './identity.js';

export {
  assertValidCapability,
  assertValidCapabilityRef,
  capabilityMatches,
  capabilityRefKey,
  isValidSemVer,
} from './capability.js';
export type { Capability, CapabilityRef, Constraint, ContractRef } from './capability.js';

export {
  LIFECYCLE_STATES,
  assertTransition,
  canTransition,
  isLifecycleState,
} from './lifecycle.js';
export type { LifecycleState } from './lifecycle.js';

export { PluginRegistry } from './plugin.js';
export type { Plugin, PluginChangeEvent, PluginRef } from './plugin.js';

export { CLOSED_BINDING_STATE, bindingKey, deriveBindingState } from './binding.js';
export type { Binding, BindingState } from './binding.js';

export {
  DiscoveryService,
  TRUST_LEVELS,
  isTrustLevel,
  matchesCriteria,
} from './discovery.js';
export type {
  Criteria,
  Discovery,
  DiscoveryCacheStats,
  DiscoveryEvent,
  DiscoveryScope,
  DiscoveryTrustPolicy,
  DiscoveryWatch,
  TrustLevel,
} from './discovery.js';

export { CompositionCoreImpl, createCompositionCore } from './composition.js';
export type { BindRequest, CompositionCore, CompositionCoreOptions } from './composition.js';
