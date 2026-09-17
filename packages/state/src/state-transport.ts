import { EappError, type Identity } from '@eapp/core';
import type { Cursor, Transport, TransportCapabilities } from '@eapp/interaction';
import type {
  ExpectedRevision,
  Revision,
  StateCell,
  StateChange,
  StatePattern,
  StateUpdate,
} from './types.js';

/**
 * StateTransport — EaPP v3.2.0 §11.
 *
 * Extends the v3.1 Transport rather than replacing it (IX-4 / TS-7): a state transport
 * is still a transport, it just also knows how to store cells and to order revisions.
 *
 * Two shape decisions worth stating explicitly, because the r2 draft got both wrong:
 *
 *  - `readChangesAfter` returns a **change stream**, not `StateCell[]`. A post-image
 *    array cannot express two writes to the same key, so the intermediate change is lost
 *    forever and an observation cursor has no meaning.
 *  - Addressing is by the `(channel, key)` PAIR (TS-13). r2 built map keys with
 *    `` `${channel}:${key}` ``, which makes `("a", "b:c")` and `("a:b", "c")` the same
 *    cell and lets one channel corrupt another.
 */

export interface StateTransportCapabilities extends TransportCapabilities {
  supportsState: boolean;
  supportsStateRevision: boolean;
  supportsStateWatch: boolean;
  supportsStateSnapshot: boolean;
  stateConsistency: 'strong' | 'eventual';
  stateRetention: { kind: 'unbounded' } | { kind: 'window'; entries: number };
}

export interface StateTransport extends Transport {
  readonly capabilities: StateTransportCapabilities;

  getState(channel: string, key: string): Promise<StateCell | null>;
  listState(channel: string, pattern: StatePattern): Promise<StateCell[]>;

  /** Current end of the channel's state log. For an empty channel this is a comparable initial value (TS-14). */
  head(channel: string): Promise<Revision>;

  setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision>;

  /** A first-class primitive — NOT sugar over `set({deleted:true})` (v3.2 §6.1). */
  deleteStateWithCAS(
    channel: string,
    key: string,
    expectedRevision: ExpectedRevision,
    actor: Identity,
  ): Promise<Revision>;

  /** Changes strictly after `cursor`, ascending (TS-9 / TS-10). Never blocks (TS-12). */
  readChangesAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateChange[]>;

  /** Reserve a position strictly greater than the current head (TS-15). */
  nextRevision(channel: string): Promise<Revision>;

  /** Returns <0 / 0 / >0. MUST reject foreign revisions with EAPP_REVISION_INVALID (REV-8). */
  compareRevision(a: Revision, b: Revision): number;

  /** Internal, revision-pinned write used only by restore (§5.5 / SNAP-7). */
  writeStateWithRevision(
    channel: string,
    key: string,
    value: unknown,
    deleted: boolean,
    revision: Revision,
    actor: Identity,
  ): Promise<void>;
}

export type StateCapability = 'state' | 'revision' | 'watch' | 'snapshot';

/**
 * TS-2: every capability flag MUST have exactly one mandated runtime consequence,
 * enforced at the earliest possible call. r2 declared four flags and consulted none.
 */
export function assertStateCapability(transport: StateTransport, feature: StateCapability): void {
  const c = transport.capabilities;

  if (!c.supportsState) {
    throw new EappError(
      'EAPP_STATE_UNSUPPORTED',
      `transport ${transport.id} does not support state storage`,
    );
  }

  switch (feature) {
    case 'state':
      return;
    case 'revision':
      // Without a total per-channel order there is no correct CAS, so set/delete/restore
      // must fail loudly rather than silently losing updates (TS-4).
      if (!c.supportsStateRevision) {
        throw new EappError(
          'EAPP_STATE_UNSUPPORTED',
          `transport ${transport.id} cannot order revisions, so CAS is unavailable`,
        );
      }
      return;
    case 'watch':
      if (!c.supportsStateWatch) {
        // Raised synchronously where the API is synchronous (TS-2).
        throw new EappError('EAPP_WATCH_UNSUPPORTED', `transport ${transport.id} has no state watch`);
      }
      return;
    case 'snapshot':
      if (!c.supportsStateSnapshot) {
        throw new EappError('EAPP_UNSUPPORTED', `transport ${transport.id} has no state snapshot`);
      }
      return;
  }
}
