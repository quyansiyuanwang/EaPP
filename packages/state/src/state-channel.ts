import { EappError, type Identity } from '@eapp/core';
import {
  assertDeliveryAllowed,
  type Channel,
  type ChannelState,
  type DeliveryGuarantee,
} from '@eapp/interaction';
import { assertStateCapability, type StateTransport } from './state-transport.js';
import { createStateWatcher, type StateWatcher } from './state-watcher.js';
import type {
  ExpectedRevision,
  RestoreMode,
  Revision,
  StateCell,
  StateChannelConfig,
  StatePattern,
  StateSnapshot,
  StateUpdate,
  WatchOptions,
} from './types.js';
import { validatePattern, validateUpdate } from './validate.js';

/**
 * StateChannel — EaPP v3.2.0 §10.
 *
 * IX-6: this is a NARROWING VIEW of the v3.1 Channel, not a wrapper type. `id`,
 * `binding`, `delivery` and `state` are read straight through to the underlying
 * Channel object, so the channel's lifecycle stays observable from the composition
 * layer instead of being shadowed by a copy.
 */
export interface StateChannel extends Channel {
  readonly mode: 'state';

  get(key: string): Promise<StateCell | null>;
  list(pattern: StatePattern): Promise<StateCell[]>;
  set(update: StateUpdate): Promise<Revision>;
  delete(
    key: string,
    expectedRevision: ExpectedRevision,
    options?: { actor?: Identity },
  ): Promise<Revision>;
  /**
   * Returns a Promise because the initial position MUST be resolved eagerly (§7.4 / SUB-9):
   * resolving `'latest'` requires a read of the channel head, and a synchronous return
   * could only hand back an unresolved cursor — which is exactly the r2 defect that made
   * its own SW-1 assertion impossible to satisfy.
   */
  watch(pattern: StatePattern, options?: WatchOptions): Promise<StateWatcher>;
  snapshot(pattern: StatePattern): Promise<StateSnapshot>;
  restore(snapshot: StateSnapshot, options?: { mode?: RestoreMode }): Promise<void>;
}

export class StateChannelImpl implements StateChannel {
  readonly #channel: Channel;
  readonly #transport: StateTransport;
  readonly #config: StateChannelConfig;

  constructor(channel: Channel, transport: StateTransport, config: StateChannelConfig) {
    this.#channel = channel;
    this.#transport = transport;
    this.#config = config;
  }

  get id(): string {
    return this.#channel.id;
  }
  get binding(): string {
    return this.#channel.binding;
  }
  get mode(): 'state' {
    return 'state';
  }
  get delivery(): DeliveryGuarantee {
    return this.#channel.delivery;
  }
  get state(): ChannelState {
    return this.#channel.state;
  }

  get channel(): Channel {
    return this.#channel;
  }
  get config(): StateChannelConfig {
    return this.#config;
  }

  #actor(explicit: Identity | undefined): Identity {
    const actor = explicit ?? this.#config.owner;
    if (!actor) {
      // SC-5 cannot be satisfied without an identity, so this is a hard failure rather
      // than the fabricated `{domain:'x',id:'x',instance:'x'}` the r2 draft resorted to.
      throw new EappError('EAPP_STATE_ACTOR_REQUIRED', 'no actor supplied and channel has no owner');
    }
    return actor;
  }

  async get(key: string): Promise<StateCell | null> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new EappError('EAPP_STATE_KEY_INVALID', 'key MUST be a non-empty string');
    }
    assertStateCapability(this.#transport, 'state');
    return this.#transport.getState(this.#channel.id, key);
  }

  async list(pattern: StatePattern): Promise<StateCell[]> {
    validatePattern(pattern);
    assertStateCapability(this.#transport, 'state');
    return this.#transport.listState(this.#channel.id, pattern);
  }

  async set(update: StateUpdate): Promise<Revision> {
    assertStateCapability(this.#transport, 'revision');
    validateUpdate(update);
    const actor = this.#actor(update.actor);
    // CAS check and write happen atomically inside the transport (SU-7); this layer
    // MUST NOT attempt to perform the compare itself.
    return this.#transport.setStateWithCAS(this.#channel.id, update, actor);
  }

  async delete(
    key: string,
    expectedRevision: ExpectedRevision,
    options?: { actor?: Identity },
  ): Promise<Revision> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new EappError('EAPP_STATE_KEY_INVALID', 'key MUST be a non-empty string');
    }
    assertStateCapability(this.#transport, 'revision');
    const actor = this.#actor(options?.actor);
    // A first-class transport primitive: routing this through `set({deleted:true})` is
    // what made EAPP_STATE_KEY_NOT_FOUND unreachable in the r2 draft.
    return this.#transport.deleteStateWithCAS(this.#channel.id, key, expectedRevision, actor);
  }

  async watch(pattern: StatePattern, options: WatchOptions = {}): Promise<StateWatcher> {
    validatePattern(pattern);
    return createStateWatcher(this.#channel.id, pattern, this.#transport, options);
  }

  /**
   * §9.2: the head is read BEFORE the cells. Reading them from a single snapshot call and
   * then deriving `maxRevision` from the result — as r2 did — makes the consistency
   * assertion a tautology that no transport can violate.
   */
  async snapshot(pattern: StatePattern): Promise<StateSnapshot> {
    validatePattern(pattern);
    assertStateCapability(this.#transport, 'snapshot');

    const maxRevision = await this.#transport.head(this.#channel.id);
    const all = await this.#transport.listState(this.#channel.id, pattern);
    const cells = all.filter(
      (cell) => this.#transport.compareRevision(cell.revision, maxRevision) <= 0,
    );

    return {
      channel: this.#channel.id,
      pattern,
      cells,
      maxRevision,
      takenAt: Date.now(),
    };
  }

  /**
   * §9.3. Every write allocates a NEW revision, so a restore never rolls the log back
   * (SNAP-4/5) and the relative order of the snapshot's cells is preserved (SNAP-6).
   */
  async restore(snapshot: StateSnapshot, options: { mode?: RestoreMode } = {}): Promise<void> {
    assertStateCapability(this.#transport, 'snapshot');

    if (snapshot.channel !== this.#channel.id) {
      throw new EappError(
        'EAPP_SNAPSHOT_INVALID',
        `snapshot belongs to channel '${snapshot.channel}', not '${this.#channel.id}'`,
      );
    }

    const actor = this.#actor(undefined);
    const mode = options.mode ?? 'merge';

    for (const cell of snapshot.cells) {
      const revision = await this.#transport.nextRevision(this.#channel.id);
      await this.#transport.writeStateWithRevision(
        this.#channel.id,
        cell.key,
        cell.value,
        cell.deleted,
        revision,
        actor,
      );
    }

    if (mode === 'replace') {
      const inSnapshot = new Set(snapshot.cells.map((cell) => cell.key));
      const current = await this.#transport.listState(this.#channel.id, snapshot.pattern);
      for (const cell of current) {
        if (inSnapshot.has(cell.key)) continue;
        if (cell.deleted) continue; // already logically deleted; nothing to overwrite
        const revision = await this.#transport.nextRevision(this.#channel.id);
        await this.#transport.writeStateWithRevision(
          this.#channel.id,
          cell.key,
          undefined,
          true,
          revision,
          actor,
        );
      }
    }
  }
}

/**
 * Step ③ of the channel-creation path (v3.1 §11): turn an already-derived Channel into a
 * StateChannel. Every precondition is checked here rather than discovered later, because
 * a mis-configured state channel would otherwise fail with a confusing transport error.
 */
export function configureStateChannel(
  channel: Channel,
  transport: StateTransport,
  config: StateChannelConfig,
): StateChannel {
  if (channel.mode !== 'state') {
    throw new EappError('EAPP_MODE_INVALID', `channel '${channel.id}' is mode '${channel.mode}'`);
  }
  assertDeliveryAllowed(channel.mode, channel.delivery); // DL-6
  if (channel.delivery !== 'at-least-once') {
    throw new EappError(
      'EAPP_DELIVERY_UNSUPPORTED',
      `state channels require 'at-least-once', got '${channel.delivery}'`,
    );
  }
  assertStateCapability(transport, 'state');
  if (config.conflictPolicy !== 'cas') {
    throw new EappError('EAPP_UNSUPPORTED', 'Core supports only the CAS conflict policy'); // CF-1
  }
  if (!config.owner) {
    throw new EappError('EAPP_STATE_ACTOR_REQUIRED', 'channel owner MUST be supplied'); // SC-5
  }
  return new StateChannelImpl(channel, transport, config);
}
