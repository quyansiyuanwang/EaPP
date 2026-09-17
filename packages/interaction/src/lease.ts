import { EappError } from '@eapp/core';
import type { Cursor } from './cursor.js';

/**
 * Lease — EaPP v3.1.0 §5. Reliable competing consumption: "who claimed this item,
 * and until when?"
 *
 * L-2 ("the same cursor MUST NOT be held by two ACTIVE leases at once") is enforced by
 * keying on the cursor, so a second claim against a live entry is a conflict.
 *
 * Time is injected rather than read from `Date.now()` directly so that expiry can be
 * tested without sleeping.
 */

export interface Lease {
  readonly leaseId: string;
  readonly cursor: Cursor;
  readonly expiresAt: number;
  ack(): Promise<void>;
  nack(): Promise<void>;
  renew(ttl: number): Promise<void>;
}

export type LeaseStatus = 'ACTIVE' | 'ACKED' | 'NACKED' | 'EXPIRED';

interface LeaseEntry {
  leaseId: string;
  cursor: Cursor;
  expiresAt: number;
  status: LeaseStatus;
}

export interface LeaseManagerOptions {
  now?: () => number;
}

let leaseSeq = 0;

export class LeaseManager {
  readonly #now: () => number;
  readonly #entries = new Map<Cursor, LeaseEntry>();

  constructor(options: LeaseManagerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  claim(cursor: Cursor, ttl: number): Lease {
    this.releaseExpired();
    const existing = this.#entries.get(cursor);
    if (existing && existing.status === 'ACTIVE') {
      throw new EappError('EAPP_LEASE_CONFLICT', `cursor ${cursor} already has an active lease`);
    }

    const entry: LeaseEntry = {
      leaseId: `lease-${++leaseSeq}`,
      cursor,
      expiresAt: this.#now() + ttl,
      status: 'ACTIVE',
    };
    this.#entries.set(cursor, entry);
    return this.#leaseFor(entry);
  }

  #leaseFor(entry: LeaseEntry): Lease {
    const requireLive = (): void => {
      if (entry.status !== 'ACTIVE') {
        throw new EappError('EAPP_LEASE_CLOSED', 'lease is no longer active');
      }
    };

    return {
      get leaseId() {
        return entry.leaseId;
      },
      get cursor() {
        return entry.cursor;
      },
      get expiresAt() {
        return entry.expiresAt;
      },
      ack: async () => {
        if (entry.status === 'ACKED') return; // L-3 idempotent
        requireLive();
        entry.status = 'ACKED';
      },
      nack: async () => {
        if (entry.status === 'NACKED') return; // L-4 idempotent
        requireLive();
        entry.status = 'NACKED';
      },
      renew: async (ttl: number) => {
        if (entry.status !== 'ACTIVE') {
          // L-5: renew() is valid only for an ACTIVE lease
          throw new EappError('EAPP_LEASE_EXPIRED', 'lease is not renewable');
        }
        entry.expiresAt = this.#now() + ttl;
      },
    };
  }

  /** L-6 / L-7: expiry frees the cursor for a new claim and never touches live entries. */
  releaseExpired(): void {
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      if (entry.status === 'ACTIVE' && entry.expiresAt <= now) {
        entry.status = 'EXPIRED';
      }
    }
  }

  release(cursor: Cursor): void {
    const entry = this.#entries.get(cursor);
    if (entry && entry.status === 'ACTIVE') entry.status = 'NACKED';
  }

  status(cursor: Cursor): LeaseStatus | undefined {
    return this.#entries.get(cursor)?.status;
  }

  active(): Lease[] {
    this.releaseExpired();
    const out: Lease[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.status === 'ACTIVE') out.push(this.#leaseFor(entry));
    }
    return out;
  }

  get size(): number {
    return this.#entries.size;
  }
}
