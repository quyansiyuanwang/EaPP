package eapp

import (
	"bytes"
	"encoding/json"
)

// Capability is what a plugin can participate in composing, §4.1:
//
//	{name, version, contract?, constraints?}
//
// §4.2 is equally important as the shape: a Capability is *not* a method list,
// an RPC endpoint, an HTTP route, or a function signature. Nothing here
// describes *how* the capability is used — that belongs to the Interaction
// layer, which the Composition Core must not pre-empt (§1.3, §10).
type Capability struct {
	// Name MUST NOT be empty (C-1).
	Name string `json:"name"`
	// Version MUST be a valid SemVer string (C-2).
	Version string `json:"version"`
	// Contract is optional context, never required (C-3, §14 answer 3).
	Contract *ContractRef `json:"contract,omitempty"`
	// Constraints are opaque {kind, value} pairs; Core matching is exact (C-7).
	Constraints []Constraint `json:"constraints,omitempty"`
}

// ContractRef is optional capability context (§4.1).
//
// The Core never validates or interprets Schema: §20.1 lists "Schema / Contract
// validation" as an explicit non-goal. It is carried verbatim as raw JSON so
// that an upper layer can use it without this package inventing an opinion.
type ContractRef struct {
	Name    string          `json:"name"`
	Version string          `json:"version"`
	Schema  json.RawMessage `json:"schema,omitempty"`
}

// Constraint is a {kind, value} pair (§4.1).
//
// Value is json.RawMessage because Core only ever asks whether two constraints
// are *structurally equal* (C-7); giving it a typed shape would imply semantics
// the frozen spec does not grant it.
type Constraint struct {
	Kind  string          `json:"kind"`
	Value json.RawMessage `json:"value"`
}

// CapabilityRef is a capability reference that MUST include its version (§4.4,
// C-5). Version participating in the reference is what lets one plugin expose
// `logging@1.0.0` and `logging@2.0.0` at the same time, and it is what makes
// capability version part of Binding identity (C-6).
type CapabilityRef struct {
	// Plugin is the exposing plugin. For a Binding, B-7 requires this to equal
	// Binding.From. The JSON form has no "plugin" member in
	// conformance/driver.md (the Binding carries `from`), so the field is
	// excluded from encoding and filled in by Bind.
	Plugin Identity `json:"-"`
	// Name identifies the capability within the plugin.
	Name string `json:"name"`
	// Version is the required SemVer version (C-5).
	Version string `json:"version"`
}

// equal reports whether two capability references denote the same capability of
// the same plugin. Version is compared as a string: C-5/C-6 make the version a
// component of the reference, and two differingle strings are two references,
// even when SemVer precedence would call them equal.
func (r CapabilityRef) equal(other CapabilityRef) bool {
	return r.Plugin.Equal(other.Plugin) && r.Name == other.Name && r.Version == other.Version
}

// Matches reports whether the reference designates c of plugin.
func (r CapabilityRef) Matches(plugin Identity, c Capability) bool {
	return r.Plugin.Equal(plugin) && r.Name == c.Name && r.Version == c.Version
}

// Valid reports whether the capability satisfies C-1 and C-2.
func (c Capability) Valid() error {
	if c.Name == "" {
		return errCapabilityNotFound("capability.name MUST NOT be empty (C-1)")
	}
	if _, err := ParseVersion(c.Version); err != nil {
		return errCapabilityNotFound("capability %q: version %q MUST be valid SemVer (C-2): %v", c.Name, c.Version, err)
	}
	return nil
}

// ConstraintMatches implements C-7 — the *narrowest* possible reading of
// "matching":
//
//	kind  equal (string equality)
//	value structurally equal (objects by key, recursively; arrays in order;
//	                          otherwise Object.is)
//
// The spec chose exact matching deliberately (errata E-I) because it is
// decidable and unambiguous; anything cleverer (ranges, partial orders,
// predicates) needs a negotiation mechanism and therefore belongs to an
// Extension, not to Core.
func ConstraintMatches(required Constraint, offered Constraint) bool {
	if required.Kind != offered.Kind {
		return false
	}
	return structuralEqual(required.Value, offered.Value)
}

// constraintSetMatches reports whether every required constraint is satisfied
// by some offered constraint.
//
// Consensus was needed here and this is the judgement call: §8.1 lets a caller
// filter with a *set* of constraints but never says whether the set is
// conjunctive (all must match) or disjunctive. Conjunction is chosen because
// constraints read as requirements ("this plugin must be usable in-process AND
// without locking"), and because the alternative silently widens every filter —
// the failure mode E-E was about.
func constraintSetMatches(required, offered []Constraint) bool {
	for _, want := range required {
		found := false
		for _, have := range offered {
			if ConstraintMatches(want, have) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// structuralEqual compares two JSON values structurally.
//
// Values arrive as json.RawMessage, so they are first normalised through
// encoding/json. Normalising makes the comparison meaningful rather than
// byte-oriented: `{"a":1,"b":2}` and `{"b":2,"a":1}` denote the same structure
// and MUST match, and `1` vs `1.0` resolves to whichever way Go's decoder
// represents numbers (float64, so 1 and 1.0 are equal — the intended reading of
// "structurally equal"). Byte comparison would fail both, and would also make
// matching depend on key order in the caller's JSON, which is not semantics.
func structuralEqual(a, b json.RawMessage) bool {
	return anyEqual(normaliseJSON(a), normaliseJSON(b))
}

// normaliseJSON decodes raw JSON into a comparable Go value.
//
// Decoding failures degrade to the raw bytes wrapped in a marker type, so two
// unparseable-but-identical values still compare equal and two different ones
// do not. That keeps matching total: it never panics and never treats malformed
// input as a wildcard.
func normaliseJSON(raw json.RawMessage) any {
	if len(bytes.TrimSpace(raw)) == 0 {
		// Absent value. Distinct from JSON null, which decodes to nil: this
		// case only arises for a zero-valued Constraint built in Go.
		return absentValue{}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	// UseNumber preserves the literal digits, so "1" and "1.0" stay distinct
	// only if we ask for it — see anyEqual for how numbers are compared.
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return rawBytes(raw)
	}
	return value
}

// absentValue marks a Constraint.Value that was never set.
type absentValue struct{}

// rawBytes marks JSON that could not be decoded, preserving it for comparison.
type rawBytes []byte

// anyEqual implements recursive structural equality over decoded JSON.
func anyEqual(a, b any) bool {
	switch left := a.(type) {
	case nil:
		return b == nil
	case bool:
		right, ok := b.(bool)
		return ok && left == right
	case string:
		right, ok := b.(string)
		return ok && left == right
	case json.Number:
		right, ok := b.(json.Number)
		if !ok {
			return false
		}
		return numbersEqual(left, right)
	case absentValue:
		_, ok := b.(absentValue)
		return ok
	case rawBytes:
		right, ok := b.(rawBytes)
		return ok && bytes.Equal(left, right)
	case []any:
		right, ok := b.([]any)
		if !ok || len(left) != len(right) {
			return false
		}
		for i := range left {
			// Arrays compare in order: order is part of the structure.
			if !anyEqual(left[i], right[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		right, ok := b.(map[string]any)
		if !ok || len(left) != len(right) {
			return false
		}
		for key, leftValue := range left {
			rightValue, present := right[key]
			if !present || !anyEqual(leftValue, rightValue) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// numbersEqual compares two JSON numbers by numeric value, so 1 and 1.0 are
// equal (they are the same JSON number, written differently) while 1 and 2 are
// not. Non-numeric literals fall back to string comparison.
func numbersEqual(a, b json.Number) bool {
	if a.String() == b.String() {
		return true
	}
	aFloat, aErr := a.Float64()
	bFloat, bErr := b.Float64()
	if aErr != nil || bErr != nil {
		return false
	}
	return aFloat == bFloat
}
