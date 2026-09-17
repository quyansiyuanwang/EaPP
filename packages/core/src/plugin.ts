/**
 * Plugin — v3.0.0 §5 (frozen).
 *
 * ```
 * interface Plugin { identity: Identity; capabilities: Capability[]; lifecycle: LifecycleState }
 * ```
 *
 * Invariants: P-1 (unique identity), P-2 (capabilities MAY be empty), P-3 (identity
 * MUST NOT change during the lifecycle), P-4 (the capability set MAY change through
 * explicit declaration only).
 */

import { assertValidCapability, capabilityMatches } from './capability.js';
import type { Capability, CapabilityRef, Constraint, ContractRef } from './capability.js';
import { EappError } from './errors.js';
import { assertValidIdentity, identityKey } from './identity.js';
import type { Identity } from './identity.js';
import { assertTransition, isLifecycleState } from './lifecycle.js';
import type { LifecycleState } from './lifecycle.js';

/** A reference to a Plugin is its Identity. */
export type PluginRef = Identity;

export interface Plugin {
  identity: Identity;
  capabilities: Capability[];
  lifecycle: LifecycleState;
}

/** Change notification, used by Discovery (cache invalidation) and Binding derivation. */
export interface PluginChangeEvent {
  type: 'registered' | 'lifecycle' | 'capabilities';
  plugin: PluginRef;
}

interface PluginRecord {
  readonly identity: Identity;
  capabilities: Capability[];
  lifecycle: LifecycleState;
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EappError('EAPP_INTERNAL', `${subject} MUST be an object`);
  }
  return value as Record<string, unknown>;
}

/** Validates the identity and returns a canonical frozen copy (P-3, ID-4, ID-6). */
function canonicalIdentity(value: unknown): Identity {
  assertValidIdentity(value as Identity);
  const record = value as unknown as Record<string, unknown>;
  return Object.freeze({
    domain: record['domain'] as string,
    id: record['id'] as string,
    instance: record['instance'] as string,
  });
}

/**
 * Validates and copies the declared capability set (P-2 allows an empty array).
 * The copies are defensive: mutating the array the caller passed in MUST NOT
 * silently change the registry (P-4 requires an explicit declaration).
 */
function canonicalCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value)) {
    throw new EappError('EAPP_CAPABILITY_NOT_FOUND', 'Plugin.capabilities MUST be an array (MAY be empty, P-2)');
  }
  const capabilities: Capability[] = [];
  for (const entry of value) {
    assertValidCapability(entry as Capability);
    const record = entry as unknown as Record<string, unknown>;
    const capability: Capability = {
      name: record['name'] as string,
      version: record['version'] as string,
      ...(record['contract'] !== undefined ? { contract: record['contract'] as ContractRef } : {}),
      ...(record['constraints'] !== undefined
        ? { constraints: record['constraints'] as Constraint[] }
        : {}),
    };
    capabilities.push(Object.freeze(capability));
  }
  return capabilities;
}

/** A frozen read-only view over the live registry record. */
function createPluginView(record: PluginRecord): Plugin {
  const view = {
    get identity(): Identity {
      return record.identity;
    },
    get capabilities(): Capability[] {
      return [...record.capabilities];
    },
    get lifecycle(): LifecycleState {
      return record.lifecycle;
    },
  };
  return Object.freeze(view);
}

export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>();
  private readonly views = new Map<string, Plugin>();
  private readonly listeners = new Set<(event: PluginChangeEvent) => void>();
  private changes = 0;

  /** P-1: two Plugins MUST NOT share an identity. */
  register(plugin: Plugin): void {
    const source = asRecord(plugin, 'Plugin');
    const identity = canonicalIdentity(source['identity']);
    const key = identityKey(identity);
    if (this.records.has(key)) {
      throw new EappError('EAPP_IDENTITY_DUPLICATE', `Plugin '${key}' is already registered (P-1)`);
    }
    const capabilities = canonicalCapabilities(source['capabilities']);
    const lifecycle = source['lifecycle'];
    if (!isLifecycleState(lifecycle)) {
      throw new EappError('EAPP_LIFECYCLE_INVALID', `Plugin.lifecycle MUST be INACTIVE | ACTIVE | SUSPENDED`);
    }
    const record: PluginRecord = { identity, capabilities, lifecycle };
    this.records.set(key, record);
    this.views.set(key, createPluginView(record));
    this.touch({ type: 'registered', plugin: identity });
  }

  get(identity: Identity): Plugin | undefined {
    return this.views.get(identityKey(identity));
  }

  /** Throws `EAPP_PLUGIN_NOT_FOUND` for unknown plugins (B-1 relies on this). */
  require(identity: Identity): Plugin {
    const key = identityKey(identity);
    const view = this.views.get(key);
    if (view === undefined) {
      throw new EappError('EAPP_PLUGIN_NOT_FOUND', `Plugin '${key}' is not registered`);
    }
    return view;
  }

  list(): Plugin[] {
    return [...this.views.values()];
  }

  /** §7.3: only transitions listed in the lifecycle table are accepted. */
  setLifecycle(identity: Identity, state: LifecycleState): void {
    const record = this.record(identity);
    if (!isLifecycleState(state)) {
      throw new EappError('EAPP_LIFECYCLE_INVALID', `Unknown lifecycle state '${String(state)}'`);
    }
    assertTransition(record.lifecycle, state);
    if (record.lifecycle === state) {
      return; // INACTIVE -> INACTIVE (deactivate) is a legal no-op
    }
    record.lifecycle = state;
    this.touch({ type: 'lifecycle', plugin: record.identity });
  }

  /**
   * P-4: an explicit capability declaration replaces the exposed set.
   * Withdrawing a capability makes dependent bindings derive to DORMANT (§6.6).
   */
  declareCapabilities(identity: Identity, capabilities: Capability[]): void {
    const record = this.record(identity);
    record.capabilities = canonicalCapabilities(capabilities);
    this.touch({ type: 'capabilities', plugin: record.identity });
  }

  /** Alias of `declareCapabilities` kept for callers that read "set". */
  setCapabilities(identity: Identity, capabilities: Capability[]): void {
    this.declareCapabilities(identity, capabilities);
  }

  /** C-4 / C-6 — does `from` expose exactly `name@version`? (B-2, O-2) */
  findExposing(ref: Omit<CapabilityRef, 'plugin'>, from: Identity): boolean {
    const record = this.records.get(identityKey(from));
    if (record === undefined) {
      return false;
    }
    return record.capabilities.some((capability) => capabilityMatches(capability, ref));
  }

  /** Monotonic change counter; the Discovery cache uses it as its invalidation stamp. */
  changeRevision(): number {
    return this.changes;
  }

  /** Subscribe to registry mutations. Returns an unsubscribe function. */
  onChange(listener: (event: PluginChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.records.size;
  }

  private record(identity: Identity): PluginRecord {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (record === undefined) {
      throw new EappError('EAPP_PLUGIN_NOT_FOUND', `Plugin '${key}' is not registered`);
    }
    return record;
  }

  private touch(event: PluginChangeEvent): void {
    this.changes += 1;
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
