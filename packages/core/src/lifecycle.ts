/**
 * Lifecycle — v3.0.0 §7 (frozen).
 *
 * State transition table (§7.2 / §7.3):
 *
 * ```
 * INACTIVE  --activate-->   ACTIVE      (activate  | INACTIVE only)
 * ACTIVE    --suspend-->    SUSPENDED   (suspend   | ACTIVE only)
 * SUSPENDED --resume-->     ACTIVE      (resume    | SUSPENDED only)
 * ACTIVE    --deactivate--> INACTIVE    (deactivate| any state)
 * SUSPENDED --deactivate--> INACTIVE
 * INACTIVE  --deactivate--> INACTIVE
 * ```
 */

import { EappError } from './errors.js';

export type LifecycleState = 'INACTIVE' | 'ACTIVE' | 'SUSPENDED';

/** The three frozen states, in §7.1 order. */
export const LIFECYCLE_STATES: readonly LifecycleState[] = Object.freeze([
  'INACTIVE',
  'ACTIVE',
  'SUSPENDED',
] as const);

export function isLifecycleState(value: unknown): value is LifecycleState {
  return value === 'INACTIVE' || value === 'ACTIVE' || value === 'SUSPENDED';
}

/**
 * Encodes the §7.2/§7.3 transition table exactly.
 *
 * Note that ACTIVE -> ACTIVE and SUSPENDED -> SUSPENDED are *not* transitions:
 * `activate` only applies to INACTIVE and `resume` only to SUSPENDED (L-6).
 * Idempotency (O-5) is an operation-level property and is handled by the
 * composition operations themselves, not by widening this table.
 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (to === 'INACTIVE') {
    return true; // deactivate: ACTIVE / SUSPENDED / INACTIVE -> INACTIVE (L-2)
  }
  if (to === 'ACTIVE') {
    // L-1 (activate) and L-4 (resume) share the target state but not the source.
    return from === 'INACTIVE' || from === 'SUSPENDED';
  }
  return from === 'ACTIVE'; // suspend: ACTIVE -> SUSPENDED (L-3)
}

/** Throws `EAPP_LIFECYCLE_INVALID` unless the transition is one of §7.2. */
export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) {
    throw new EappError('EAPP_LIFECYCLE_INVALID', `Lifecycle transition ${from} -> ${to} is not allowed`, {
      details: { from, to },
    });
  }
}
