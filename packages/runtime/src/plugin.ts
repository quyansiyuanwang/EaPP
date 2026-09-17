import { EappError, type Capability, type PluginRef } from '@eapp/core';

/**
 * The kernel side of EaPP — what the runtime needs from a plugin, and what a plugin
 * needs from the runtime.
 *
 * v3.0 §5.2 is explicit that a Plugin "MUST NOT be required to have the same
 * implementation shape": it may be an in-process module, a process, a worker, a remote
 * service, a device. So the runtime never assumes anything beyond this contract — the
 * in-process loader here is one possible realisation of it, not the definition.
 */

export interface PluginManifest {
  identity: PluginRef;
  capabilities: Capability[];
}

/** What a handler may reach for while serving a request. */
export interface InvocationContext {
  /** Identity of the plugin that issued the request. */
  readonly caller: PluginRef;
  /** Identity of the plugin serving it. */
  readonly callee: PluginRef;
  /** Capability being invoked. */
  readonly capability: string;
  readonly correlationId: string;
}

export type RequestHandler = (payload: unknown, context: InvocationContext) => Promise<unknown>;

export interface PluginModule {
  readonly manifest: PluginManifest;
  /** Called by the runtime when the plugin enters ACTIVE. */
  activate?(): Promise<void> | void;
  /** Called when it leaves ACTIVE. MUST be idempotent. */
  deactivate?(): Promise<void> | void;
  suspend?(): Promise<void> | void;
  resume?(): Promise<void> | void;
  /** Request handlers keyed by capability name (request mode). */
  readonly handlers?: Readonly<Record<string, RequestHandler>>;
  /** Event/stream consumers, keyed by capability name. */
  readonly onEvent?: Readonly<Record<string, (payload: unknown) => void | Promise<void>>>;
}

export interface PluginDescriptor {
  readonly manifest: PluginManifest;
  lifecycle: 'INACTIVE' | 'ACTIVE' | 'SUSPENDED';
  readonly module: PluginModule;
}

export function assertManifest(manifest: PluginManifest): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new EappError('EAPP_PLUGIN_NOT_FOUND', 'manifest MUST be an object');
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new EappError('EAPP_CAPABILITY_NOT_FOUND', 'manifest.capabilities MUST be an array');
  }
}
