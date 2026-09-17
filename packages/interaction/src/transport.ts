import { EappError } from '@eapp/core';
import type { Cursor, CursorAnchor } from './cursor.js';
import type { DeliveryGuarantee } from './channel.js';

/**
 * Transport — EaPP v3.1.0 §10.
 *
 * A Transport moves bytes and allocates cursors. It MUST NOT define interaction
 * semantics (TR-1): no modes, no delivery guarantees, no lease or cursor policy.
 *
 * `durabilityBoundary` lives here because state consistency is defined relative to it
 * (v3.1 errata E1-7): a transport whose boundary is `'process'` must never be presented
 * as strongly consistent across processes.
 */

/** Content filter applied by the transport when reading. */
export type Pattern = { readonly all: true } | { readonly type: string };

export function validatePattern(pattern: Pattern): void {
  if (pattern === null || typeof pattern !== 'object') {
    throw new EappError('EAPP_CHANNEL_INVALID', 'pattern MUST be an object');
  }
  const keys = Object.keys(pattern);
  if (keys.length !== 1) {
    throw new EappError('EAPP_CHANNEL_INVALID', 'pattern MUST have exactly one field');
  }
  if (keys[0] === 'all') {
    if ((pattern as { all: unknown }).all !== true) {
      throw new EappError('EAPP_CHANNEL_INVALID', "pattern 'all' MUST be true");
    }
    return;
  }
  if (keys[0] === 'type') {
    if (typeof (pattern as { type: unknown }).type !== 'string') {
      throw new EappError('EAPP_CHANNEL_INVALID', "pattern 'type' MUST be a string");
    }
    return;
  }
  throw new EappError('EAPP_CHANNEL_INVALID', `unknown pattern field '${String(keys[0])}'`);
}

export function matchesPattern(value: unknown, pattern: Pattern): boolean {
  if ('all' in pattern) return true;
  if (value === null || typeof value !== 'object') return false;
  return (value as { type?: unknown }).type === pattern.type;
}

export interface TransportMessage {
  cursor: Cursor;
  payload: unknown;
}

export interface TransportCapabilities {
  persistent: boolean;
  ordering: 'none' | 'per-source' | 'global';
  delivery: {
    atMostOnce: boolean;
    atLeastOnce: boolean;
    replay: boolean;
  };
  supportsCursor: boolean;
  supportsLease: boolean;
  /** E1-7: the visibility scope of a durably stored message. */
  durabilityBoundary: 'process' | 'machine' | 'cluster' | 'global';
}

export interface Transport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;

  /** Append a message; the transport allocates and returns its cursor. */
  send(channel: string, msg: unknown): Promise<Cursor>;

  /**
   * Messages strictly after `cursor`, ascending.
   * `cursor === undefined` means "from the earliest retained position" (TR-6).
   * An empty result MUST return promptly and MUST NOT block (TR-7).
   */
  readAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: Pattern,
  ): Promise<TransportMessage[]>;

  close(): Promise<void>;

  /** Resolve 'earliest' / 'latest' for this channel. 'earliest' may fail with EAPP_CURSOR_TOO_OLD. */
  resolveAnchor?(channel: string, anchor: CursorAnchor): Promise<Cursor>;

  /** Optional: block until something is available strictly after `cursor`. */
  waitForChange?(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void>;
}

/**
 * TR-4 / E1-10: a Channel MUST NOT use a feature the transport does not declare,
 * and the failure MUST be explicit rather than a silent degradation.
 */
export function assertCapability(transport: Transport, feature: 'cursor' | 'lease'): void {
  const { capabilities } = transport;
  if (feature === 'cursor' && !capabilities.supportsCursor) {
    throw new EappError('EAPP_CURSOR_UNSUPPORTED', `transport ${transport.id} has no cursor support`);
  }
  if (feature === 'lease' && !capabilities.supportsLease) {
    throw new EappError('EAPP_UNSUPPORTED', `transport ${transport.id} has no lease support`);
  }
}

/** TR-2 / TR-3: declarations are checked, and an absent field is treated as unsupported. */
export function assertDeclared(transport: Transport): void {
  const c: Partial<TransportCapabilities> | undefined = transport.capabilities;
  if (!c || typeof c.persistent !== 'boolean' || typeof c.ordering !== 'string') {
    throw new EappError('EAPP_UNSUPPORTED', `transport ${transport.id} does not declare capabilities`);
  }
}

/**
 * TR-4: a Channel MUST NOT use a feature the transport does not provide.
 *
 * Declaring a capability and never consulting it is the same as not declaring it — worse,
 * because it looks enforced. A transport whose `atLeastOnce` is false must not be allowed
 * to carry a channel that promises at-least-once.
 */
export function assertTransportSupportsDelivery(
  transport: Transport,
  delivery: DeliveryGuarantee,
): void {
  const declared = transport.capabilities.delivery as
    | { atMostOnce?: boolean; atLeastOnce?: boolean }
    | undefined;
  const supported = delivery === 'at-least-once' ? declared?.atLeastOnce : declared?.atMostOnce;
  if (supported !== true) {
    throw new EappError(
      'EAPP_DELIVERY_UNSUPPORTED',
      `transport ${transport.id} does not declare '${delivery}' support`,
    );
  }
}
