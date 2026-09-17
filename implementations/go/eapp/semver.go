package eapp

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// SemVer support for C-2 (Capability.version MUST be valid SemVer) and for the
// SemVer *range* allowed by Criteria.version (§8.1).
//
// Only the standard library is available, so the parser and comparator are
// written here. They implement SemVer 2.0.0 §9 (prerelease precedence) and the
// npm-style range grammar for the subset §8.1 needs; anything outside that
// subset is rejected loudly rather than treated as "matches nothing".
//
// Why rejection matters (this is errata E-E in docs/spec/CHANGELOG.md): the
// original implementation matched versions exactly, so `find({version:"^1.0.0"})`
// quietly returned the empty set — indistinguishable from "no plugin matches".
// A range parser that silently fails is worse than one that errors.

// Version is a parsed SemVer 2.0.0 version.
type Version struct {
	Major, Minor, Patch int
	Prerelease          string // without the leading '-', empty when absent
	Build               string // without the leading '+', empty when absent
}

// String renders the version in canonical SemVer form. Build metadata is
// preserved because it is part of the version *string*; it is ignored by
// Compare, as SemVer requires.
func (v Version) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d.%d.%d", v.Major, v.Minor, v.Patch)
	if v.Prerelease != "" {
		b.WriteByte('-')
		b.WriteString(v.Prerelease)
	}
	if v.Build != "" {
		b.WriteByte('+')
		b.WriteString(v.Build)
	}
	return b.String()
}

// IsValidSemVer reports whether s is a valid SemVer 2.0.0 version (C-2).
func IsValidSemVer(s string) bool {
	_, err := ParseVersion(s)
	return err == nil
}

// ParseVersion parses a SemVer 2.0.0 version.
//
// The grammar is strict, deliberately, because C-2 says "valid SemVer" and that
// is a claim other implementations are expected to check:
//
//   - exactly major.minor.patch, each a numeric identifier without leading zeros;
//   - an optional `-prerelease` of dot-separated identifiers;
//   - an optional `+build` of dot-separated identifiers;
//   - nothing else. In particular a leading `v` is NOT accepted: `v1.0.0` is a
//     tag name, not a version, and accepting it would leave two implementations
//     disagreeing about whether the same string is valid.
//
// Build metadata is parsed and preserved but ignored by Compare, which is what
// SemVer requires of it.
func ParseVersion(s string) (Version, error) {
	original := s
	if s == "" {
		return Version{}, fmt.Errorf("empty version")
	}

	// Split off build metadata first: '+' can only appear once, and everything
	// after it is opaque identifiers that must not be compared.
	var build string
	if plus := strings.IndexByte(s, '+'); plus >= 0 {
		build = s[plus+1:]
		s = s[:plus]
		if !validDotIdentifiers(build, false) {
			return Version{}, fmt.Errorf("invalid build metadata %q in %q", build, original)
		}
	}

	// Then the prerelease: everything after the first '-'.
	var prerelease string
	if dash := strings.IndexByte(s, '-'); dash >= 0 {
		prerelease = s[dash+1:]
		s = s[:dash]
		if !validDotIdentifiers(prerelease, true) {
			return Version{}, fmt.Errorf("invalid prerelease %q in %q", prerelease, original)
		}
	}

	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("version %q MUST have exactly major.minor.patch", original)
	}
	numbers := make([]int, 3)
	for i, part := range parts {
		n, err := parseNumericIdentifier(part)
		if err != nil {
			return Version{}, fmt.Errorf("version %q: %w", original, err)
		}
		numbers[i] = n
	}
	return Version{Major: numbers[0], Minor: numbers[1], Patch: numbers[2], Prerelease: prerelease, Build: build}, nil
}

// parseNumericIdentifier parses a numeric version component, rejecting leading
// zeros — SemVer explicitly forbids them so that "01" and "1" cannot disagree
// about ordering.
func parseNumericIdentifier(s string) (int, error) {
	if s == "" {
		return 0, errors.New("empty numeric component")
	}
	if len(s) > 1 && s[0] == '0' {
		return 0, fmt.Errorf("numeric component %q MUST NOT have leading zeros", s)
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("numeric component %q is not a number", s)
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		// Overflow: a version this large is not meaningful, and silently
		// truncating it would break ordering.
		return 0, fmt.Errorf("numeric component %q is out of range", s)
	}
	return n, nil
}

// validDotIdentifiers reports whether s is a dot-separated list of SemVer
// identifiers. When numericOnly is false, alphanumerics and hyphens are allowed
// (build metadata); when true, each part must be non-empty and use only
// [0-9A-Za-z-] (prerelease).
func validDotIdentifiers(s string, requireNonNumeric bool) bool {
	if s == "" {
		return false
	}
	for _, part := range strings.Split(s, ".") {
		if !validIdentifier(part) {
			return false
		}
		if requireNonNumeric && isNumericIdentifier(part) && len(part) > 1 && part[0] == '0' {
			// Numeric prerelease identifiers MUST NOT have leading zeros.
			return false
		}
	}
	return true
}

// validIdentifier reports whether s is a non-empty run of [0-9A-Za-z-].
func validIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'z':
		case c >= 'A' && c <= 'Z':
		case c == '-':
		default:
			return false
		}
	}
	return true
}

// isNumericIdentifier reports whether s consists only of digits.
func isNumericIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// Compare orders two versions per SemVer 2.0.0 §11: -1, 0 or 1.
//
// Build metadata is ignored, which is what the SemVer spec requires and what
// makes version comparison stable across rebuilds. Prerelease identifiers are
// compared numerically when both are numeric, lexically otherwise, and a
// version *with* a prerelease always sorts before the same version without one.
func (v Version) Compare(other Version) int {
	if c := compareInt(v.Major, other.Major); c != 0 {
		return c
	}
	if c := compareInt(v.Minor, other.Minor); c != 0 {
		return c
	}
	if c := compareInt(v.Patch, other.Patch); c != 0 {
		return c
	}
	return comparePrerelease(v.Prerelease, other.Prerelease)
}

func compareInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// comparePrerelease implements SemVer §11.4.
func comparePrerelease(a, b string) int {
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		// No prerelease outranks any prerelease.
		return 1
	case b == "":
		return -1
	}
	aParts := strings.Split(a, ".")
	bParts := strings.Split(b, ".")
	for i := 0; i < len(aParts) && i < len(bParts); i++ {
		aNum, aIsNum := numericIdentifierValue(aParts[i])
		bNum, bIsNum := numericIdentifierValue(bParts[i])
		switch {
		case aIsNum && bIsNum:
			if c := compareInt(aNum, bNum); c != 0 {
				return c
			}
		case aIsNum:
			// Numeric identifiers always have lower precedence.
			return -1
		case bIsNum:
			return 1
		default:
			if c := strings.Compare(aParts[i], bParts[i]); c != 0 {
				return c
			}
		}
	}
	return compareInt(len(aParts), len(bParts))
}

// numericIdentifierValue returns the integer value of a numeric prerelease
// identifier. Overflowing identifiers are treated as non-numeric, which keeps
// the comparison total instead of producing a wrong ordering.
func numericIdentifierValue(s string) (int, bool) {
	if !isNumericIdentifier(s) {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}

// SemverRange is a parsed version range as allowed by Criteria.version (§8.1).
//
// Supported grammar (the npm subset, which is what "SemVer range" conventionally
// means in this ecosystem):
//
//   - any version
//     1.2.3             exactly 1.2.3 (also "=1.2.3")
//     1.2 / 1.2.x / 1   1.2.* — partial versions widen, they do not match nothing
//     ^1.2.3            >=1.2.3 and <2.0.0   (>=0.2.3 <0.3.0 for ^0.2.3)
//     ~1.2.3            >=1.2.3 and <1.3.0
//     >=1.2.3, <2.0.0   comparators; comma or whitespace separated, all must hold
//     1.2.3 - 2.3.4     inclusive hyphen range
//
// Anything else (for example `||`, `!=`, or an empty string) is rejected by
// ParseRange. See the package comment above for why silent non-matching is not
// an option.
type SemverRange struct {
	raw        string
	rawClauses []rangeClause
}

// rangeClause is a conjunction of comparators; a range matches when every
// comparator of every clause holds (clauses are ANDed, as in the accepted
// grammar — `||` is not supported).
type rangeClause struct {
	comparators []comparator
}

type comparator struct {
	op      string // ">", ">=", "<", "<=", "="
	version Version
}

// ParseRange parses a SemVer range.
func ParseRange(text string) (SemverRange, error) {
	if text == "" {
		return SemverRange{}, errors.New("version range MUST NOT be empty")
	}
	trimmed := strings.TrimSpace(text)
	if strings.Contains(trimmed, "||") {
		return SemverRange{}, fmt.Errorf("version range %q uses ||, which is not part of the supported range grammar", text)
	}
	clause, err := parseClause(trimmed)
	if err != nil {
		return SemverRange{}, fmt.Errorf("version range %q: %w", text, err)
	}
	return SemverRange{raw: text, rawClauses: []rangeClause{clause}}, nil
}

// IsValidRange reports whether text is a supported SemVer range. Discovery uses
// it to reject bad input explicitly instead of returning an empty result.
func IsValidRange(text string) bool {
	_, err := ParseRange(text)
	return err == nil
}

// Raw returns the original text, for error messages.
func (r SemverRange) Raw() string { return r.raw }

// String returns the range text.
func (r SemverRange) String() string { return r.raw }

// parseClause turns one comparator set into explicit comparator lists.
func parseClause(text string) (rangeClause, error) {
	if text == "*" || text == "x" || text == "X" || text == "latest" {
		return rangeClause{}, nil // empty conjunction: always true
	}

	// Hyphen range: "1.2.3 - 2.3.4". Handled first because the '-' cannot be
	// confused with a prerelease separator once the clause is trimmed.
	if left, right, ok := splitHyphenRange(text); ok {
		low, err := ParseVersion(left)
		if err != nil {
			return rangeClause{}, err
		}
		high, err := ParseVersion(right)
		if err != nil {
			return rangeClause{}, err
		}
		return rangeClause{comparators: []comparator{
			{op: ">=", version: low},
			{op: "<=", version: high},
		}}, nil
	}

	fields := strings.FieldsFunc(text, func(r rune) bool {
		return r == ' ' || r == ',' || r == '\t'
	})
	if len(fields) == 0 {
		return rangeClause{}, errors.New("version range has no comparators")
	}
	clause := rangeClause{}
	for _, field := range fields {
		comparators, err := parseComparator(field)
		if err != nil {
			return rangeClause{}, err
		}
		clause.comparators = append(clause.comparators, comparators...)
	}
	return clause, nil
}

// splitHyphenRange splits "A - B" into its two operands. The separator must be
// whitespace-delimited so that "1.2.3-alpha" is not mistaken for a range.
func splitHyphenRange(text string) (string, string, bool) {
	index := strings.Index(text, " - ")
	if index < 0 {
		return "", "", false
	}
	left := strings.TrimSpace(text[:index])
	right := strings.TrimSpace(text[index+3:])
	if left == "" || right == "" {
		return "", "", false
	}
	// Only accept the hyphen form when both sides are parseable versions;
	// otherwise fall through so the caller reports a precise comparator error.
	if _, err := ParseVersion(left); err != nil {
		return "", "", false
	}
	if _, err := ParseVersion(right); err != nil {
		return "", "", false
	}
	return left, right, true
}

// parseComparator expands one comparator token into one or two comparators.
func parseComparator(token string) ([]comparator, error) {
	switch {
	case token == "":
		return nil, errors.New("empty comparator")
	case token == "*" || token == "x" || token == "X":
		return nil, nil // always true
	}

	op := ""
	rest := token
	for _, candidate := range []string{">=", "<=", ">", "<", "=", "^", "~"} {
		if strings.HasPrefix(token, candidate) {
			op = candidate
			rest = strings.TrimPrefix(token, candidate)
			break
		}
	}
	if op == "=" {
		op = "" // exact
	}
	if rest == "" {
		return nil, fmt.Errorf("comparator %q has no version", token)
	}

	// Partial versions ("1", "1.2", "1.2.x") are widened before parsing.
	version, wildcardAt, err := parsePartialVersion(rest)
	if err != nil {
		return nil, err
	}

	if wildcardAt >= 0 {
		// A partial version is a range, never an exact match. It composes only
		// with an exact/^/~ operator; ">=1.x" is nonsense and is rejected.
		switch op {
		case "", "^", "~":
			return wildcardComparators(version, wildcardAt), nil
		default:
			return nil, fmt.Errorf("comparator %q combines %q with a wildcard version", token, op)
		}
	}

	switch op {
	case ">=", ">", "<", "<=":
		return []comparator{{op: op, version: version}}, nil
	case "":
		return []comparator{{op: "=", version: version}}, nil
	case "^":
		return caretComparators(version), nil
	case "~":
		return tildeComparators(version), nil
	default:
		return nil, fmt.Errorf("unsupported comparator operator %q", op)
	}
}

// parsePartialVersion parses "1", "1.2", "1.2.x", "1.x", "x", "1.2.3".
// It returns the missing components as zero and the index of the first
// wildcard/missing component (-1 for a complete version).
func parsePartialVersion(text string) (Version, int, error) {
	normalised := text
	// Prerelease/build on a partial version ("1.2-alpha") is not in the
	// supported grammar; ParseVersion would reject it anyway, but the offset
	// bookkeeping below needs the complete form, so reject explicitly.
	if strings.ContainsAny(normalised, "-+") {
		if _, err := ParseVersion(text); err != nil {
			return Version{}, -1, err
		}
		parsed, _ := ParseVersion(text)
		return parsed, -1, nil
	}

	parts := strings.Split(normalised, ".")
	if len(parts) > 3 {
		return Version{}, -1, fmt.Errorf("version %q has too many components", text)
	}
	wildcardAt := -1
	numbers := [3]int{}
	for i, part := range parts {
		if part == "x" || part == "X" || part == "*" {
			wildcardAt = i
			break
		}
		n, err := parseNumericIdentifier(part)
		if err != nil {
			return Version{}, -1, fmt.Errorf("version %q: %w", text, err)
		}
		numbers[i] = n
	}
	if wildcardAt < 0 && len(parts) < 3 {
		// "1.2" means "1.2.*": record the first missing component.
		wildcardAt = len(parts)
	}
	return Version{Major: numbers[0], Minor: numbers[1], Patch: numbers[2]}, wildcardAt, nil
}

// wildcardComparators expands "1.2.x"/"1.2"/"1"/"x" into a bounded interval.
func wildcardComparators(version Version, wildcardAt int) []comparator {
	switch wildcardAt {
	case 0: // "x" or "*": everything
		return nil
	case 1: // "1" or "1.x": 1.0.0 <= v < 2.0.0
		return []comparator{
			{op: ">=", version: Version{Major: version.Major}},
			{op: "<", version: Version{Major: version.Major + 1}},
		}
	default: // "1.2" or "1.2.x": 1.2.0 <= v < 1.3.0
		return []comparator{
			{op: ">=", version: Version{Major: version.Major, Minor: version.Minor}},
			{op: "<", version: Version{Major: version.Major, Minor: version.Minor + 1}},
		}
	}
}

// caretComparators implements ^x.y.z: allow changes that do not modify the
// left-most non-zero component.
//
// The ^0.y.z cases are the ones implementations get wrong: ^0.2.3 means
// >=0.2.3 <0.3.0, not <1.0.0, because for 0.x releases the minor component is
// the compatibility boundary.
func caretComparators(version Version) []comparator {
	low := []comparator{{op: ">=", version: version}}
	switch {
	case version.Major > 0:
		return append(low, comparator{op: "<", version: Version{Major: version.Major + 1}})
	case version.Minor > 0:
		return append(low, comparator{op: "<", version: Version{Minor: version.Minor + 1}})
	default:
		return append(low, comparator{op: "<", version: Version{Patch: version.Patch + 1}})
	}
}

// tildeComparators implements ~x.y.z: allow patch-level changes.
func tildeComparators(version Version) []comparator {
	low := []comparator{{op: ">=", version: version}}
	if version.Major == 0 && version.Minor == 0 {
		// ~0.0.z is only ever 0.0.z itself under a widening rule; the next
		// minor would be 0.1.0, which is what "patch-level change" means here.
		return append(low, comparator{op: "<", version: Version{Minor: 1}})
	}
	return append(low, comparator{op: "<", version: Version{Major: version.Major, Minor: version.Minor + 1}})
}

// Match reports whether version satisfies the range.
func (r SemverRange) Match(version Version) bool {
	for _, clause := range r.rawClauses {
		matched := true
		for _, c := range clause.comparators {
			if !c.match(version) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	// No clauses means "any version" (see the "*" case).
	return len(r.rawClauses) == 0
}

// MatchString parses and matches in one step; a malformed version is an error
// rather than a false.
func (r SemverRange) MatchString(text string) (bool, error) {
	version, err := ParseVersion(text)
	if err != nil {
		return false, err
	}
	return r.Match(version), nil
}

func (c comparator) match(version Version) bool {
	cmp := version.Compare(c.version)
	switch c.op {
	case ">":
		return cmp > 0
	case ">=":
		return cmp >= 0
	case "<":
		return cmp < 0
	case "<=":
		return cmp <= 0
	case "=":
		// Build metadata is ignored by Compare, so "=1.2.3+build" matches
		// "1.2.3": two version strings that SemVer says have equal precedence.
		return cmp == 0
	default:
		return false
	}
}
