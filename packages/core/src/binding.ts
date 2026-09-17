/**
 * Binding — v3.0.0 §6 (frozen).
 *
 * A Binding carries **no state field**: its state is derived (§6.4, B-3), and
 * `PENDING` MAY only exist as an internal transaction state (B-9). The base
 * property is OPEN/CLOSED; ACTIVE/DORMANT are derived on top of OPEN.
 */

import { capabilityRefKey } from './capability.js';
import type { CapabilityRef, ContractRef } from './capability.js';
import { identityKey } from './identity.js';
import type { LifecycleState } from './lifecycle.js';
import type { PluginRef } from './plugin.js';

export type BindingState = 'ACTIVE' | 'DORMANT' | 'CLOSED';

export interface Binding {
  id: string;
  /** The side that provides `capability`. */
  from: PluginRef;
  /** The side that consumes `capability`. */
  to: PluginRef;
  capability: CapabilityRef;
  contract?: ContractRef;
}

/** CLOSED is terminal (B-4) and is the one state a Binding can never leave. */
export const CLOSED_BINDING_STATE: BindingState = 'CLOSED';

/**
 * §6.8 / B-6 / C-6: binding identity is `(from, to, capability)` and the
 * capability version is part of it.
 */
export function bindingKey(from: PluginRef, to: PluginRef, capability: CapabilityRef): string {
  return `${identityKey(from)}->${identityKey(to)}::${capabilityRefKey(capability)}`;
}

/**
 * §6.4, encoded exactly:
 *
 * ```
 * CLOSED  iff explicitly unbound
 * ACTIVE  iff OPEN and from ACTIVE and to ACTIVE and capability still exposed
 * DORMANT iff OPEN and the ACTIVE conditions do not hold
 * ```
 *
 * B-3: this function is the *only* source of truth for the state — no caller may
 * set it.
 */
export function deriveBindingState(args: {
  closed: boolean;
  fromLifecycle: LifecycleState;
  toLifecycle: LifecycleState;
  capabilityStillExposed: boolean;
}): BindingState {
  if (args.closed) {
    return CLOSED_BINDING_STATE;
  }
  if (
    args.fromLifecycle === 'ACTIVE' &&
    args.toLifecycle === 'ACTIVE' &&
    args.capabilityStillExposed
  ) {
    return 'ACTIVE';
  }
  return 'DORMANT';
}
