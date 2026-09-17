/**
 * Error codes owned by State Mode (EaPP v3.2.0 §13).
 *
 * Codes already declared by v3.0 / v3.1 are deliberately NOT repeated here —
 * `EAPP_MODE_INVALID`, `EAPP_DELIVERY_UNSUPPORTED`, `EAPP_UNSUPPORTED`,
 * `EAPP_CURSOR_TOO_OLD` and `EAPP_INTERNAL` are reused from the lower layers.
 */

export type EappStateErrorCode =
  | 'EAPP_STATE_UNSUPPORTED'
  | 'EAPP_WATCH_UNSUPPORTED'
  | 'EAPP_STATE_KEY_INVALID'
  | 'EAPP_STATE_KEY_NOT_FOUND'
  | 'EAPP_STATE_VALUE_INVALID'
  | 'EAPP_STATE_PATTERN_INVALID'
  | 'EAPP_STATE_ACTOR_REQUIRED'
  | 'EAPP_REVISION_INVALID'
  | 'EAPP_REVISION_CONFLICT'
  | 'EAPP_SNAPSHOT_INVALID';
