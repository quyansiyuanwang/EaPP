import { EappError } from '@eapp/core';
import type { StatePattern, StateUpdate } from './types.js';

/**
 * Validation — EaPP v3.2.0 §5.3 and §8.
 *
 * Validating patterns by property NAME only lets `{ all: false }` and `{ key: '' }`
 * pass a rule that carries its own error code. Both are rejected here, because a
 * validator that cannot reject is not a validator.
 */

export function validatePattern(pattern: StatePattern): void {
  if (pattern === null || typeof pattern !== 'object') {
    throw new EappError('EAPP_STATE_PATTERN_INVALID', 'pattern MUST be an object');
  }
  const keys = Object.keys(pattern);
  if (keys.length !== 1) {
    throw new EappError('EAPP_STATE_PATTERN_INVALID', 'pattern MUST have exactly one field');
  }

  switch (keys[0]) {
    case 'key': {
      const value = (pattern as { key: unknown }).key;
      if (typeof value !== 'string' || value.length === 0) {
        throw new EappError('EAPP_STATE_PATTERN_INVALID', "'key' MUST be a non-empty string");
      }
      return;
    }
    case 'prefix': {
      const value = (pattern as { prefix: unknown }).prefix;
      if (typeof value !== 'string') {
        throw new EappError('EAPP_STATE_PATTERN_INVALID', "'prefix' MUST be a string");
      }
      return;
    }
    case 'all': {
      if ((pattern as { all: unknown }).all !== true) {
        throw new EappError('EAPP_STATE_PATTERN_INVALID', "'all' MUST be true");
      }
      return;
    }
    default:
      throw new EappError(
        'EAPP_STATE_PATTERN_INVALID',
        `unknown pattern field '${String(keys[0])}'`,
      );
  }
}

export function matchesStatePattern(key: string, pattern: StatePattern): boolean {
  if ('all' in pattern) return true;
  if ('key' in pattern) return key === pattern.key;
  return key.startsWith(pattern.prefix);
}

/**
 * SU-2: presence is decided by the property existing. r2 used `value !== undefined`,
 * which made it impossible to write a legitimate `undefined` value.
 */
export function hasValueProperty(update: StateUpdate): boolean {
  return Object.prototype.hasOwnProperty.call(update, 'value');
}

export interface ValidatedUpdate {
  hasValue: boolean;
  hasDeleted: boolean;
}

export function validateUpdate(update: StateUpdate): ValidatedUpdate {
  if (update === null || typeof update !== 'object') {
    throw new EappError('EAPP_STATE_VALUE_INVALID', 'update MUST be an object');
  }
  if (typeof update.key !== 'string' || update.key.length === 0) {
    throw new EappError('EAPP_STATE_KEY_INVALID', 'key MUST be a non-empty string'); // SU-1 / SC-1
  }
  if (update.expectedRevision === undefined) {
    throw new EappError('EAPP_REVISION_INVALID', 'expectedRevision is required'); // SU-8
  }

  const hasValue = hasValueProperty(update);
  const hasDeleted = update.deleted === true;

  if (update.deleted !== undefined && update.deleted !== true) {
    throw new EappError('EAPP_STATE_VALUE_INVALID', "deleted, when present, MUST be true"); // SU-9
  }
  if (hasValue && hasDeleted) {
    throw new EappError('EAPP_STATE_VALUE_INVALID', 'MUST NOT specify both value and deleted'); // SU-3
  }
  if (!hasValue && !hasDeleted) {
    throw new EappError('EAPP_STATE_VALUE_INVALID', 'MUST specify a value or deleted = true'); // SU-2
  }

  return { hasValue, hasDeleted };
}
