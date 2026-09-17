/**
 * Composition Core operations — v3.0.0 §9 (frozen).
 *
 * Six Composition/Lifecycle control primitives (`bind`, `unbind`, `activate`,
 * `deactivate`, `suspend`, `resume`) plus the two Discovery operations (§9.1).
 *
 * The core deliberately knows *nothing* about channels: it only derives
 * `Binding` state (CH-1, B-3).
 */

import { bindingKey, deriveBindingState } from './binding.js';
import type { Binding, BindingState } from './binding.js';
import type { CapabilityRef, ContractRef } from './capability.js';
import { assertValidCapabilityRef } from './capability.js';
import { DiscoveryService } from './discovery.js';
import type {
  Criteria,
  DiscoveryEvent,
  DiscoveryScope,
  DiscoveryTrustPolicy,
  DiscoveryWatch,
} from './discovery.js';
import { EappError } from './errors.js';
import { identityKey } from './identity.js';
import type { LifecycleState } from './lifecycle.js';
import { PluginRegistry } from './plugin.js';
import type { PluginChangeEvent, PluginRef } from './plugin.js';

export interface BindRequest {
  from: PluginRef;
  to: PluginRef;
  capability: CapabilityRef;
  contract?: ContractRef;
}

export interface CompositionCore {
  // Discovery
  find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]>;
  watch(criteria: Criteria, scope: DiscoveryScope): AsyncIterable<DiscoveryEvent>;

  // Composition
  bind(request: BindRequest): Promise<Binding>;
  unbind(bindingId: string): Promise<void>;

  // Lifecycle
  activate(plugin: PluginRef): Promise<void>;
  deactivate(plugin: PluginRef): Promise<void>;
  suspend(plugin: PluginRef): Promise<void>;
  resume(plugin: PluginRef): Promise<void>;
}

export interface CompositionCoreOptions {
  /** Trust policy handed to the internal Discovery service (C4). */
  policy?: DiscoveryTrustPolicy;
  /** Reuse an existing Discovery service instead of creating one. */
  discovery?: DiscoveryService;
}

interface BindingRecord {
  readonly binding: Binding;
  readonly key: string;
  closed: boolean;
  state: BindingState;
}

export class CompositionCoreImpl implements CompositionCore {
  readonly registry: PluginRegistry;
  readonly discovery: DiscoveryService;

  private readonly bindings = new Map<string, BindingRecord>();
  private readonly openBindings = new Map<string, string>();
  private readonly pluginBindings = new Map<string, Set<string>>();
  private readonly listeners = new Set<(binding: Binding, state: BindingState) => void>();
  private readonly unsubscribeRegistry: () => void;
  private sequence = 0;

  constructor(registry?: PluginRegistry, options?: CompositionCoreOptions) {
    this.registry = registry ?? new PluginRegistry();
    this.discovery = options?.discovery ?? new DiscoveryService(this.registry, options?.policy);
    // A lifecycle change or a capability withdrawal re-derives the affected
    // bindings (§6.6, O-6, O-7, O-8).
    this.unsubscribeRegistry = this.registry.onChange((event) => {
      this.handleRegistryChange(event);
    });
  }

  // ---------------------------------------------------------------- Discovery

  find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]> {
    return this.discovery.find(criteria, scope);
  }

  watch(criteria: Criteria, scope: DiscoveryScope): DiscoveryWatch {
    return this.discovery.watch(criteria, scope);
  }

  // -------------------------------------------------------------- Composition

  /**
   * O-1: creates a Binding whose state is derived (§6.4).
   * Enforces B-1, B-2, B-7, O-2 and the atomic uniqueness rule B-8.
   */
  async bind(request: BindRequest): Promise<Binding> {
    const from = this.registry.require(request.from); // B-1
    const to = this.registry.require(request.to); // B-1
    assertValidCapabilityRef(request.capability); // C-1, C-2, C-5

    if (identityKey(request.capability.plugin) !== identityKey(from.identity)) {
      throw new EappError(
        'EAPP_BINDING_INVALID',
        'Binding.capability.plugin MUST equal Binding.from (B-7)',
        {
          details: {
            from: identityKey(from.identity),
            capabilityPlugin: identityKey(request.capability.plugin),
          },
        },
      );
    }

    if (
      !this.registry.findExposing(
        { name: request.capability.name, version: request.capability.version },
        from.identity,
      )
    ) {
      throw new EappError(
        'EAPP_CAPABILITY_NOT_EXPOSED',
        `Plugin '${identityKey(from.identity)}' does not expose ` +
          `${request.capability.name}@${request.capability.version} (B-2, O-2)`,
      );
    }

    // B-8: the uniqueness check and the creation below happen in one synchronous
    // block — no `await` separates them, so two concurrent `bind` calls cannot
    // both create a non-CLOSED Binding for the same (from, to, capability).
    const key = bindingKey(from.identity, to.identity, request.capability);
    const existingId = this.openBindings.get(key);
    if (existingId !== undefined) {
      const existing = this.bindings.get(existingId);
      if (existing !== undefined) {
        return existing.binding; // §6.8: return the existing non-CLOSED Binding
      }
    }

    const contract = request.contract;
    const capability: CapabilityRef = Object.freeze({
      plugin: from.identity,
      name: request.capability.name,
      version: request.capability.version,
    });
    const binding: Binding = Object.freeze({
      id: `binding-${(this.sequence += 1)}`,
      from: from.identity,
      to: to.identity,
      capability,
      ...(contract !== undefined ? { contract } : {}),
    });

    // B-9: the record does not exist until it is fully built; the state below is
    // derived (§6.4, B-3) and is the first state anyone can observe.
    const record: BindingRecord = { binding, key, closed: false, state: 'DORMANT' };
    record.state = this.deriveState(record);

    this.bindings.set(binding.id, record);
    this.openBindings.set(key, binding.id);
    this.index(record);
    this.emit(record);
    return binding;
  }

  /** O-3: sets the Binding to CLOSED. O-4: idempotent, unknown ids are no-ops. */
  async unbind(bindingId: string): Promise<void> {
    const record = this.bindings.get(bindingId);
    if (record === undefined || record.closed) {
      return; // O-4 — CLOSED is terminal (B-4), repeating `unbind` is a no-op
    }
    record.closed = true;
    this.openBindings.delete(record.key);
    this.refresh(record, true);
  }

  // ---------------------------------------------------------------- Lifecycle

  /** L-1, O-5: INACTIVE -> ACTIVE; calling it on an ACTIVE plugin is a no-op. */
  async activate(plugin: PluginRef): Promise<void> {
    const current = this.registry.require(plugin).lifecycle;
    if (current === 'ACTIVE') {
      return; // O-5 idempotency
    }
    if (current === 'SUSPENDED') {
      // L-6: a SUSPENDED plugin MUST be resumed, never activated.
      throw new EappError(
        'EAPP_LIFECYCLE_INVALID',
        'activate MUST NOT be used to resume a SUSPENDED plugin; use resume (L-6)',
      );
    }
    this.registry.setLifecycle(plugin, 'ACTIVE'); // L-1
  }

  /** L-2: any state -> INACTIVE. §7.4: deactivate MUST NOT close bindings. */
  async deactivate(plugin: PluginRef): Promise<void> {
    const current = this.registry.require(plugin).lifecycle;
    if (current === 'INACTIVE') {
      return; // already INACTIVE — a legal, idempotent no-op (§7.2)
    }
    this.registry.setLifecycle(plugin, 'INACTIVE');
  }

  /** L-3: valid only from ACTIVE. */
  async suspend(plugin: PluginRef): Promise<void> {
    const current = this.registry.require(plugin).lifecycle;
    if (current !== 'ACTIVE') {
      throw new EappError(
        'EAPP_LIFECYCLE_INVALID',
        `suspend applies only to ACTIVE plugins (L-3), '${identityKey(plugin)}' is ${current}`,
      );
    }
    this.registry.setLifecycle(plugin, 'SUSPENDED');
  }

  /** L-4, L-6: valid only from SUSPENDED; re-derives every affected Binding (O-8). */
  async resume(plugin: PluginRef): Promise<void> {
    const current = this.registry.require(plugin).lifecycle;
    if (current !== 'SUSPENDED') {
      throw new EappError(
        'EAPP_LIFECYCLE_INVALID',
        `resume applies only to SUSPENDED plugins (L-4, L-6), '${identityKey(plugin)}' is ${current}`,
      );
    }
    this.registry.setLifecycle(plugin, 'ACTIVE');
  }

  // ------------------------------------------------- Interaction-facing surface

  /** Derived state (§6.4). Throws `EAPP_BINDING_INVALID` for unknown bindings. */
  bindingState(bindingId: string): BindingState {
    const record = this.bindings.get(bindingId);
    if (record === undefined) {
      throw new EappError('EAPP_BINDING_INVALID', `Unknown binding '${bindingId}'`);
    }
    // Always derived from the current world — a Binding never stores its state.
    return this.deriveState(record);
  }

  /**
   * Lookup used by the Interaction layer: `undefined` for an unknown binding id,
   * otherwise the Binding (CLOSED ones included, so that CC-7 can report
   * `EAPP_BINDING_CLOSED` instead of "not found").
   */
  binding(bindingId: string): Binding | undefined {
    return this.bindings.get(bindingId)?.binding;
  }

  /** Throwing accessor: `EAPP_BINDING_INVALID` when unknown, `EAPP_BINDING_CLOSED` when closed. */
  requireBinding(bindingId: string): Binding {
    const record = this.bindings.get(bindingId);
    if (record === undefined) {
      throw new EappError('EAPP_BINDING_INVALID', `Unknown binding '${bindingId}'`);
    }
    if (record.closed) {
      throw new EappError('EAPP_BINDING_CLOSED', `Binding '${bindingId}' is CLOSED`);
    }
    return record.binding;
  }

  listBindings(): Binding[] {
    return [...this.bindings.values()].map((record) => record.binding);
  }

  /** Subscribe to derived-state changes. Returns an unsubscribe function. */
  onBindingStateChange(
    listener: (binding: Binding, state: BindingState) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Detach from the registry (used by tests and embedders). */
  dispose(): void {
    this.unsubscribeRegistry();
  }

  // ------------------------------------------------------------------ internals

  private handleRegistryChange(event: PluginChangeEvent): void {
    if (event.type === 'lifecycle' || event.type === 'capabilities') {
      this.refreshBindingsFor(event.plugin);
    }
  }

  private lifecycleOf(ref: PluginRef): LifecycleState {
    // A plugin that is no longer registered cannot keep a Binding ACTIVE.
    return this.registry.get(ref)?.lifecycle ?? 'INACTIVE';
  }

  private deriveState(record: BindingRecord): BindingState {
    const binding = record.binding;
    return deriveBindingState({
      closed: record.closed,
      fromLifecycle: this.lifecycleOf(binding.from),
      toLifecycle: this.lifecycleOf(binding.to),
      capabilityStillExposed: this.registry.findExposing(
        { name: binding.capability.name, version: binding.capability.version },
        binding.from,
      ),
    });
  }

  private refresh(record: BindingRecord, force = false): void {
    const next = this.deriveState(record);
    if (!force && next === record.state) {
      return;
    }
    record.state = next;
    this.emit(record);
  }

  private refreshBindingsFor(plugin: PluginRef): void {
    const ids = this.pluginBindings.get(identityKey(plugin));
    if (ids === undefined) {
      return;
    }
    for (const id of [...ids]) {
      const record = this.bindings.get(id);
      if (record !== undefined) {
        this.refresh(record);
      }
    }
  }

  private index(record: BindingRecord): void {
    for (const endpoint of [record.binding.from, record.binding.to]) {
      const key = identityKey(endpoint);
      const ids = this.pluginBindings.get(key) ?? new Set<string>();
      ids.add(record.binding.id);
      this.pluginBindings.set(key, ids);
    }
  }

  private emit(record: BindingRecord): void {
    for (const listener of [...this.listeners]) {
      listener(record.binding, record.state);
    }
  }
}

export function createCompositionCore(
  registry?: PluginRegistry,
  options?: CompositionCoreOptions,
): CompositionCoreImpl {
  return new CompositionCoreImpl(registry, options);
}
