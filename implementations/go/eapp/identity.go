package eapp

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Identity is the three-layer plugin identity of §3.1:
//
//	domain    naming domain, e.g. "com.example"
//	id        logical identity, e.g. "logger"
//	instance  runtime instance, e.g. "logger-7f92"
//
// ID-6 freezes the field set: an Identity MUST NOT carry version semantics, and
// version is expressed by Capability.version (§3.2). There is deliberately no
// Version, no Name, and no Metadata field here — not even for convenience.
//
// The struct is comparable, so it can be used as a map key and compared with
// ==. That property matters below: it makes ID-3 uniqueness a map operation
// rather than a loop over string fields.
type Identity struct {
	Domain   string `json:"domain"`
	ID       string `json:"id"`
	Instance string `json:"instance"`
}

// IdentityKeys lists the three — and only three — JSON keys an Identity may
// carry. It is exported because the driver and tests assert ID-6 against it.
var IdentityKeys = []string{"domain", "id", "instance"}

// UnmarshalJSON decodes an Identity and *rejects* any member outside the frozen
// three.
//
// Rejection, rather than stripping, is the ID-6 rule: silently dropping
// `{"domain":…,"id":…,"instance":…,"version":"1.2.3"}` would let a caller believe
// version participates in identity when it demonstrably does not — a correctness
// bug that surfaces much later, as two plugins that should have been distinct
// collapse onto one Identity.
//
// Note what is NOT rejected here: a *missing* member. Incompleteness is not a
// shape violation, it is a request:
//
//   - `instance` absent means "runtime, mint one" (ID-3, ID-5, and
//     conformance/driver.md: "`Identity` 的 `instance` 省略时由实现铸造"). A decoder
//     that demanded it would make the implementation a recorder rather than an
//     issuer, and would make ID-5 unobservable from outside.
//   - `domain` or `id` absent means the caller left a required field empty.
//     `CreateIdentity` reports that as EAPP_IDENTITY_INVALID (ID-1, ID-2) with
//     the right reason. Rejecting it here instead would report *some* error for
//     the right code but the wrong cause, which is how a check ends up passing
//     for a reason that has nothing to do with the rule.
//
// encoding/json's DisallowUnknownFields cannot be used from inside a custom
// unmarshaler, so the keys are checked explicitly. That also lets the error name
// the offending key.
func (id *Identity) UnmarshalJSON(data []byte) error {
	// Decode into a map first: this is the only way to see *unknown* keys,
	// because decoding into the struct would drop them without a trace.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return errIdentityInvalid("identity must be a JSON object: %v", err)
	}
	for key := range raw {
		if !isIdentityKey(key) {
			return errIdentityInvalid(
				"identity MUST contain only {domain, id, instance}; unknown member %q is not allowed (ID-6)", key)
		}
	}
	// Decode whatever is present. A member that is not a string is a shape
	// violation (the three members are strings in §3.1) and is rejected here
	// with the same promptness as an unknown member.
	for key, value := range raw {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return errIdentityInvalid("identity member %q must be a string", key)
		}
		switch key {
		case "domain":
			id.Domain = text
		case "id":
			id.ID = text
		case "instance":
			id.Instance = text
		}
	}
	return nil
}

// isIdentityKey reports whether key is one of the three frozen Identity members.
func isIdentityKey(key string) bool {
	switch key {
	case "domain", "id", "instance":
		return true
	default:
		return false
	}
}

// Validate enforces ID-1, ID-2 and ID-3 (the non-empty part of ID-3; uniqueness
// is a registry concern, see Core.Register).
//
// It returns an *Error with EAPP_IDENTITY_INVALID so callers can use
// errors.As/CodeOf uniformly.
func (id Identity) Validate() error {
	// Empty is tested after trimming only for the *diagnostic*; a whitespace
	// -only domain is still accepted as "non-empty" because §3.1 defines
	// domain as an opaque string and the spec says nothing about trimming.
	// Rejecting it would be inventing a rule the frozen text does not state.
	if id.Domain == "" {
		return errIdentityInvalid("identity.domain MUST NOT be empty (ID-1)")
	}
	if id.ID == "" {
		return errIdentityInvalid("identity.id MUST NOT be empty (ID-2)")
	}
	if id.Instance == "" {
		return errIdentityInvalid("identity.instance MUST NOT be empty (ID-3)")
	}
	return nil
}

// String renders the identity for logs and error messages. The 4-part form
// (domain/id@instance) exists only for humans: never parse it back, and never
// use it as a uniqueness key — identityKey is the encoding for that.
func (id Identity) String() string {
	return fmt.Sprintf("%s/%s@%s", id.Domain, id.ID, id.Instance)
}

// identityKey returns an injective string encoding of the identity.
//
// Uniqueness (ID-3) is enforced with a map keyed by this value, so the encoding
// MUST be injective: a naive join on ":" would map ("a", "b:c", "d") and
// ("a", "b", "c:d") to the same key and silently merge two distinct plugins.
// Length-prefixing every component removes that ambiguity without relying on a
// separator that cannot appear in input.
func identityKey(id Identity) string {
	var b strings.Builder
	appendComponent(&b, id.Domain)
	appendComponent(&b, id.ID)
	appendComponent(&b, id.Instance)
	return b.String()
}

// appendComponent writes one length-prefixed component into b.
func appendComponent(b *strings.Builder, s string) {
	b.WriteString(strconv.Itoa(len(s)))
	b.WriteByte(':')
	b.WriteString(s)
	b.WriteByte('|')
}

// Equal reports field-by-field equality.
//
// It is method sugar over == that documents intent at call sites (and reads
// better in tests); Identity is comparable precisely so this is cheap.
func (id Identity) Equal(other Identity) bool {
	return id.Domain == other.Domain && id.ID == other.ID && id.Instance == other.Instance
}

// IsZero reports whether every field is empty.
//
// The wire form of a capability reference has no `plugin` member (§4.4 versus
// conformance/driver.md), so a zero Plugin means "the caller left the redundant
// field out" — that is the state Bind treats as "fill it in from `from`",
// as opposed to a *contradictory* value, which §6.7 makes EAPP_BINDING_INVALID.
func (id Identity) IsZero() bool {
	return id.Domain == "" && id.ID == "" && id.Instance == ""
}

// sameInstanceScope reports whether two identities share the (domain, id)
// coordinate, i.e. the address space in which `instance` must be unique (ID-3).
func (id Identity) sameInstanceScope(other Identity) bool {
	return id.Domain == other.Domain && id.ID == other.ID
}
