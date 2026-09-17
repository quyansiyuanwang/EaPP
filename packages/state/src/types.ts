import type { Identity } from '@eapp/core';
import type { CursorAnchor, SubscriptionMode } from '@eapp/interaction';

/**
 * State Mode ontology — EaPP v3.2.0 §2.
 *
 * The single most important decision in this file is what `Revision` IS. Read as a
 * per-cell counter it cannot serve as an observation position, which makes the whole
 * watcher contract unimplementable. Here it is the **position of the write in the
 * channel's state log**, which is the same thing v3.1 calls a `Cursor`
 * (§6.1: "the position a consumer has acknowledged up to", globally ordered per
 * Channel). Revision and Cursor are therefore the same domain, and REV-7 stops being an
 * exception and becomes a consequence of CR-1.
 */

/** A position in the channel's state log. Opaque; ordered within one (transport, channel). */
export type Revision = string;

/**
 * null  -> the key MUST NOT have ever existed
 * Revision -> the key MUST exist and its revision MUST match exactly
 *
 * `null` is the ONLY representation of "absent". Strings such as `''` or `'0'` are not.
 */
export type ExpectedRevision = Revision | null;

export interface StateCell {
  readonly key: string;
  /** Position of the write that produced this cell. */
  readonly revision: Revision;
  readonly value: unknown;
  readonly deleted: boolean;
  readonly updatedAt: number;
  readonly updatedBy: Identity;
}

export interface StateUpdate {
  key: string;
  /**
   * Presence is decided by the property existing, NOT by `value !== undefined`
   * (§5.3 SU-2), so `{ value: undefined }` is a legitimate write with a definite meaning.
   */
  value?: unknown;
  /** When present it MUST be `true`; `deleted: false` is rejected (§5.3 SU-9). */
  deleted?: boolean;
  expectedRevision: ExpectedRevision;
  /** Falls back to `StateChannelConfig.owner` when omitted (§5, D-09). */
  actor?: Identity;
}

export type StatePattern =
  | { readonly key: string }
  | { readonly prefix: string }
  | { readonly all: true };

/** One committed entry in the state log. */
export interface StateChange {
  readonly channel: string;
  readonly revision: Revision;
  readonly key: string;
  readonly type: 'set' | 'deleted';
  /** Present iff `type === 'set'`. */
  readonly value?: unknown;
}

export interface StateSnapshot {
  readonly channel: string;
  /** The selection this snapshot covers (§9.1). Without it a snapshot cannot be restored
to a subset of its own key space. */
  readonly pattern: StatePattern;
  readonly cells: StateCell[];
  /** The channel head observed BEFORE the cells were read (§9.2). */
  readonly maxRevision: Revision;
  readonly takenAt: number;
}

export interface WatchOptions {
  /** Defaults to 'latest'. Resolved eagerly, before `watch()` resolves (§7.4). */
  cursor?: CursorAnchor;
  /** Defaults to 'exclusive'. */
  mode?: SubscriptionMode;
  group?: string;
  /** Fallback poll interval when the transport has no `waitForChange`. */
  pollIntervalMs?: number;
}

export type RestoreMode = 'merge' | 'replace';

export interface StateChannelConfig {
  /** Core supports exactly one policy (CF-1). */
  conflictPolicy: 'cas';
  /**
   * The channel's owning identity. Used as `updatedBy` when a write carries no actor,
   * which is what makes SC-5 satisfiable at all: without an owner there is no source
   * for `updatedBy`, and SC-5 becomes a rule with no way to obey it.
   */
  owner: Identity;
}
