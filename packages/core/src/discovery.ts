/**
 * Discovery — v3.0.0 §8 (frozen).
 *
 * Invariants: D-1 (find returns only Plugins visible in the current trust scope),
 * D-2 (watch only fires for events inside that scope), D-3 (discovery never implies
 * composability), D-4 (caching is allowed but MUST have an invalidation policy),
 * D-5 (discovery MUST NOT replace binding), D-6 (`DiscoveryEvent.type` is
 * added | removed | changed), D-7 (trust levels are categories, not an ordering).
 *
 * Trust scopes are only honoured when the service actually has a policy for them:
 * a scope the service cannot evaluate is rejected with `EAPP_DISCOVERY_SCOPE_INVALID`
 * instead of being silently ignored. That keeps D-1/D-2 falsifiable.
 */

import type { Constraint } from './capability.js';
import { EappError } from './errors.js';
import type { Identity } from './identity.js';
import { assertValidIdentity } from './identity.js';
import type { Plugin, PluginRef, PluginRegistry } from './plugin.js';
import { satisfiesRange } from './semver.js';

export type TrustLevel = 'L0' | 'L1' | 'L2';

export interface DiscoveryScope {
  trustLevel?: TrustLevel;
  trustDomain?: string;
}

export interface Criteria {
  capability?: string;
  /**
   * A SemVer RANGE, not an exact value — §8.1 declares it as one, and reading it as exact
   * made `find({ version: '^1.0.0' })` silently return nothing. A bare version still means
   * that version exactly; `'*'` means any. See `semver.ts` for the supported grammar.
   */
  version?: string;
  constraints?: Constraint[];
  identity?: Partial<Identity>;
}

export interface DiscoveryEvent {
  type: 'added' | 'removed' | 'changed';
  plugin: PluginRef;
}

/** The two discovery operations (§8.1). */
export interface Discovery {
  find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]>;
  watch(criteria: Criteria, scope: DiscoveryScope): AsyncIterable<DiscoveryEvent>;
}

/**
 * What the service knows about trust scopes. Only declared levels/domains are
 * accepted; `isVisible` decides visibility inside an accepted scope. There is no
 * implicit hierarchy between levels (D-7).
 */
export interface DiscoveryTrustPolicy {
  trustLevels?: readonly TrustLevel[];
  trustDomains?: readonly string[];
  isVisible?: (plugin: PluginRef, scope: DiscoveryScope) => boolean;
}

/** `watch` result: an async iterable that additionally exposes `close()`. */
export interface DiscoveryWatch extends AsyncIterable<DiscoveryEvent> {
  close(): void;
}

export interface DiscoveryCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export const TRUST_LEVELS: readonly TrustLevel[] = Object.freeze(['L0', 'L1', 'L2'] as const);

export function isTrustLevel(value: unknown): value is TrustLevel {
  return value === 'L0' || value === 'L1' || value === 'L2';
}

function structuralEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => structuralEquals(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.hasOwn(bRecord, key) && structuralEquals(aRecord[key], bRecord[key]),
  );
}

function constraintSatisfied(declared: Constraint, wanted: Constraint): boolean {
  return declared.kind === wanted.kind && structuralEquals(declared.value, wanted.value);
}

/** Criteria matching used by both `find` and `watch` (§8.1). */
export function matchesCriteria(plugin: Plugin, criteria: Criteria): boolean {
  const identityFilter = criteria.identity;
  if (identityFilter !== undefined) {
    for (const field of ['domain', 'id', 'instance'] as const) {
      const expected = identityFilter[field];
      if (expected !== undefined && plugin.identity[field] !== expected) {
        return false;
      }
    }
  }

  const name = criteria.capability;
  const version = criteria.version;
  const wanted = criteria.constraints ?? [];
  if (name === undefined && version === undefined && wanted.length === 0) {
    return true;
  }

  return plugin.capabilities.some((capability) => {
    if (name !== undefined && capability.name !== name) {
      return false;
    }
    // §8.1 declares `Criteria.version` a SemVer RANGE, not an exact value. Treating it as
    // exact made `find({ version: '^1.0.0' })` silently return nothing, which is
    // indistinguishable from "no plugin matches".
    if (version !== undefined && !satisfiesRange(capability.version, version)) {
      return false;
    }
    const declared = capability.constraints ?? [];
    return wanted.every((constraint) =>
      declared.some((candidate) => constraintSatisfied(candidate, constraint)),
    );
  });
}

/** Internal unbounded queue backing `watch`; closed queues resolve pending reads. */
class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  get size(): number {
    return this.items.length;
  }
}

interface Watcher {
  criteria: Criteria;
  isVisible: (plugin: PluginRef) => boolean;
  queue: AsyncEventQueue<DiscoveryEvent>;
}

interface CacheEntry {
  revision: number;
  refs: readonly PluginRef[];
}

interface ResolvedScope {
  scope: DiscoveryScope;
  isVisible: (plugin: PluginRef) => boolean;
}

export class DiscoveryService implements Discovery {
  private readonly registry: PluginRegistry;
  private readonly policy: DiscoveryTrustPolicy;
  private readonly watchers = new Set<Watcher>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly unsubscribeRegistry: () => void;
  private hits = 0;
  private misses = 0;

  constructor(registry: PluginRegistry, policy?: DiscoveryTrustPolicy) {
    this.registry = registry;
    this.policy = policy ?? {};
    // D-4 invalidation policy: any registry mutation invalidates cached results.
    this.unsubscribeRegistry = registry.onChange(() => {
      this.invalidate();
    });
  }

  /** D-1: only Plugins visible in the given scope are returned. */
  async find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]> {
    const resolved = this.resolveScope(scope, 'find');
    const cacheKey = this.cacheKey(criteria, resolved.scope);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.revision === this.registry.changeRevision()) {
      this.hits += 1;
      return cached.refs.map((ref) => ref);
    }

    this.misses += 1;
    const refs = this.registry
      .list()
      .filter((plugin) => resolved.isVisible(plugin.identity) && matchesCriteria(plugin, criteria))
      .map((plugin) => plugin.identity);
    const frozen: readonly PluginRef[] = Object.freeze(refs);
    this.cache.set(cacheKey, { revision: this.registry.changeRevision(), refs: frozen });
    return frozen.map((ref) => ref);
  }

  /**
   * D-2: the returned iterable only yields events inside the given scope.
   * The scope gate throws synchronously, before a watcher is registered.
   */
  watch(criteria: Criteria, scope: DiscoveryScope): DiscoveryWatch {
    const resolved = this.resolveScope(scope, 'watch');
    const queue = new AsyncEventQueue<DiscoveryEvent>();
    const watcher: Watcher = {
      criteria: { ...criteria },
      isVisible: resolved.isVisible,
      queue,
    };
    this.watchers.add(watcher);

    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      this.watchers.delete(watcher);
      queue.close();
    };

    const iterable: DiscoveryWatch = {
      close,
      [Symbol.asyncIterator](): AsyncIterator<DiscoveryEvent> {
        return (async function* iterate(): AsyncGenerator<DiscoveryEvent> {
          try {
            while (true) {
              const result = await queue.next();
              if (result.done === true) {
                return;
              }
              yield result.value;
            }
          } finally {
            // `for await ... break` calls `return()` on this generator: unregister
            // here so a broken loop does not leak a watcher.
            close();
          }
        })();
      },
    };
    return iterable;
  }

  /** D-6: only added | removed | changed are valid; anything else is rejected. */
  notify(event: DiscoveryEvent): void {
    const source: unknown = event;
    if (typeof source !== 'object' || source === null) {
      throw new EappError('EAPP_DISCOVERY_SCOPE_INVALID', 'DiscoveryEvent MUST be an object');
    }
    const record = source as Record<string, unknown>;
    const type = record['type'];
    if (type !== 'added' && type !== 'removed' && type !== 'changed') {
      throw new EappError(
        'EAPP_DISCOVERY_SCOPE_INVALID',
        `DiscoveryEvent.type MUST be added | removed | changed (D-6), received '${String(type)}'`,
      );
    }
    const plugin = record['plugin'];
    try {
      assertValidIdentity(plugin as Identity);
    } catch (error) {
      throw new EappError('EAPP_DISCOVERY_SCOPE_INVALID', 'DiscoveryEvent.plugin MUST be a valid Identity', {
        details: error,
      });
    }
    const discoveryEvent: DiscoveryEvent = { type, plugin: plugin as PluginRef };

    // Any event invalidates cached results (D-4).
    this.invalidate();

    for (const watcher of [...this.watchers]) {
      if (!watcher.isVisible(discoveryEvent.plugin)) {
        continue; // D-2
      }
      if (!this.matchesEvent(watcher.criteria, discoveryEvent.plugin)) {
        continue;
      }
      watcher.queue.push(discoveryEvent);
    }
  }

  /** Explicit cache invalidation (D-4). */
  invalidate(): void {
    this.cache.clear();
  }

  cacheStats(): DiscoveryCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }

  /** Number of live watchers; the async-iterable exit path must return this to 0. */
  watcherCount(): number {
    return this.watchers.size;
  }

  /** Detach from the registry; afterwards the service stops caching/mutating. */
  dispose(): void {
    this.unsubscribeRegistry();
    this.invalidate();
    for (const watcher of [...this.watchers]) {
      this.watchers.delete(watcher);
      watcher.queue.close();
    }
  }

  private matchesEvent(criteria: Criteria, plugin: PluginRef): boolean {
    const registered = this.registry.get(plugin);
    if (registered !== undefined) {
      return matchesCriteria(registered, criteria);
    }
    // A plugin that is no longer registered can only be matched on identity
    // criteria (D-3: discovery never implies composability).
    const hasCapabilityFilter =
      criteria.capability !== undefined ||
      criteria.version !== undefined ||
      (criteria.constraints !== undefined && criteria.constraints.length > 0);
    if (hasCapabilityFilter) {
      return false;
    }
    const detached: Plugin = { identity: plugin, capabilities: [], lifecycle: 'INACTIVE' };
    return matchesCriteria(detached, criteria);
  }

  private cacheKey(criteria: Criteria, scope: DiscoveryScope): string {
    const identityFilter = criteria.identity;
    const identityPart =
      identityFilter === undefined
        ? null
        : [identityFilter.domain ?? null, identityFilter.id ?? null, identityFilter.instance ?? null];
    return JSON.stringify([
      scope.trustLevel ?? null,
      scope.trustDomain ?? null,
      criteria.capability ?? null,
      criteria.version ?? null,
      identityPart,
      criteria.constraints ?? null,
    ]);
  }

  /**
   * Accepts a scope only when the service has a policy for every field it carries.
   * Unknown fields are rejected too: a typo MUST NOT turn D-1/D-2 into a no-op.
   */
  private resolveScope(scope: DiscoveryScope, method: string): ResolvedScope {
    const source: unknown = scope ?? {};
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new EappError('EAPP_DISCOVERY_SCOPE_INVALID', `${method}() requires a DiscoveryScope object`);
    }
    const record = source as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'trustLevel' && key !== 'trustDomain') {
        throw new EappError(
          'EAPP_DISCOVERY_SCOPE_INVALID',
          `Unknown DiscoveryScope field '${key}' (only trustLevel / trustDomain exist)`,
        );
      }
    }

    const trustLevel = record['trustLevel'];
    if (trustLevel !== undefined) {
      if (!isTrustLevel(trustLevel)) {
        throw new EappError('EAPP_DISCOVERY_SCOPE_INVALID', `trustLevel MUST be one of L0 | L1 | L2`);
      }
      if (!(this.policy.trustLevels ?? []).includes(trustLevel)) {
        throw new EappError(
          'EAPP_DISCOVERY_SCOPE_INVALID',
          `No trust policy for level '${trustLevel}': a scope MUST NOT be silently ignored (D-1, D-2)`,
        );
      }
    }

    const trustDomain = record['trustDomain'];
    if (trustDomain !== undefined) {
      if (typeof trustDomain !== 'string' || trustDomain.trim().length === 0) {
        throw new EappError('EAPP_DISCOVERY_SCOPE_INVALID', 'trustDomain MUST be a non-empty string');
      }
      if (!(this.policy.trustDomains ?? []).includes(trustDomain)) {
        throw new EappError(
          'EAPP_DISCOVERY_SCOPE_INVALID',
          `No trust policy for domain '${trustDomain}': a scope MUST NOT be silently ignored (D-1, D-2)`,
        );
      }
    }

    const resolvedScope: DiscoveryScope = {
      ...(trustLevel !== undefined ? { trustLevel } : {}),
      ...(trustDomain !== undefined ? { trustDomain } : {}),
    };
    const predicate = this.policy.isVisible;
    const isVisible =
      predicate === undefined
        ? (): boolean => true
        : (plugin: PluginRef): boolean => predicate(plugin, resolvedScope);
    return { scope: resolvedScope, isVisible };
  }
}
