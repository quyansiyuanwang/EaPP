import type { Identity } from '@eapp/core';
import type { Cursor, CursorAnchor, Pattern } from '@eapp/interaction';
import type {
  ExpectedRevision,
  Revision,
  StatePattern,
  StateUpdate,
} from '@eapp/state';

/**
 * The wire protocol of `@eapp/transport-socket`.
 *
 * This file is the whole contract between the broker (which owns the log) and the
 * clients (which only ever see positions). Two decisions in here are not obvious,
 * and both come from the same root cause: **the v3.1 / v3.2 data model distinguishes
 * things that JSON cannot represent.**
 */

export const WIRE_VERSION = 1;

/**
 * `StateUpdate` — SU-2 says the presence of `value` is decided by the property
 * EXISTING, not by `value !== undefined`. `{ key, value: undefined,
 * expectedRevision: null }` is therefore a legitimate write whose meaning is
 * "store undefined", and `validateUpdate()` accepts it.
 *
 * JSON cannot say that. `JSON.stringify({ value: undefined })` is `{}`, so a
 * transport that just serialises the update turns that write into
 * `{ key, expectedRevision: null }` — which `validateUpdate()` then REJECTS with
 * EAPP_STATE_VALUE_INVALID ("MUST specify a value or deleted = true").
 *
 * A silent round-trip failure of exactly the kind TR-1 forbids. So presence is
 * carried explicitly instead of being inferred.
 */
export interface WireStateUpdate {
  key: string;
  expectedRevision: ExpectedRevision;
  /** True iff the caller supplied a `value` property, whatever its value. */
  hasValue: boolean;
  value?: unknown;
  /** SU-9: only `true` is legal, so presence is what has to survive. */
  hasDeleted: boolean;
  actor?: Identity;
}

export function toWireUpdate(update: StateUpdate): WireStateUpdate {
  return {
    key: update.key,
    expectedRevision: update.expectedRevision,
    hasValue: Object.prototype.hasOwnProperty.call(update, 'value'),
    // Spread rather than assign: with `exactOptionalPropertyTypes`, writing
    // `value: undefined` is not the same as omitting the key.
    ...(Object.prototype.hasOwnProperty.call(update, 'value') ? { value: update.value } : {}),
    hasDeleted: Object.prototype.hasOwnProperty.call(update, 'deleted'),
    ...(update.actor !== undefined ? { actor: update.actor } : {}),
  };
}

export function fromWireUpdate(update: WireStateUpdate): StateUpdate {
  return {
    key: update.key,
    expectedRevision: update.expectedRevision,
    ...(update.hasValue ? { value: update.value } : {}),
    ...(update.hasDeleted ? { deleted: true } : {}),
  };
}

/**
 * `StateChange` — "`value` is present iff `type === 'set'`". A `set` of
 * `undefined` is legal, so the same presence problem applies to the change log.
 */
export interface WireStateChange {
  channel: string;
  revision: Revision;
  key: string;
  type: 'set' | 'deleted';
  hasValue: boolean;
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface WireError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WireRequest {
  op: string;
  /** Correlation id, so a long-poll response can arrive out of order. */
  id: number;
  channel?: string;
  cursor?: Cursor | null;
  anchor?: CursorAnchor;
  pattern?: Pattern | StatePattern;
  key?: string;
  message?: unknown;
  update?: WireStateUpdate;
  expectedRevision?: ExpectedRevision;
  actor?: Identity;
  value?: unknown;
  hasValue?: boolean;
  deleted?: boolean;
  revision?: Revision;
  /** `cancel`: the id of the request to abandon. */
  target?: number;
  /** ConsumerGroup operations (§8). */
  name?: string;
  holder?: string;
  cursors?: Cursor[];
  initialCursor?: Cursor;
  ttlMs?: number;
}

/**
 * A group's shared state, as it travels.
 *
 * `earliestExpiryInMs` is a duration, not a timestamp: the broker's clock and a
 * client's clock are not the same clock, and a duration is the only form that
 * survives the trip.
 */
export interface WireGroupView {
  cursor: Cursor;
  claimed: Cursor[];
  memberCount: number;
  earliestExpiryInMs?: number;
}

export type WireResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: WireError };

/** Sent by the broker in answer to `hello`. */
export interface BrokerHello {
  version: number;
  /** The transport id every cursor and revision this broker issues will carry. */
  id: string;
  capabilities: unknown;
}

export function isResponse(frame: WireRequest | WireResponse): frame is WireResponse {
  return 'ok' in frame;
}

// ---------------------------------------------------------------------------
// Framing: newline-delimited JSON
//
// Length-prefixing would be faster. Newline-delimited JSON is chosen because it is
// inspectable with `nc`, and a protocol you can debug by hand is worth more here
// than one that saves a few percent. Messages MUST NOT contain a literal newline —
// `JSON.stringify` never emits one.
// ---------------------------------------------------------------------------

export function encodeFrame(frame: WireRequest | WireResponse): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Reassembles frames from a byte stream that may split them anywhere. */
export class FrameDecoder {
  #buffer = '';

  push(chunk: string): Array<WireRequest | WireResponse> {
    this.#buffer += chunk;
    const frames: Array<WireRequest | WireResponse> = [];

    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) frames.push(JSON.parse(line) as WireRequest | WireResponse);
      index = this.#buffer.indexOf('\n');
    }

    return frames;
  }
}

/** True when `value` carries a cursor or revision this broker issued. */
export function carriesBrokerPrefix(transportId: string, value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${transportId}!`);
}
