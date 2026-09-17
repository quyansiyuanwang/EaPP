import type { Identity } from '@eapp/core';
import type { CursorAnchor, SubscriptionMode } from '@eapp/interaction';

/**
 * State Mode ontology — EaPP v3.2.0 §2.
 *
 * The single most important decision in this file is what `Revision` IS. In the r2
 * draft it was a per-cell counter, which could not serve as an observation position and
 * made the whole watcher contract unimplementable. Here it is the **position of the
 * write in the channel's state log**, which is the same thing v3.1 calls a `Cursor`
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

export interface StateDeleteRequest {
  key: string;
  expectedRevision: ExpectedRevision;
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
  /** The selection this snapshot covers. Added in r3; r2 had no way to say it (§9.1). */
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
   * which is what makes SC-5 satisfiable at all — r2 had no source for it.
   */
  owner: Identity;
}
