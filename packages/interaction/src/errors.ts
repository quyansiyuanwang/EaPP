/**
 * Error codes owned by the Interaction Layer (EaPP v3.1.0 §12).
 *
 * The runtime class is defined once, in `@eapp/core`. Each layer contributes only
 * its own code union; the global registry is `EappCoreErrorCode | EappInteractionErrorCode
 * | EappStateErrorCode`. Codes are additive and MUST NOT be renamed or redefined.
 */

export type EappInteractionErrorCode =
  | 'EAPP_CHANNEL_INVALID'
  | 'EAPP_CHANNEL_CLOSED'
  | 'EAPP_CHANNEL_DRAINING'
  | 'EAPP_MODE_INVALID'
  | 'EAPP_DELIVERY_UNSUPPORTED'
  | 'EAPP_CURSOR_INVALID'
  | 'EAPP_CURSOR_UNSUPPORTED'
  | 'EAPP_CURSOR_TOO_OLD'
  | 'EAPP_SUBSCRIPTION_INVALID'
  | 'EAPP_LEASE_EXPIRED'
  | 'EAPP_LEASE_CLOSED'
  | 'EAPP_LEASE_CONFLICT'
  | 'EAPP_TIMEOUT'
  | 'EAPP_UNSUPPORTED'
  | 'EAPP_INTERNAL';
