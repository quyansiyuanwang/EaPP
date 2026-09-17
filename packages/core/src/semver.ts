/**
 * SemVer ranges — v3.0.0 §8.1 declares `Criteria.version` a "SemVer range".
 *
 * The supported grammar is listed below and is deliberately small. Anything outside it is
 * rejected by `isValidRange` rather than quietly matching nothing: a discovery query that
 * returns the empty set because its range syntax was unsupported looks identical to "no
 * plugin matches", which is exactly the sort of silent wrong answer a protocol layer must
 * not produce.
 *
 * Supported:
 *
 *   *  /  (empty)          any version
 *   1.2.3                  exact
 *   >1.2.3  >=  <  <=  =   comparators
 *   ^1.2.3                 compatible: same left-most non-zero component
 *   ~1.2.3                 patch-level: >=1.2.3 <1.3.0
 *   A B                    conjunction (space)
 *   A || B                 disjunction
 *
 * NOT supported, and rejected: partial versions (`1.2`, `1`), hyphen ranges (`1.2 - 2.0`),
 * `x`-wildcards (`1.x`), and `>=1.2.3 <2.0.0 || >=3.0.0`-style nesting is fine but
 * prerelease-ordering beyond "prerelease sorts below its release" is not modelled.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  // A prerelease sorts below the release that shares its core version.
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

type Operator = '=' | '>' | '>=' | '<' | '<=' | '^' | '~';

interface Comparator {
  operator: Operator;
  version: ParsedVersion;
}

function parseComparator(token: string): Comparator | null {
  const match = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(token.trim());
  if (!match) return null;
  const version = parseVersion(match[2] ?? '');
  if (!version) return null;
  return { operator: (match[1] ?? '=') as Operator, version };
}

function comparatorSatisfied(candidate: ParsedVersion, comparator: Comparator): boolean {
  const { operator, version } = comparator;

  switch (operator) {
    case '=':
      return compareVersions(candidate, version) === 0;
    case '>':
      return compareVersions(candidate, version) > 0;
    case '>=':
      return compareVersions(candidate, version) >= 0;
    case '<':
      return compareVersions(candidate, version) < 0;
    case '<=':
      return compareVersions(candidate, version) <= 0;
    case '^': {
      // Caret compatibility: allow changes that do not modify the left-most non-zero
      // component. ^1.2.3 -> <2.0.0, ^0.2.3 -> <0.3.0, ^0.0.3 -> <0.0.4.
      const upper: ParsedVersion =
        version.major > 0
          ? { major: version.major + 1, minor: 0, patch: 0, prerelease: '' }
          : version.minor > 0
            ? { major: 0, minor: version.minor + 1, patch: 0, prerelease: '' }
            : { major: 0, minor: 0, patch: version.patch + 1, prerelease: '' };
      return compareVersions(candidate, version) >= 0 && compareVersions(candidate, upper) < 0;
    }
    case '~': {
      // Tilde: allow patch-level changes. ~1.2.3 -> >=1.2.3 <1.3.0.
      const upper: ParsedVersion = {
        major: version.major,
        minor: version.minor + 1,
        patch: 0,
        prerelease: '',
      };
      return compareVersions(candidate, version) >= 0 && compareVersions(candidate, upper) < 0;
    }
    default:
      return false;
  }
}

/** True when the range is expressed in the supported grammar. */
export function isValidRange(range: string): boolean {
  const text = range.trim();
  if (text === '' || text === '*') return true;
  return text
    .split('||')
    .every((alternative) =>
      alternative
        .trim()
        .split(/\s+/)
        .every((token) => parseComparator(token) !== null),
    );
}

/**
 * `satisfiesRange('1.5.0', '^1.2.3') === true`.
 * An unparsable version or range yields `false`; callers that need to distinguish
 * "no match" from "bad input" should check `isValidRange` first.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  if (!candidate) return false;

  const text = range.trim();
  if (text === '' || text === '*') return true;

  return text.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .map(parseComparator)
      .every((comparator) => comparator !== null && comparatorSatisfied(candidate, comparator)),
  );
}
