import { EappError } from '@eapp/core';
import type { Cursor } from './cursor.js';

/**
 * Mode message shapes — EaPP v3.1.0 §3.
 *
 * Request / Event / Stream each have a frozen envelope. They live here, in the
 * Interaction Layer, because v3.1 owns them; the runtime and any transport above it must
 * use these shapes rather than inventing their own.
 */

/**
 * §3.1. One sender, one receiver, one response.
 * RQ-1: every request carries a unique `correlationId`.
 * RQ-4: once `deadline` (ms since epoch) passes, the request is considered timed out.
 */
export interface RequestMessage {
  correlationId: string;
  operation: string;
  payload: unknown;
  deadline?: number;
}

/** §3.1. RQ-3: the response MUST carry the same `correlationId`. */
export interface ResponseMessage {
  correlationId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown; retryable?: boolean };
}

/** §3.2. Fire and forget. EV-1: an event MUST NOT expect a response. */
export interface EventMessage {
  topic: string;
  payload: unknown;
  headers?: Record<string, unknown>;
}

/** §3.3. An ordered sequence. ST-1: `cursor` is globally monotonically increasing. */
export interface StreamMessage {
  cursor: Cursor;
  payload: unknown;
}

let correlationSeq = 0;

/** RQ-1: unique per request, without requiring a UUID source. */
export function newCorrelationId(prefix = 'req'): string {
  correlationSeq += 1;
  return `${prefix}-${correlationSeq.toString(36)}-${Date.now().toString(36)}`;
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { correlationId?: unknown; operation?: unknown };
  return typeof candidate.correlationId === 'string' && typeof candidate.operation === 'string';
}

export function isResponseMessage(value: unknown): value is ResponseMessage {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { correlationId?: unknown; ok?: unknown };
  return typeof candidate.correlationId === 'string' && typeof candidate.ok === 'boolean';
}

export function assertRequestMessage(value: unknown): asserts value is RequestMessage {
  if (!isRequestMessage(value)) {
    throw new EappError('EAPP_TIMEOUT', 'not a request message');
  }
  if (value.correlationId.length === 0 || value.operation.length === 0) {
    throw new EappError('EAPP_TIMEOUT', 'request MUST carry correlationId and operation');
  }
}

export function assertResponseMessage(value: unknown): asserts value is ResponseMessage {
  if (!isResponseMessage(value)) {
    throw new EappError('EAPP_INTERNAL', 'not a response message');
  }
}

/** RQ-4: a request whose deadline has passed MUST be treated as timed out. */
export function isRequestExpired(request: RequestMessage, now: number = Date.now()): boolean {
  return request.deadline !== undefined && now > request.deadline;
}

/**
 * RQ-2 / RQ-3: correlates responses with their request.
 *
 * A request maps to ZERO or ONE response, and the response must quote the request's own
 * correlationId. `settle` returns false for a second reply to a request that has already
 * been answered, or for a reply nobody is waiting for — both are dropped rather than
 * being allowed to resolve a call twice.
 */
export class CorrelationTracker {
  readonly #outstanding = new Set<string>();

  /** RQ-1: registering an id that is already outstanding is a programming error. */
  begin(correlationId: string): void {
    if (this.#outstanding.has(correlationId)) {
      throw new EappError('EAPP_INTERNAL', `correlationId '${correlationId}' is already in flight`);
    }
    this.#outstanding.add(correlationId);
  }

  /** RQ-2 / RQ-3. */
  settle(response: ResponseMessage): boolean {
    if (!this.#outstanding.has(response.correlationId)) return false;
    this.#outstanding.delete(response.correlationId);
    return true;
  }

  /** Drop a request that will never be answered (timed out). */
  abandon(correlationId: string): void {
    this.#outstanding.delete(correlationId);
  }

  has(correlationId: string): boolean {
    return this.#outstanding.has(correlationId);
  }

  get size(): number {
    return this.#outstanding.size;
  }
}

export { EappError };
