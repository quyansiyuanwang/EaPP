/**
 * EaPP shared error model.
 *
 * `EappError` is the single runtime error class of the whole EaPP stack
 * (v3.0.0 §16 / v3.1.0 §12 / v3.2.0 §13). Each layer contributes its own code
 * union on top of it; the class itself accepts any `string` code so codes
 * raised by other layers flow through the same class unchanged.
 */

/** Error codes defined by the frozen Composition Core (v3.0.0 §16). */
export type EappCoreErrorCode =
  | 'EAPP_IDENTITY_INVALID'
  | 'EAPP_IDENTITY_DUPLICATE'
  | 'EAPP_CAPABILITY_NOT_FOUND'
  | 'EAPP_CAPABILITY_NOT_EXPOSED'
  | 'EAPP_PLUGIN_NOT_FOUND'
  | 'EAPP_PLUGIN_INACTIVE'
  | 'EAPP_BINDING_INVALID'
  | 'EAPP_BINDING_DUPLICATE'
  | 'EAPP_BINDING_CLOSED'
  | 'EAPP_LIFECYCLE_INVALID'
  | 'EAPP_DISCOVERY_SCOPE_INVALID'
  | 'EAPP_UNSUPPORTED'
  | 'EAPP_INTERNAL';

/** Structural shape of an EaPP error (v3.0.0 §16). */
export interface EappErrorShape {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

/**
 * Codes the stack considers retryable by default (v3.2.0-r3 §13 / D-33).
 * `EAPP_REVISION_CONFLICT` is a CAS conflict: re-reading and retrying may succeed.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set<string>(['EAPP_REVISION_CONFLICT']);

/**
 * The one runtime error class shared by Composition Core, Interaction and State.
 *
 * `code` is deliberately typed `string` (not the core union) so that codes owned
 * by the other layers are carried by the very same class.
 */
export class EappError extends Error implements EappErrorShape {
  readonly code: string;
  declare readonly details?: unknown;
  readonly retryable: boolean;

  constructor(
    code: string,
    message?: string,
    options?: { details?: unknown; retryable?: boolean },
  ) {
    // `message` is optional on purpose: reference implementations call
    // `new EappError('SOME_CODE')` with a single argument and MUST still get a
    // usable message.
    //
    // The code is always present in the rendered message. That is not cosmetic:
    // the conformance style used throughout the specs is
    // `await expect(...).rejects.toThrow('EAPP_REVISION_CONFLICT')`, and a matcher
    // string is tested against `error.message`. Keeping the code out of the message
    // would make every spec-shaped assertion fail even when the right error was raised.
    super(message !== undefined && message.length > 0 ? `${code}: ${message}` : code);
    // Repair the prototype chain so `instanceof` works after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'EappError';
    this.code = code;
    if (options !== undefined && options.details !== undefined) {
      this.details = options.details;
    }
    this.retryable = options?.retryable ?? RETRYABLE_CODES.has(code);
  }
}

/** Narrowing helper that also recognises structurally identical foreign instances. */
export function isEappError(value: unknown): value is EappError {
  if (value instanceof EappError) {
    return true;
  }
  if (!(value instanceof Error)) {
    return false;
  }
  return value.name === 'EappError' && typeof (value as { code?: unknown }).code === 'string';
}
