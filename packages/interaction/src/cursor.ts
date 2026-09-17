/**
 * Cursor and cursor anchors — EaPP v3.1.0 §6.
 *
 * A Cursor names "the position a consumer has acknowledged up to" (CR-1: globally
 * ordered within a Channel). It is deliberately opaque: consumers MUST NOT parse it.
 */

export type Cursor = string;

export interface CursorState {
  cursor: Cursor;
  pending: Cursor[];
}

/**
 * A position argument that may be either a literal anchor or a concrete cursor.
 *
 * v3.1 §6.2 rule 1: the literals MUST be recognised BEFORE a string is treated as a
 * concrete cursor. Without that ordering rule `'earliest'` would itself be a valid
 * `Cursor` and the two cases would be indistinguishable.
 */
export type CursorAnchor = 'earliest' | 'latest' | Cursor;

export const EARLIEST = 'earliest' as const;
export const LATEST = 'latest' as const;

export function isAnchorLiteral(value: string): value is 'earliest' | 'latest' {
  return value === EARLIEST || value === LATEST;
}

/**
 * Lexicographic comparison.
 *
 * This is correct precisely because transports allocate fixed-width, zero-padded
 * cursors (see `MemoryTransport`): for equal-width digit strings, lexicographic order
 * and numeric order coincide. A transport that allocated e.g. `'1'`, `'2'`, `'10'`
 * would break this, which is why @eapp/transport-memory pads to 20 characters.
 */
export function compareCursor(a: Cursor, b: Cursor): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function maxCursor(a: Cursor, b: Cursor): Cursor {
  return compareCursor(a, b) >= 0 ? a : b;
}
