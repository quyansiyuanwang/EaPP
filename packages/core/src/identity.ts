/**
 * Identity — v3.0.0 §3 (frozen).
 *
 * ```
 * interface Identity { domain: string; id: string; instance: string }
 * ```
 *
 * Invariants: ID-1 (domain non-empty), ID-2 (id non-empty), ID-3 (instance unique
 * within `(domain, id)`), ID-4 (immutable — registry-issued identities are frozen),
 * ID-5 (not self-issued — only an `IdentityRegistry` mints identities),
 * ID-6 (no version semantics — the shape is exactly domain/id/instance).
 */

import { EappError } from './errors.js';

export interface Identity {
  domain: string;
  id: string;
  instance: string;
}

/** The complete field set of an Identity. Anything else is version semantics (ID-6). */
const IDENTITY_FIELDS: readonly string[] = ['domain', 'id', 'instance'];

function fail(message: string): never {
  throw new EappError('EAPP_IDENTITY_INVALID', message);
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${subject} MUST be an object carrying domain / id / instance`);
  }
  return value as Record<string, unknown>;
}

function readText(record: Record<string, unknown>, field: string, subject: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${subject}.${field} MUST NOT be empty`); // ID-1 / ID-2
  }
  return value;
}

/**
 * Canonical Identity key: `domain/id/instance`.
 * Throws `EAPP_IDENTITY_INVALID` for malformed identities instead of producing a
 * key built from `undefined`.
 */
export function identityKey(identity: Identity): string {
  const record = asRecord(identity, 'Identity');
  const domain = readText(record, 'domain', 'Identity');
  const id = readText(record, 'id', 'Identity');
  const instance = readText(record, 'instance', 'Identity');
  return `${domain}/${id}/${instance}`;
}

/**
 * ID-1, ID-2, ID-6 — throws `EAPP_IDENTITY_INVALID` when the identity is empty or
 * carries fields beyond domain/id/instance (e.g. a version).
 */
export function assertValidIdentity(identity: Identity): void {
  const record = asRecord(identity, 'Identity');
  for (const key of Object.keys(record)) {
    if (!IDENTITY_FIELDS.includes(key)) {
      fail(`Identity MUST NOT carry the extra field '${key}' (ID-6: identity MUST NOT carry version semantics)`);
    }
  }
  readText(record, 'domain', 'Identity');
  readText(record, 'id', 'Identity');
  readText(record, 'instance', 'Identity');
}

/** Reads a structurally valid Identity into a canonical, frozen value object. */
function canonicalize(identity: Identity): Identity {
  assertValidIdentity(identity);
  const record = identity as unknown as Record<string, unknown>;
  return Object.freeze({
    domain: readText(record, 'domain', 'Identity'),
    id: readText(record, 'id', 'Identity'),
    instance: readText(record, 'instance', 'Identity'),
  });
}

/**
 * Issues identities. This is the only issuance path in the stack (ID-5): a Plugin
 * cannot mint its own identity, it receives one.
 */
export class IdentityRegistry {
  private readonly identities = new Map<string, Identity>();
  private readonly issued = new WeakSet<Identity>();
  private readonly instances = new Map<string, Set<string>>();
  private sequence = 0;

  /**
   * ID-3: `instance` MUST be unique within `(domain, id)`. When the seed omits
   * `instance`, a fresh one is derived deterministically.
   */
  create(seed: { domain: string; id: string; instance?: string }): Identity {
    const record = asRecord(seed, 'Identity seed');
    for (const key of Object.keys(record)) {
      if (!IDENTITY_FIELDS.includes(key)) {
        fail(`Identity seed MUST NOT carry the extra field '${key}' (ID-6)`);
      }
    }
    const domain = readText(record, 'domain', 'Identity seed');
    const id = readText(record, 'id', 'Identity seed');
    const bucketKey = `${domain}/${id}`;
    const bucket = this.instances.get(bucketKey) ?? new Set<string>();

    let instance: string;
    const requested = record['instance'];
    if (requested !== undefined) {
      instance = readText(record, 'instance', 'Identity seed');
      if (bucket.has(instance)) {
        throw new EappError(
          'EAPP_IDENTITY_DUPLICATE',
          `Identity instance '${instance}' already exists within (${domain}, ${id}) (ID-3)`,
        );
      }
    } else {
      do {
        this.sequence += 1;
        instance = `${id}-${this.sequence}`;
      } while (bucket.has(instance));
    }

    const identity: Identity = canonicalize({ domain, id, instance });
    bucket.add(instance);
    this.instances.set(bucketKey, bucket);
    this.identities.set(identityKey(identity), identity);
    this.issued.add(identity);
    return identity;
  }

  has(identity: Identity): boolean {
    return this.identities.has(identityKey(identity));
  }

  get(key: string): Identity | undefined {
    return this.identities.get(key);
  }

  /** Same as `get`, but throws `EAPP_IDENTITY_INVALID` for unknown identities. */
  require(identity: Identity): Identity {
    const key = identityKey(identity);
    const found = this.identities.get(key);
    if (found === undefined) {
      throw new EappError('EAPP_IDENTITY_INVALID', `Unknown identity '${key}'`);
    }
    return found;
  }

  list(): Identity[] {
    return [...this.identities.values()];
  }

  /**
   * ID-5: was this identity issued by *this* registry? Identities fabricated by a
   * Plugin (a plain object literal) are not self-issued.
   */
  isIssued(identity: Identity): boolean {
    return this.issued.has(identity);
  }
}
