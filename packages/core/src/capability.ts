/**
 * Capability — v3.0.0 §4 (frozen).
 *
 * Invariants: C-1 (name non-empty), C-2 (version is SemVer), C-3 (contract is
 * optional context), C-4 (a capability MAY be exposed by several Plugins),
 * C-5 (`CapabilityRef` includes version), C-6 (version participates in Binding
 * identity — it is part of the ref key).
 */

import { EappError } from './errors.js';
import { assertValidIdentity, identityKey } from './identity.js';
import type { Identity } from './identity.js';

export interface Constraint {
  kind: string;
  value: unknown;
}

export interface ContractRef {
  name: string;
  version: string;
  schema?: unknown;
}

export interface Capability {
  name: string;
  version: string;
  contract?: ContractRef;
  constraints?: Constraint[];
}

export interface CapabilityRef {
  plugin: Identity;
  name: string;
  version: string;
}

function fail(message: string): never {
  throw new EappError('EAPP_CAPABILITY_NOT_FOUND', message);
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${subject} MUST be an object`);
  }
  return value as Record<string, unknown>;
}

function isNumericIdentifier(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment);
}

function isIdentifierList(value: string, rejectLeadingZeros: boolean): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const segment of value.split('.')) {
    if (segment.length === 0 || !/^[0-9A-Za-z-]+$/.test(segment)) {
      return false;
    }
    if (rejectLeadingZeros && segment.length > 1 && segment.startsWith('0') && /^\d+$/.test(segment)) {
      return false;
    }
  }
  return true;
}

/**
 * C-2: `major.minor.patch`, optionally followed by `-prerelease` and/or `+build`.
 * Range matching is deliberately out of scope for the Composition Core.
 */
export function isValidSemVer(version: string): boolean {
  if (typeof version !== 'string' || version.length === 0) {
    return false;
  }
  const buildSeparator = version.indexOf('+');
  if (buildSeparator !== -1 && version.indexOf('+', buildSeparator + 1) !== -1) {
    return false;
  }
  const withoutBuild = buildSeparator === -1 ? version : version.slice(0, buildSeparator);
  if (buildSeparator !== -1) {
    const build = version.slice(buildSeparator + 1);
    if (!isIdentifierList(build, false)) {
      return false;
    }
  }
  const prereleaseSeparator = withoutBuild.indexOf('-');
  const core = prereleaseSeparator === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseSeparator);
  if (prereleaseSeparator !== -1) {
    const prerelease = withoutBuild.slice(prereleaseSeparator + 1);
    if (!isIdentifierList(prerelease, true)) {
      return false;
    }
  }
  const parts = core.split('.');
  if (parts.length !== 3) {
    return false;
  }
  return parts.every((part) => isNumericIdentifier(part));
}

function assertValidContract(value: unknown, subject: string): void {
  const record = asRecord(value, subject);
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail(`${subject}.name MUST NOT be empty`);
  }
  const version = record['version'];
  if (typeof version !== 'string' || !isValidSemVer(version)) {
    fail(`${subject}.version MUST be a valid SemVer`);
  }
}

function assertValidConstraints(value: unknown, subject: string): void {
  if (!Array.isArray(value)) {
    fail(`${subject}.constraints MUST be an array`);
  }
  value.forEach((entry, index) => {
    const record = asRecord(entry, `${subject}.constraints[${index}]`);
    const kind = record['kind'];
    if (typeof kind !== 'string' || kind.trim().length === 0) {
      fail(`${subject}.constraints[${index}].kind MUST NOT be empty`);
    }
    if (!Object.hasOwn(record, 'value')) {
      fail(`${subject}.constraints[${index}].value MUST be present`);
    }
  });
}

/** C-1, C-2 — validates a declared capability (contract is optional, C-3). */
export function assertValidCapability(capability: Capability): void {
  const record = asRecord(capability, 'Capability');
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail('Capability.name MUST NOT be empty (C-1)');
  }
  const version = record['version'];
  if (typeof version !== 'string' || !isValidSemVer(version)) {
    fail(`Capability.version MUST be a valid SemVer, received '${String(version)}' (C-2)`);
  }
  const contract = record['contract'];
  if (contract !== undefined) {
    assertValidContract(contract, 'Capability.contract');
  }
  const constraints = record['constraints'];
  if (constraints !== undefined) {
    assertValidConstraints(constraints, 'Capability');
  }
}

/** C-5 — a `CapabilityRef` MUST carry a version (and a well-formed plugin identity). */
export function assertValidCapabilityRef(ref: CapabilityRef): void {
  const record = asRecord(ref, 'CapabilityRef');
  assertValidIdentity(record['plugin'] as Identity);
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail('CapabilityRef.name MUST NOT be empty (C-1)');
  }
  const version = record['version'];
  if (typeof version !== 'string' || !isValidSemVer(version)) {
    fail('CapabilityRef.version MUST be a valid SemVer (C-5, C-2)');
  }
}

/** C-6: the version is part of the capability key, so it is part of binding identity. */
export function capabilityRefKey(ref: CapabilityRef): string {
  assertValidCapabilityRef(ref);
  return `${identityKey(ref.plugin)}#${ref.name}@${ref.version}`;
}

/** Exact name + version match used by `PluginRegistry.findExposing` (B-2, C-6). */
export function capabilityMatches(
  capability: Capability,
  ref: { name: string; version: string },
): boolean {
  return capability.name === ref.name && capability.version === ref.version;
}
