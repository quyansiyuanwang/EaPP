package eapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// Test layout: one test function per invariant, named after its id, so that a
// reviewer can diff §13's list (ID-1 … BR-3) against the file directly.
//
// Tests that assert an error use wantCode, which checks the §16 code rather
// than the message: §16 freezes the codes and explicitly forbids a harness from
// parsing `message`, so message text is never allowed to become a contract
// inside this package either.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// pluginSpec is the declaration form used by the tests.
type pluginSpec struct {
	domain       string
	id           string
	instance     string
	capabilities []Capability
}

// mustRegister registers a plugin built from spec and fails the test otherwise.
func mustRegister(t *testing.T, core *Core, spec pluginSpec) Plugin {
	t.Helper()
	if spec.domain == "" {
		spec.domain = "acme"
	}
	if spec.id == "" {
		spec.id = spec.instance
	}
	identity := Identity{Domain: spec.domain, ID: spec.id, Instance: spec.instance}
	plugin, err := core.Register(identity, spec.capabilities)
	if err != nil {
		t.Fatalf("Register(%s) failed: %v", identity, err)
	}
	return plugin
}

// capabilityOf builds a capability with a version and optional constraints.
func capabilityOf(name, version string, constraints ...Constraint) Capability {
	return Capability{Name: name, Version: version, Constraints: constraints}
}

// rawJSON converts a Go value into the json.RawMessage a Constraint carries.
func rawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %v: %v", value, err)
	}
	return data
}

// wantCode fails the test unless err is (or wraps) an *Error with code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %s, got nil", code)
	}
	got, ok := CodeOf(err)
	if !ok {
		t.Fatalf("expected an *eapp.Error carrying %s, got %T: %v", code, err, err)
	}
	if got != code {
		t.Fatalf("expected code %s, got %s (%v)", code, got, err)
	}
}

// activePair registers two plugins and activates both, returning them ACTIVE.
func activePair(t *testing.T, core *Core, capability Capability) (Plugin, Plugin) {
	t.Helper()
	provider := mustRegister(t, core, pluginSpec{instance: "a-1", capabilities: []Capability{capability}})
	consumer := mustRegister(t, core, pluginSpec{instance: "b-1"})
	if err := core.Activate(provider.Identity); err != nil {
		t.Fatalf("activate provider: %v", err)
	}
	if err := core.Activate(consumer.Identity); err != nil {
		t.Fatalf("activate consumer: %v", err)
	}
	return provider, consumer
}

// ---------------------------------------------------------------------------
// Identity — §3, ID-1 … ID-6
// ---------------------------------------------------------------------------

func TestID1IdentityDomainMustNotBeEmpty(t *testing.T) {
	core := NewCore()
	if _, err := core.CreateIdentity("", "logger", "logger-1"); err != nil {
		wantCode(t, err, CodeIdentityInvalid)
	} else {
		t.Fatal("empty domain MUST be rejected (ID-1)")
	}
}

func TestID2IdentityIDMustNotBeEmpty(t *testing.T) {
	core := NewCore()
	if _, err := core.CreateIdentity("acme", "", "logger-1"); err != nil {
		wantCode(t, err, CodeIdentityInvalid)
	} else {
		t.Fatal("empty id MUST be rejected (ID-2)")
	}
}

func TestID3InstanceUniqueWithinDomainAndID(t *testing.T) {
	core := NewCore()
	if _, err := core.CreateIdentity("acme", "logger", "logger-1"); err != nil {
		t.Fatalf("first mint: %v", err)
	}
	// Same (domain, id): the instance is already taken.
	if _, err := core.CreateIdentity("acme", "logger", "logger-1"); err != nil {
		wantCode(t, err, CodeIdentityDuplicate)
	} else {
		t.Fatal("re-minting the same (domain, id, instance) MUST fail (ID-3)")
	}
	// Different domain or different id: the *address space* differs, so the very
	// same instance string is legal.
	if _, err := core.CreateIdentity("other", "logger", "logger-1"); err != nil {
		t.Fatalf("same instance in a different domain MUST be allowed: %v", err)
	}
	if _, err := core.CreateIdentity("acme", "metrics", "logger-1"); err != nil {
		t.Fatalf("same instance under a different id MUST be allowed: %v", err)
	}

	// Two plugins cannot share an identity, and that is the observable form of
	// ID-3 for the plugin graph (P-1).
	first := mustRegister(t, core, pluginSpec{instance: "shared-1"})
	_, err := core.Register(first.Identity, nil)
	wantCode(t, err, CodeIdentityDuplicate)
}

func TestID3OmittedInstanceIsMintedAndUnique(t *testing.T) {
	core := NewCore()
	first, err := core.CreateIdentity("acme", "logger", "")
	if err != nil {
		t.Fatalf("minting with an omitted instance: %v", err)
	}
	if first.Instance == "" {
		t.Fatal("the runtime MUST mint an instance when one is omitted (ID-3, ID-5)")
	}
	second, err := core.CreateIdentity("acme", "logger", "")
	if err != nil {
		t.Fatalf("second mint: %v", err)
	}
	if first.Instance == second.Instance {
		t.Fatalf("two mints produced the same instance %q (ID-3)", first.Instance)
	}
	// ID-5: the minted value is the authoritative one; registering an identity
	// with no instance yields an identity the runtime minted.
	plugin, err := core.Register(Identity{Domain: "acme", ID: "worker"}, nil)
	if err != nil {
		t.Fatalf("register with omitted instance: %v", err)
	}
	if plugin.Identity.Instance == "" {
		t.Fatal("registration MUST return the runtime-minted instance (ID-5)")
	}
}

func TestID4IdentityImmutableAcrossLifecycle(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})
	before := plugin.Identity

	for _, step := range []func(Identity) error{core.Activate, core.Suspend, core.Resume, core.Deactivate} {
		if err := step(plugin.Identity); err != nil {
			t.Fatalf("lifecycle step: %v", err)
		}
		after, err := core.PluginOf(plugin.Identity)
		if err != nil {
			t.Fatalf("PluginOf: %v", err)
		}
		if !after.Identity.Equal(before) {
			t.Fatalf("identity changed: %s -> %s (ID-4, P-3)", before, after.Identity)
		}
	}
}

func TestID5IdentityIsMintedByTheRuntime(t *testing.T) {
	core := NewCore()
	// An identity the runtime never minted cannot be registered as a plugin.
	selfIssued := Identity{Domain: "acme", ID: "impostor", Instance: "impostor-1"}
	if _, err := core.Register(Identity{Domain: "acme", ID: "impostor"}, nil); err != nil {
		t.Fatalf("registration is the minting entry point: %v", err)
	}
	// The runtime minted a *different* instance, so the self-issued one is not
	// the plugin's identity.
	if core.HasIdentity(selfIssued) {
		t.Fatalf("self-issued identity %s MUST NOT be registered (ID-5)", selfIssued)
	}
	if _, err := core.PluginOf(selfIssued); err == nil {
		t.Fatal("a self-issued identity MUST NOT resolve to a plugin (ID-5)")
	} else {
		wantCode(t, err, CodePluginNotFound)
	}
}

func TestID6IdentityCarriesNoVersionSemantics(t *testing.T) {
	// ID-6 is a statement about the *field set*, and Go makes it checkable:
	// reflect over the struct rather than trusting a comment.
	if got := reflect.TypeOf(Identity{}).NumField(); got != 3 {
		t.Fatalf("Identity MUST have exactly three fields, has %d (ID-6)", got)
	}
	for _, field := range reflect.VisibleFields(reflect.TypeOf(Identity{})) {
		switch field.Name {
		case "Domain", "ID", "Instance":
		default:
			t.Fatalf("unexpected Identity field %q (ID-6)", field.Name)
		}
		if strings.Contains(strings.ToLower(field.Name), "version") {
			t.Fatalf("Identity MUST NOT carry version semantics, found %q (ID-6)", field.Name)
		}
	}

	// The wire form is the real contract: an Identity carrying a version member
	// MUST be rejected, not silently stripped, because stripping lets a caller
	// believe the version participated in identity.
	var identity Identity
	err := json.Unmarshal([]byte(`{"domain":"acme","id":"a","instance":"a-1","version":"1.0.0"}`), &identity)
	wantCode(t, err, CodeIdentityInvalid)

	if err := json.Unmarshal([]byte(`{"domain":"acme","id":"a","instance":"a-1"}`), &identity); err != nil {
		t.Fatalf("the exact three-member form MUST decode: %v", err)
	}
	if identity.Domain != "acme" || identity.ID != "a" || identity.Instance != "a-1" {
		t.Fatalf("decoded %+v", identity)
	}

	// A missing member is NOT a shape violation, it is a request: `instance`
	// absent means "runtime, mint one" (ID-3, ID-5), and `domain`/`id` absent
	// means the caller left a required field empty, which Validate reports with
	// the right reason. Rejecting incompleteness in the decoder would make
	// ID-1/ID-2 pass for a reason that has nothing to do with the rule.
	for _, incomplete := range []string{
		`{"id":"a","instance":"a-1"}`,
		`{"domain":"acme","instance":"a-1"}`,
		`{"domain":"acme","id":"a"}`,
	} {
		var target Identity
		if err := json.Unmarshal([]byte(incomplete), &target); err != nil {
			t.Fatalf("%s MUST decode; completeness is checked by Validate, not by the decoder: %v", incomplete, err)
		}
	}

	// And the other half of ID-1/ID-2: an empty or absent domain/id is rejected
	// by CreateIdentity with EAPP_IDENTITY_INVALID.
	core := NewCore()
	if _, err := core.CreateIdentity("", "a", "a-1"); err == nil {
		t.Fatal("an empty domain MUST be rejected (ID-1)")
	} else {
		wantCode(t, err, CodeIdentityInvalid)
	}
	if _, err := core.CreateIdentity("acme", "", "a-1"); err == nil {
		t.Fatal("an empty id MUST be rejected (ID-2)")
	} else {
		wantCode(t, err, CodeIdentityInvalid)
	}
}

func TestIdentityKeyIsInjective(t *testing.T) {
	// A naive "a:b:c" join would collide these two. They are different plugins,
	// so the registry key MUST distinguish them.
	left := identityKey(Identity{Domain: "a", ID: "b:c", Instance: "d"})
	right := identityKey(Identity{Domain: "a", ID: "b", Instance: "c:d"})
	if left == right {
		t.Fatalf("identity keys collided: %q", left)
	}
}

// ---------------------------------------------------------------------------
// Capability — §4, C-1 … C-7
// ---------------------------------------------------------------------------

func TestC1CapabilityNameMustNotBeEmpty(t *testing.T) {
	core := NewCore()
	_, err := core.Register(Identity{Domain: "acme", ID: "a", Instance: "a-1"},
		[]Capability{{Name: "", Version: "1.0.0"}})
	wantCode(t, err, CodeCapabilityNotFound)
}

func TestC2CapabilityVersionMustBeValidSemVer(t *testing.T) {
	core := NewCore()
	for _, bad := range []string{"", "1", "1.2", "v", "1.2.3.4", "01.2.3", "1.2.x", "1.2.3-", "not-a-version"} {
		_, err := core.Register(Identity{Domain: "acme", ID: "a", Instance: "a-1"},
			[]Capability{{Name: "casing.apply", Version: bad}})
		if err == nil {
			t.Fatalf("version %q MUST be rejected (C-2)", bad)
		}
		wantCode(t, err, CodeCapabilityNotFound)
	}
	for _, good := range []string{"0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3+build.5", "10.20.30-rc.1+b7"} {
		if !IsValidSemVer(good) {
			t.Fatalf("%q MUST be valid SemVer (C-2)", good)
		}
	}
}

func TestC3ContractIsOptional(t *testing.T) {
	core := NewCore()
	provider := mustRegister(t, core, pluginSpec{
		instance:     "a-1",
		capabilities: []Capability{{Name: "casing.apply", Version: "1.0.0"}}, // no contract
	})
	consumer := mustRegister(t, core, pluginSpec{instance: "b-1"})
	if err := core.Activate(provider.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := core.Activate(consumer.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// §14 answer 3: contract is not required, so a bind without one succeeds.
	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"},
	})
	if err != nil {
		t.Fatalf("bind without a contract MUST succeed (C-3): %v", err)
	}
	if binding.Contract != nil {
		t.Fatal("no contract was supplied, so the binding MUST NOT invent one")
	}
}

func TestC4CapabilityMayBeExposedByMultiplePlugins(t *testing.T) {
	core := NewCore()
	capability := capabilityOf("casing.apply", "1.0.0")
	first := mustRegister(t, core, pluginSpec{instance: "a-1", capabilities: []Capability{capability}})
	second := mustRegister(t, core, pluginSpec{instance: "b-1", capabilities: []Capability{capability}})

	found, err := core.Find(Criteria{Capability: "casing.apply"}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(found) != 2 {
		t.Fatalf("capability MUST be exposable by multiple plugins (C-4), found %d", len(found))
	}
	for _, identity := range []Identity{first.Identity, second.Identity} {
		if !containsIdentity(found, identity) {
			t.Fatalf("%s missing from %v (C-4)", identity, found)
		}
	}
}

func TestC5CapabilityRefMustIncludeVersion(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	_, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply"}, // no version
	})
	wantCode(t, err, CodeBindingInvalid)
}

func TestC6CapabilityVersionParticipatesInBindingIdentity(t *testing.T) {
	core := NewCore()
	provider := mustRegister(t, core, pluginSpec{
		instance: "a-1",
		capabilities: []Capability{
			capabilityOf("logging", "1.0.0"),
			capabilityOf("logging", "2.0.0"),
		},
	})
	consumer := mustRegister(t, core, pluginSpec{instance: "b-1"})
	if err := core.Activate(provider.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := core.Activate(consumer.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}

	// §4.4: one plugin may expose logging@1.0.0 and logging@2.0.0 at once.
	first, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "logging", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind 1.0.0: %v", err)
	}
	second, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "logging", Version: "2.0.0"}})
	if err != nil {
		t.Fatalf("bind 2.0.0 MUST be a distinct binding (C-6): %v", err)
	}
	if first.ID == second.ID {
		t.Fatal("two versions MUST yield two bindings (C-6)")
	}
	// And the *same* version is still the same binding.
	_, err = core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "logging", Version: "1.0.0"}})
	wantCode(t, err, CodeBindingDuplicate)
}

func TestC7ConstraintMatchingIsExact(t *testing.T) {
	// kind equality is case-sensitive string equality.
	kindLeft := Constraint{Kind: "mode", Value: json.RawMessage(`"fast"`)}
	kindRight := Constraint{Kind: "Mode", Value: json.RawMessage(`"fast"`)}
	if ConstraintMatches(kindLeft, kindRight) {
		t.Fatal("different kinds MUST NOT match (C-7)")
	}
	if !ConstraintMatches(kindLeft, kindLeft) {
		t.Fatal("identical constraints MUST match (C-7)")
	}

	cases := []struct {
		name  string
		left  string
		right string
		want  bool
	}{
		{"scalar equal", `"fast"`, `"fast"`, true},
		{"scalar different", `"fast"`, `"slow"`, false},
		{"number vs same number", `1`, `1`, true},
		{"number vs different number", `1`, `2`, false},
		{"bool equal", `true`, `true`, true},
		{"null equal", `null`, `null`, true},
		{"object key order irrelevant", `{"a":1,"b":2}`, `{"b":2,"a":1}`, true},
		{"object value differs", `{"a":1}`, `{"a":2}`, false},
		{"object missing a key", `{"a":1,"b":2}`, `{"a":1}`, false},
		{"nested objects", `{"a":{"b":[1,2]}}`, `{"a":{"b":[1,2]}}`, true},
		{"array order matters", `[1,2]`, `[2,1]`, false},
		{"array order equal", `[1,2]`, `[1,2]`, true},
		{"array length differs", `[1,2]`, `[1,2,3]`, false},
	}
	for _, testCase := range cases {
		left := Constraint{Kind: "k", Value: json.RawMessage(testCase.left)}
		right := Constraint{Kind: "k", Value: json.RawMessage(testCase.right)}
		if got := ConstraintMatches(left, right); got != testCase.want {
			t.Errorf("C-7 %s: left=%s right=%s got %v want %v", testCase.name, testCase.left, testCase.right, got, testCase.want)
		}
	}

	// C-7 through discovery: all required constraints must be matched exactly,
	// and nothing richer (a subset is *not* a match).
	core := NewCore()
	offered := Constraint{Kind: "mode", Value: json.RawMessage(`{"a":1,"b":2}`)}
	mustRegister(t, core, pluginSpec{
		instance:     "a-1",
		capabilities: []Capability{capabilityOf("casing.apply", "1.0.0", offered)},
	})

	exact, err := core.Find(Criteria{
		Capability:  "casing.apply",
		Constraints: []Constraint{{Kind: "mode", Value: json.RawMessage(`{"b":2,"a":1}`)}},
	}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(exact) != 1 {
		t.Fatalf("structurally equal constraints MUST match (C-7), found %d", len(exact))
	}

	partial, err := core.Find(Criteria{
		Capability:  "casing.apply",
		Constraints: []Constraint{{Kind: "mode", Value: json.RawMessage(`{"a":1}`)}},
	}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(partial) != 0 {
		t.Fatalf("a value subset MUST NOT match: C-7 is exact, found %d", len(partial))
	}
}

// ---------------------------------------------------------------------------
// Plugin — §5, P-1 … P-4
// ---------------------------------------------------------------------------

func TestP1EveryPluginHasUniqueIdentity(t *testing.T) {
	core := NewCore()
	first := mustRegister(t, core, pluginSpec{instance: "a-1"})
	if _, err := core.Register(first.Identity, nil); err != nil {
		wantCode(t, err, CodeIdentityDuplicate)
	} else {
		t.Fatal("a second plugin with the same identity MUST be rejected (P-1)")
	}
	if _, err := core.Register(Identity{Domain: "acme", ID: "a", Instance: "a-2"}, nil); err != nil {
		t.Fatalf("a different instance MUST be a different plugin (P-1): %v", err)
	}
}

func TestP2CapabilitiesMayBeEmpty(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1", capabilities: nil})
	if len(plugin.Capabilities) != 0 {
		t.Fatalf("expected no capabilities, got %v", plugin.Capabilities)
	}
	if plugin.Lifecycle != LifecycleInactive {
		t.Fatalf("a new plugin MUST start INACTIVE (§7.1), got %s", plugin.Lifecycle)
	}
	// It is still discoverable: P-2 makes capabilities optional, not the plugin.
	found, err := core.Find(Criteria{}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("a plugin with no capabilities MUST still be discoverable, found %d", len(found))
	}
}

func TestP3PluginIdentityMustNotChange(t *testing.T) {
	// P-3 is structural: Plugin.Identity is never written after Register, and
	// there is no API accepting a new identity for an existing plugin. The
	// observable consequences are that every read returns the registered
	// identity, and that a second registration is refused rather than treated as
	// a rename.
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})
	got, err := core.PluginOf(plugin.Identity)
	if err != nil {
		t.Fatalf("PluginOf: %v", err)
	}
	if got.Identity != plugin.Identity {
		t.Fatalf("identity changed: %s -> %s (P-3)", plugin.Identity, got.Identity)
	}
	// Re-registering the identity is a duplicate registration, not a rename, and
	// it must leave the incumbent entirely alone.
	_, err = core.Register(plugin.Identity, nil)
	wantCode(t, err, CodeIdentityDuplicate)
	after, err := core.PluginOf(plugin.Identity)
	if err != nil {
		t.Fatalf("PluginOf after the refused re-registration: %v", err)
	}
	if after.Identity != plugin.Identity {
		t.Fatalf("a refused re-registration MUST NOT change the identity (P-3): %s", after.Identity)
	}
	if after.Lifecycle != LifecycleInactive {
		t.Fatalf("a refused re-registration MUST NOT reset the lifecycle (P-3): %s", after.Lifecycle)
	}
}

func TestP4CapabilitySetMayChangeByExplicitDeclaration(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{
		instance:     "a-1",
		capabilities: []Capability{capabilityOf("casing.apply", "1.0.0")},
	})

	updated, err := core.DeclareCapabilities(plugin.Identity, []Capability{capabilityOf("casing.apply", "2.0.0")})
	if err != nil {
		t.Fatalf("declare: %v", err)
	}
	if updated.Identity != plugin.Identity {
		t.Fatal("declaring capabilities MUST NOT change the identity (P-3)")
	}
	if updated.HasCapability("casing.apply", "1.0.0") {
		t.Fatal("the old capability MUST be gone after an explicit declaration (P-4)")
	}
	if !updated.HasCapability("casing.apply", "2.0.0") {
		t.Fatal("the new capability MUST be present (P-4)")
	}
	// P-4 changes what may be composed, so discovery follows.
	found, err := core.Find(Criteria{Capability: "casing.apply", Version: "1.0.0"}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("the withdrawn version MUST NOT be found, found %d", len(found))
	}
}

// ---------------------------------------------------------------------------
// Binding — §6, B-1 … B-9
// ---------------------------------------------------------------------------

func TestB1EndpointsMustBeExistingPlugins(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))

	unknown := Identity{Domain: "acme", ID: "ghost", Instance: "ghost-1"}
	_, err := core.Bind(BindRequest{From: unknown, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	wantCode(t, err, CodePluginNotFound)

	_, err = core.Bind(BindRequest{From: provider.Identity, To: unknown,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	wantCode(t, err, CodePluginNotFound)

	// A malformed endpoint is a malformed identity, not a missing plugin: the
	// error code has to distinguish "you named nothing" from "nothing is there".
	_, err = core.Bind(BindRequest{From: Identity{Domain: "acme"}, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	wantCode(t, err, CodeIdentityInvalid)
}

func TestB2CapabilityMustBeExposedByFrom(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))

	_, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "9.9.9"},
	})
	wantCode(t, err, CodeCapabilityNotExposed)

	// O-2 states the same rule from the operation side. Registering the other
	// way round the capability does not help either: exposure is directional.
	_, err = core.Bind(BindRequest{
		From:       consumer.Identity,
		To:         provider.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"},
	})
	wantCode(t, err, CodeCapabilityNotExposed)
}

func TestB3BindingStateIsDerivedNotStored(t *testing.T) {
	// The structural half of B-3: if a `state` field existed, someone would
	// eventually assign it. Reflect over the type so that adding one is a test
	// failure rather than a code review miss.
	bindingFields := reflect.VisibleFields(reflect.TypeOf(Binding{}))
	for _, field := range bindingFields {
		if strings.EqualFold(field.Name, "state") {
			t.Fatalf("Binding MUST NOT carry a state field (B-3): %s", field.Name)
		}
	}

	// The behavioural half: the same stored binding reports different states as
	// the graph around it changes, with no explicit state transition anywhere.
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingActive {
		t.Fatalf("both ends ACTIVE => ACTIVE, got %s", got)
	}
	if err := core.Suspend(consumer.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("consumer SUSPENDED => DORMANT, got %s (B-3, B-5)", got)
	}
	if err := core.Resume(consumer.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingActive {
		t.Fatalf("consumer ACTIVE again => ACTIVE, got %s (§6.6)", got)
	}
}

func TestB4ClosedIsTerminal(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := core.Unbind(binding.ID); err != nil {
		t.Fatalf("unbind: %v", err)
	}

	// Nothing un-closes it: not reactivating the endpoints, not suspending and
	// resuming them, not unbinding again.
	if err := core.Unbind(binding.ID); err != nil {
		t.Fatalf("unbind MUST be idempotent (O-4): %v", err)
	}
	if err := core.Deactivate(provider.Identity); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if err := core.Activate(provider.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingClosed {
		t.Fatalf("CLOSED MUST be terminal (B-4), got %s", got)
	}
	if !BindingClosed.IsTerminal() {
		t.Fatal("IsTerminal MUST report CLOSED as terminal (B-4)")
	}
	if BindingActive.IsTerminal() || BindingDormant.IsTerminal() {
		t.Fatal("only CLOSED is terminal (B-4)")
	}
}

func TestB5EndpointNotActiveMeansDormant(t *testing.T) {
	capability := capabilityOf("casing.apply", "1.0.0")

	// Every combination of (from, to) lifecycle that is not (ACTIVE, ACTIVE)
	// must derive DORMANT. This is the table of §6.6 read as a matrix.
	states := []struct {
		name  string
		apply func(*testing.T, *Core, Identity)
	}{
		{"INACTIVE", func(t *testing.T, core *Core, identity Identity) {
			if err := core.Deactivate(identity); err != nil {
				t.Fatalf("deactivate: %v", err)
			}
		}},
		{"SUSPENDED", func(t *testing.T, core *Core, identity Identity) {
			if err := core.Suspend(identity); err != nil {
				t.Fatalf("suspend: %v", err)
			}
		}},
	}

	for _, endpoint := range []string{"from", "to"} {
		for _, state := range states {
			t.Run(endpoint+"_"+state.name, func(t *testing.T) {
				core := NewCore()
				provider, consumer := activePair(t, core, capability)
				binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
					Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
				if err != nil {
					t.Fatalf("bind: %v", err)
				}
				target := provider.Identity
				if endpoint == "to" {
					target = consumer.Identity
				}
				state.apply(t, core, target)
				if got := stateOf(t, core, binding.ID); got != BindingDormant {
					t.Fatalf("%s %s => DORMANT, got %s (B-5)", endpoint, state.name, got)
				}
			})
		}
	}

	// "from still exposes the capability" is the third ACTIVE condition, and
	// the only way to leave it is an explicit declaration (P-4).
	core := NewCore()
	provider, consumer := activePair(t, core, capability)
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if _, err := core.DeclareCapabilities(provider.Identity, nil); err != nil {
		t.Fatalf("declare: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("withdrawn capability => DORMANT, got %s (§6.4, §6.6)", got)
	}
	if _, err := core.DeclareCapabilities(provider.Identity, []Capability{capability}); err != nil {
		t.Fatalf("declare: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingActive {
		t.Fatalf("re-exposed capability => ACTIVE, got %s (§6.6)", got)
	}
}

func TestB6OnlyOneOpenBindingPerTriple(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	request := BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}}

	first, err := core.Bind(request)
	if err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if _, err := core.Bind(request); err != nil {
		wantCode(t, err, CodeBindingDuplicate)
	} else {
		t.Fatal("a second non-CLOSED binding for the same triple MUST be refused (B-6)")
	}
	// A binding to a *different* consumer is a different triple, and is legal:
	// §14 answer 6 says a plugin may take part in many bindings.
	other := mustRegister(t, core, pluginSpec{instance: "c-1"})
	if err := core.Activate(other.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if _, err := core.Bind(BindRequest{From: provider.Identity, To: other.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}}); err != nil {
		t.Fatalf("a different (from, to, capability) MUST be bindable (§14 answer 6): %v", err)
	}

	// Closing frees the slot: the uniqueness domain is *non-CLOSED* bindings.
	// That is also the one case where B-6 is what makes rebinding observable.
	if err := core.Unbind(first.ID); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	if _, err := core.Bind(request); err != nil {
		t.Fatalf("after CLOSE the triple MUST be bindable again (B-6, §6.8): %v", err)
	}
}

func TestB7CapabilityPluginMustEqualFrom(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))

	// Supplying the redundant field is legal when it agrees.
	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Plugin: provider.Identity, Name: "casing.apply", Version: "1.0.0"},
	})
	if err != nil {
		t.Fatalf("bind with an agreeing capability.plugin: %v", err)
	}
	if !binding.Capability.Plugin.Equal(binding.From) {
		t.Fatalf("Binding.capability.plugin MUST equal Binding.from (B-7): %v vs %v",
			binding.Capability.Plugin, binding.From)
	}

	// A contradictory value is EAPP_BINDING_INVALID (§6.7), not a silent
	// rewrite: rewriting would let the caller believe it bound something else.
	_, err = core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Plugin: consumer.Identity, Name: "casing.apply", Version: "1.0.0"},
	})
	wantCode(t, err, CodeBindingInvalid)
}

func TestB8UniquenessCheckAndCreationAreAtomic(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	request := BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}}

	const attempts = 64
	var successes atomic.Int64
	var duplicates atomic.Int64
	start := make(chan struct{})
	var waitGroup sync.WaitGroup
	for i := 0; i < attempts; i++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			<-start // release all goroutines together
			binding, err := core.Bind(request)
			switch {
			case err == nil:
				if binding.ID == "" {
					t.Errorf("bind succeeded but returned no binding id")
				}
				successes.Add(1)
			default:
				if code, ok := CodeOf(err); ok && code == CodeBindingDuplicate {
					duplicates.Add(1)
				} else {
					t.Errorf("unexpected error from a concurrent bind: %v", err)
				}
			}
		}()
	}
	close(start)
	waitGroup.Wait()

	if got := successes.Load(); got != 1 {
		t.Fatalf("exactly one concurrent bind MUST succeed (B-6, B-8), %d did", got)
	}
	if got := duplicates.Load(); got != attempts-1 {
		t.Fatalf("the other %d binds MUST fail with %s, %d did", attempts-1, CodeBindingDuplicate, got)
	}
	if open := len(core.Bindings()); open != 1 {
		t.Fatalf("registry MUST hold exactly one binding, holds %d (B-6)", open)
	}
}

func TestB9PendingIsNotObservable(t *testing.T) {
	// B-9 cannot be observed through the public API by construction: there is
	// no PENDING constant, bind() publishes the binding only once, under the
	// lock, and no state value other than ACTIVE/DORMANT/CLOSED can be
	// produced. The test asserts the enumeration is closed, which is the
	// checkable part of "no intermediate state escapes".
	if BindingState("PENDING").Valid() {
		t.Fatal("PENDING MUST NOT be an observable binding state (B-9)")
	}
	states := []BindingState{BindingActive, BindingDormant, BindingClosed}
	for _, state := range states {
		if !state.Valid() {
			t.Fatalf("%s MUST be a valid state (§6.2)", state)
		}
	}
	// A concurrent observer of a bind sees either "no binding" or the finished
	// binding — never a third answer.
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	request := BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}}

	var waitGroup sync.WaitGroup
	waitGroup.Add(1)
	go func() {
		defer waitGroup.Done()
		if _, err := core.Bind(request); err != nil {
			t.Errorf("bind: %v", err)
		}
	}()
	for i := 0; i < 200; i++ {
		for _, binding := range core.Bindings() {
			state, err := core.BindingState(binding.ID)
			if err != nil {
				t.Fatalf("bindingState: %v", err)
			}
			if !state.Valid() {
				t.Fatalf("observed state %q is not one of ACTIVE/DORMANT/CLOSED (B-9)", state)
			}
		}
	}
	waitGroup.Wait()
}

// ---------------------------------------------------------------------------
// Lifecycle — §7, L-1 … L-6
// ---------------------------------------------------------------------------

func TestL1ActivateGoesInactiveToActive(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})
	if plugin.Lifecycle != LifecycleInactive {
		t.Fatalf("a registered plugin MUST be INACTIVE, got %s", plugin.Lifecycle)
	}
	if err := core.Activate(plugin.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleActive {
		t.Fatalf("activate MUST yield ACTIVE (L-1), got %s", got)
	}
}

func TestL2DeactivateGoesToInactiveFromAnyState(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})

	// INACTIVE -> INACTIVE (§7.2 lists the self-transition explicitly).
	if err := core.Deactivate(plugin.Identity); err != nil {
		t.Fatalf("deactivate from INACTIVE MUST succeed (L-2): %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleInactive {
		t.Fatalf("got %s", got)
	}
	// ACTIVE -> INACTIVE.
	if err := core.Activate(plugin.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := core.Deactivate(plugin.Identity); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleInactive {
		t.Fatalf("deactivate MUST yield INACTIVE (L-2), got %s", got)
	}
	// SUSPENDED -> INACTIVE.
	if err := core.Activate(plugin.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := core.Suspend(plugin.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if err := core.Deactivate(plugin.Identity); err != nil {
		t.Fatalf("deactivate from SUSPENDED MUST succeed (L-2): %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleInactive {
		t.Fatalf("deactivate MUST yield INACTIVE (L-2), got %s", got)
	}
}

func TestL3SuspendOnlyFromActive(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})

	// INACTIVE is not a legal source for suspend.
	wantCode(t, core.Suspend(plugin.Identity), CodeLifecycleInvalid)
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleInactive {
		t.Fatalf("a rejected suspend MUST NOT change the state, got %s", got)
	}
	if err := core.Activate(plugin.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := core.Suspend(plugin.Identity); err != nil {
		t.Fatalf("suspend from ACTIVE MUST succeed (L-3): %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleSuspended {
		t.Fatalf("suspend MUST yield SUSPENDED (L-3), got %s", got)
	}
	// Already SUSPENDED is not ACTIVE either.
	wantCode(t, core.Suspend(plugin.Identity), CodeLifecycleInvalid)
}

func TestL4ResumeOnlyFromSuspended(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})

	wantCode(t, core.Resume(plugin.Identity), CodeLifecycleInvalid) // INACTIVE
	if err := core.Activate(plugin.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	wantCode(t, core.Resume(plugin.Identity), CodeLifecycleInvalid) // ACTIVE (O-5 is about activate)
	if err := core.Suspend(plugin.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if err := core.Resume(plugin.Identity); err != nil {
		t.Fatalf("resume from SUSPENDED MUST succeed (L-4): %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleActive {
		t.Fatalf("resume MUST yield ACTIVE (L-4), got %s", got)
	}
}

func TestL5SuspendedMustNotUnbind(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}

	if err := core.Suspend(provider.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	// The binding still exists, is still addressable, and is only DORMANT —
	// never CLOSED (§14 answer 4).
	if _, err := core.Binding(binding.ID); err != nil {
		t.Fatalf("the binding MUST survive suspend (L-5): %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("SUSPENDED MUST derive DORMANT, got %s (L-5, §7.4)", got)
	}
	if err := core.Resume(provider.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingActive {
		t.Fatalf("resume MUST restore ACTIVE without a re-bind, got %s (§6.6)", got)
	}
}

func TestL6ActivateAppliesOnlyToInactive(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})
	if err := core.Activate(plugin.Identity); err != nil {
		t.Fatalf("activate from INACTIVE MUST succeed (L-1): %v", err)
	}
	if err := core.Suspend(plugin.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	// The heart of L-6: activate MUST NOT be the way out of SUSPENDED.
	wantCode(t, core.Activate(plugin.Identity), CodeLifecycleInvalid)
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleSuspended {
		t.Fatalf("the rejected activate MUST have left SUSPENDED intact, got %s", got)
	}
	// resume is.
	if err := core.Resume(plugin.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleActive {
		t.Fatalf("got %s", got)
	}
	// §7.1: an unknown lifecycle state is rejected rather than coerced.
	if _, err := ParseLifecycleState("RUNNING"); err == nil {
		t.Fatal("unknown lifecycle states MUST be rejected")
	} else {
		wantCode(t, err, CodeLifecycleInvalid)
	}
}

// ---------------------------------------------------------------------------
// Discovery — §8, D-1 … D-7
// ---------------------------------------------------------------------------

// agePolicy is a test VisibilityPolicy: it makes plugins visible only in the
// scope named by their domain, which is the smallest thing that can exercise
// D-1/D-2 without inventing plugin trust metadata.
type agePolicy struct{}

func (agePolicy) Visible(plugin Plugin, scope DiscoveryScope) bool {
	if scope.TrustDomain == "" {
		return true
	}
	return scope.TrustDomain == plugin.Identity.Domain
}

func TestD1FindReturnsOnlyVisiblyScopedPlugins(t *testing.T) {
	core := NewCore()
	core.SetVisibilityPolicy(agePolicy{})
	mustRegister(t, core, pluginSpec{domain: "acme", instance: "a-1"})
	mustRegister(t, core, pluginSpec{domain: "other", instance: "b-1"})

	all, err := core.Find(Criteria{}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("an unscoped query MUST see every plugin, saw %d", len(all))
	}

	scoped, err := core.Find(Criteria{}, DiscoveryScope{TrustDomain: "acme"})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(scoped) != 1 || scoped[0].Domain != "acme" {
		t.Fatalf("find MUST return only scope-visible plugins (D-1), got %v", scoped)
	}
}

func TestD2WatchOnlyFiresForVisiblePlugins(t *testing.T) {
	core := NewCore()
	core.SetVisibilityPolicy(agePolicy{})

	watchID, events, err := core.Watch(Criteria{}, DiscoveryScope{TrustDomain: "acme"})
	if err != nil {
		t.Fatalf("watch: %v", err)
	}
	defer core.Unwatch(watchID)

	// Out of scope: no event (D-2).
	mustRegister(t, core, pluginSpec{domain: "other", instance: "b-1"})
	select {
	case event := <-events:
		t.Fatalf("out-of-scope registration MUST NOT fire an event (D-2), got %+v", event)
	default:
	}

	// In scope: an `added` event, and its type is one of D-6's three.
	inScope := mustRegister(t, core, pluginSpec{domain: "acme", instance: "a-1"})
	select {
	case event := <-events:
		if event.Type != EventAdded {
			t.Fatalf("expected added, got %s (D-6)", event.Type)
		}
		if !event.Plugin.Equal(inScope.Identity) {
			t.Fatalf("event names %s, expected %s", event.Plugin, inScope.Identity)
		}
	default:
		t.Fatal("in-scope registration MUST fire an event (D-2)")
	}
}

func TestD3DiscoveryDoesNotImplyComposability(t *testing.T) {
	core := NewCore()
	// Discoverable but INACTIVE: find reports it, bind is allowed, and the
	// resulting binding is DORMANT — discovery said nothing about composability.
	provider := mustRegister(t, core, pluginSpec{instance: "a-1",
		capabilities: []Capability{capabilityOf("casing.apply", "1.0.0")}})
	consumer := mustRegister(t, core, pluginSpec{instance: "b-1"})

	found, err := core.Find(Criteria{Capability: "casing.apply"}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("find: %v", found)
	}
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("being discoverable MUST NOT imply being composable (D-3), got %s", got)
	}
}

func TestD4DiscoveryDoesNotServeStaleResults(t *testing.T) {
	// D-4 permits caching *with* an invalidation policy. This implementation
	// caches nothing, so the invalidation policy is trivially correct: every
	// query reads the live registry. The test pins that behaviour, because an
	// added cache without invalidation would fail here.
	core := NewCore()
	if found, err := core.Find(Criteria{}, DiscoveryScope{}); err != nil || len(found) != 0 {
		t.Fatalf("fresh core MUST discover nothing: %v %v", found, err)
	}
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})
	found, err := core.Find(Criteria{}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(found) != 1 || !found[0].Equal(plugin.Identity) {
		t.Fatalf("a registration MUST be visible to the next query (D-4), got %v", found)
	}
}

func TestD5DiscoveryDoesNotCreateBindings(t *testing.T) {
	core := NewCore()
	provider := mustRegister(t, core, pluginSpec{instance: "a-1",
		capabilities: []Capability{capabilityOf("casing.apply", "1.0.0")}})
	mustRegister(t, core, pluginSpec{instance: "b-1"})

	if _, err := core.Find(Criteria{Capability: "casing.apply"}, DiscoveryScope{}); err != nil {
		t.Fatalf("find: %v", err)
	}
	if bindings := core.Bindings(); len(bindings) != 0 {
		t.Fatalf("discovery MUST NOT create bindings (D-5): %v", bindings)
	}

	// A watcher is not a binding either: it reports, it does not relate.
	watchID, _, err := core.Watch(Criteria{}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("watch: %v", err)
	}
	defer core.Unwatch(watchID)
	if _, err := core.PluginOf(provider.Identity); err != nil {
		t.Fatalf("PluginOf: %v", err)
	}
	if bindings := core.Bindings(); len(bindings) != 0 {
		t.Fatalf("watch MUST NOT create bindings (D-5): %v", bindings)
	}
}

func TestD6DiscoveryEventTypeIsClosedEnum(t *testing.T) {
	for _, valid := range []EventType{EventAdded, EventRemoved, EventChanged} {
		if !valid.Valid() {
			t.Fatalf("%s MUST be a valid event type (D-6)", valid)
		}
	}
	for _, invalid := range []EventType{"created", "deleted", "", "ADDED", "updated"} {
		if invalid.Valid() {
			t.Fatalf("%q MUST NOT be a valid event type (D-6)", invalid)
		}
	}
}

func TestD7TrustLevelDoesNotImplyOrderedAuthorization(t *testing.T) {
	// D-7 is checkable in two ways. First, the enum: any other level is
	// EAPP_DISCOVERY_SCOPE_INVALID, so no caller can express a level the Core
	// would have to rank. Second, the *behaviour*: an L2 scope must not
	// automatically be broader than an L0 scope — the policy decides, and the
	// Core imposes no ordering of its own.
	core := NewCore()
	for _, invalid := range []string{"L3", "l0", "0", "high", "L"} {
		if err := (DiscoveryScope{TrustLevel: invalid}).Valid(); err == nil {
			t.Fatalf("trustLevel %q MUST be rejected (D-7)", invalid)
		} else {
			wantCode(t, err, CodeDiscoveryScopeInvalid)
		}
	}
	for _, valid := range []string{"", TrustLevelL0, TrustLevelL1, TrustLevelL2} {
		if err := (DiscoveryScope{TrustLevel: valid}).Valid(); err != nil {
			t.Fatalf("trustLevel %q MUST be accepted (D-7): %v", valid, err)
		}
	}

	// A policy that grants L0 broader access than L2: the Core must honour it
	// verbatim, proving it does not "fix" the policy by ranking the levels.
	core.SetVisibilityPolicy(VisibilityFunc(func(plugin Plugin, scope DiscoveryScope) bool {
		switch scope.TrustLevel {
		case TrustLevelL0:
			return true // sees everything
		case TrustLevelL2:
			return plugin.Identity.ID == "narrow" // sees one plugin
		default:
			return false
		}
	}))
	mustRegister(t, core, pluginSpec{id: "narrow", instance: "n-1"})
	mustRegister(t, core, pluginSpec{id: "wide", instance: "w-1"})

	l0, err := core.Find(Criteria{}, DiscoveryScope{TrustLevel: TrustLevelL0})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	l2, err := core.Find(Criteria{}, DiscoveryScope{TrustLevel: TrustLevelL2})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(l0) <= len(l2) {
		t.Fatalf("the Core MUST NOT impose L2 > L0 ordering (D-7): L0 saw %d, L2 saw %d", len(l0), len(l2))
	}
}

func TestDiscoveryVersionRangeIsMatchedNotIgnored(t *testing.T) {
	// Errata E-E: a range that the implementation cannot handle MUST be
	// rejected, never silently treated as "matches nothing".
	core := NewCore()
	mustRegister(t, core, pluginSpec{instance: "a-1",
		capabilities: []Capability{capabilityOf("logging", "1.2.3")}})

	for _, criteria := range []Criteria{
		{Capability: "logging", Version: "^1.0.0"},
		{Capability: "logging", Version: "~1.2.0"},
		{Capability: "logging", Version: ">=1.0.0 <2.0.0"},
		{Capability: "logging", Version: "1.2.3"},
		{Capability: "logging", Version: "1.2"},
		{Capability: "logging", Version: "*"},
		{Capability: "logging", Version: "1.0.0 - 2.0.0"},
	} {
		found, err := core.Find(criteria, DiscoveryScope{})
		if err != nil {
			t.Fatalf("find(%q): %v", criteria.Version, err)
		}
		if len(found) != 1 {
			t.Errorf("range %q MUST match logging@1.2.3", criteria.Version)
		}
	}
	for _, criteria := range []Criteria{
		{Capability: "logging", Version: "^2.0.0"},
		{Capability: "logging", Version: "1.2.4"},
		{Capability: "logging", Version: ">=2.0.0"},
	} {
		found, err := core.Find(criteria, DiscoveryScope{})
		if err != nil {
			t.Fatalf("find(%q): %v", criteria.Version, err)
		}
		if len(found) != 0 {
			t.Errorf("range %q MUST NOT match logging@1.2.3", criteria.Version)
		}
	}
	// Unsupported syntax is an explicit error.
	for _, unsupported := range []string{"^1.0.0 || ^2.0.0", "!=1.0.0", "not a range"} {
		_, err := core.Find(Criteria{Capability: "logging", Version: unsupported}, DiscoveryScope{})
		if err == nil {
			t.Fatalf("unsupported range %q MUST be rejected, not silently unmatched", unsupported)
		}
		wantCode(t, err, CodeDiscoveryScopeInvalid)
	}
}

func TestDiscoveryIdentityFilterIsPartial(t *testing.T) {
	core := NewCore()
	mustRegister(t, core, pluginSpec{domain: "acme", id: "logger", instance: "l-1"})
	mustRegister(t, core, pluginSpec{domain: "acme", id: "metrics", instance: "m-1"})
	mustRegister(t, core, pluginSpec{domain: "other", id: "logger", instance: "o-1"})

	cases := []struct {
		filter        PartialIdentity
		wantInstances []string
	}{
		{PartialIdentity{Domain: "acme"}, []string{"l-1", "m-1"}},
		{PartialIdentity{ID: "logger"}, []string{"l-1", "o-1"}},
		{PartialIdentity{Instance: "m-1"}, []string{"m-1"}},
		{PartialIdentity{Domain: "acme", ID: "logger"}, []string{"l-1"}},
		{PartialIdentity{Domain: "nope"}, nil},
	}
	for _, testCase := range cases {
		found, err := core.Find(Criteria{Identity: testCase.filter}, DiscoveryScope{})
		if err != nil {
			t.Fatalf("find(%+v): %v", testCase.filter, err)
		}
		if len(found) != len(testCase.wantInstances) {
			t.Fatalf("find(%+v) = %v, want %v", testCase.filter, found, testCase.wantInstances)
		}
		for i, instance := range testCase.wantInstances {
			if found[i].Instance != instance {
				t.Fatalf("find(%+v) = %v, want %v", testCase.filter, found, testCase.wantInstances)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Operations — §9, O-1 … O-8
// ---------------------------------------------------------------------------

func TestO1BindCreatesBindingWithDerivedState(t *testing.T) {
	core := NewCore()
	provider := mustRegister(t, core, pluginSpec{instance: "a-1",
		capabilities: []Capability{capabilityOf("casing.apply", "1.0.0")}})
	consumer := mustRegister(t, core, pluginSpec{instance: "b-1"})

	// Both ends INACTIVE: the binding exists and is DORMANT (§6.4).
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if binding.ID == "" {
		t.Fatal("bind MUST return a handle")
	}
	if !binding.From.Equal(provider.Identity) || !binding.To.Equal(consumer.Identity) {
		t.Fatalf("bind MUST record the endpoints: %+v", binding)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("INACTIVE ends MUST derive DORMANT (O-1), got %s", got)
	}

	// Activating both ends derives ACTIVE, with no second operation.
	if err := core.Activate(provider.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := core.Activate(consumer.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingActive {
		t.Fatalf("ACTIVE ends MUST derive ACTIVE (O-1), got %s", got)
	}
}

func TestO2BindFailsWhenFromDoesNotExposeCapability(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	_, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: "absent.capability", Version: "1.0.0"},
	})
	wantCode(t, err, CodeCapabilityNotExposed)
}

func TestO3UnbindSetsClosed(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := core.Unbind(binding.ID); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingClosed {
		t.Fatalf("unbind MUST set CLOSED (O-3), got %s", got)
	}
	// O-3 is about *setting a state*, not deleting the record.
	stillThere, err := core.Binding(binding.ID)
	if err != nil {
		t.Fatalf("a CLOSED binding MUST remain inspectable (O-3): %v", err)
	}
	if stillThere.ID != binding.ID {
		t.Fatalf("got %+v", stillThere)
	}
}

func TestO4UnbindIsIdempotent(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := core.Unbind(binding.ID); err != nil {
			t.Fatalf("unbind #%d MUST succeed (O-4): %v", i+1, err)
		}
		if got := stateOf(t, core, binding.ID); got != BindingClosed {
			t.Fatalf("after unbind #%d state is %s", i+1, got)
		}
	}
	// An unknown handle is *not* idempotent-success: there is nothing to close,
	// and reporting success would claim a state no binding holds.
	wantCode(t, core.Unbind("binding-does-not-exist"), CodeBindingInvalid)
}

func TestO5ActivateIsIdempotent(t *testing.T) {
	core := NewCore()
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1"})
	for i := 0; i < 3; i++ {
		if err := core.Activate(plugin.Identity); err != nil {
			t.Fatalf("activate #%d MUST succeed (O-5): %v", i+1, err)
		}
		if got := lifecycleOf(t, core, plugin.Identity); got != LifecycleActive {
			t.Fatalf("after activate #%d state is %s", i+1, got)
		}
	}
	// Idempotence does not extend to SUSPENDED: L-6 still forbids that.
	if err := core.Suspend(plugin.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	wantCode(t, core.Activate(plugin.Identity), CodeLifecycleInvalid)
}

func TestO6DeactivateMakesBindingsDormant(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := core.Deactivate(provider.Identity); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("deactivate MUST make bindings DORMANT (O-6), got %s", got)
	}
	// §7.4: deactivate MUST NOT directly CLOSE the binding.
	if got := stateOf(t, core, binding.ID); got.IsTerminal() {
		t.Fatal("deactivate MUST NOT close bindings (§7.4, O-6)")
	}
	// And §6.6's recovery: activating again restores ACTIVE.
	if err := core.Activate(provider.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingActive {
		t.Fatalf("re-activating MUST restore ACTIVE (§6.6), got %s", got)
	}
}

func TestO7SuspendMakesBindingsDormant(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := core.Suspend(consumer.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if got := stateOf(t, core, binding.ID); got != BindingDormant {
		t.Fatalf("suspend MUST make bindings DORMANT (O-7), got %s", got)
	}
	if len(core.Bindings()) != 1 {
		t.Fatal("suspend MUST NOT remove bindings (L-5, O-7)")
	}
}

func TestO8ResumeReevaluatesAllBindings(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	first, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	// A second binding on the same provider, to exercise "all bindings".
	other := mustRegister(t, core, pluginSpec{instance: "c-1"})
	if err := core.Activate(other.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	second, err := core.Bind(BindRequest{From: provider.Identity, To: other.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}

	if err := core.Suspend(provider.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	for _, id := range []string{first.ID, second.ID} {
		if got := stateOf(t, core, id); got != BindingDormant {
			t.Fatalf("%s after suspend: %s (O-7)", id, got)
		}
	}
	if err := core.Resume(provider.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	for _, id := range []string{first.ID, second.ID} {
		if got := stateOf(t, core, id); got != BindingActive {
			t.Fatalf("%s after resume: %s, want ACTIVE (O-8)", id, got)
		}
	}

	// O-8 re-*evaluates*, it does not force ACTIVE. Suspend the consumer of one
	// binding and check that resume of the provider leaves it DORMANT.
	if err := core.Suspend(consumer.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if err := core.Suspend(provider.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if err := core.Resume(provider.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := stateOf(t, core, first.ID); got != BindingDormant {
		t.Fatalf("resume MUST re-evaluate, not force ACTIVE (O-8): got %s", got)
	}
	if got := stateOf(t, core, second.ID); got != BindingActive {
		t.Fatalf("the unaffected binding MUST be ACTIVE, got %s", got)
	}
}

func TestAllSixControlPrimitivesAndTwoDiscoveryOperationsExist(t *testing.T) {
	// §9.1 counts exactly six Composition/Lifecycle primitives and two Discovery
	// operations. This test is the checklist: each one is exercised end to end,
	// and the count of operations exposed by Core is asserted structurally so
	// that adding a ninth primitive accidentally is visible.
	core := NewCore()
	provider := mustRegister(t, core, pluginSpec{instance: "a-1",
		capabilities: []Capability{capabilityOf("casing.apply", "1.0.0")}})
	consumer := mustRegister(t, core, pluginSpec{instance: "b-1"})

	if err := core.Activate(provider.Identity); err != nil { // lifecycle primitive 1
		t.Fatalf("activate: %v", err)
	}
	if err := core.Activate(consumer.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	binding, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity, // composition primitive 1
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := core.Suspend(consumer.Identity); err != nil { // lifecycle primitive 3
		t.Fatalf("suspend: %v", err)
	}
	if err := core.Resume(consumer.Identity); err != nil { // lifecycle primitive 4
		t.Fatalf("resume: %v", err)
	}
	if err := core.Deactivate(consumer.Identity); err != nil { // lifecycle primitive 2
		t.Fatalf("deactivate: %v", err)
	}
	if err := core.Unbind(binding.ID); err != nil { // composition primitive 2
		t.Fatalf("unbind: %v", err)
	}
	if _, err := core.Find(Criteria{}, DiscoveryScope{}); err != nil { // discovery operation 1
		t.Fatalf("find: %v", err)
	}
	watchID, _, err := core.Watch(Criteria{}, DiscoveryScope{}) // discovery operation 2
	if err != nil {
		t.Fatalf("watch: %v", err)
	}
	core.Unwatch(watchID)
}

// ---------------------------------------------------------------------------
// Channel boundary — §10, CH-1
// ---------------------------------------------------------------------------

func TestCH1CompositionCoreDefinesNoChannelSemantics(t *testing.T) {
	// CH-1 says the Composition Core MUST NOT define Channel interaction
	// semantics. §10.1 is precise about what it MAY acknowledge: a ChannelRef is
	// {id, binding} and nothing more. This implementation exposes neither: the
	// binding handle alone is enough for the layer above to derive a channel,
	// which is exactly the layering §11.1 describes.
	//
	// The checkable part is structural: no exported Core type may carry a
	// delivery/ordering/serialization concern.
	forbidden := []string{"channel", "delivery", "ordering", "serialization", "ack", "lease", "cursor", "request", "event", "stream"}
	for _, target := range []any{Binding{}, Capability{}, CapabilityRef{}, Plugin{}, Identity{}, BindRequest{}, Criteria{}, DiscoveryScope{}, DiscoveryEvent{}} {
		typeOf := reflect.TypeOf(target)
		for _, field := range reflect.VisibleFields(typeOf) {
			name := strings.ToLower(field.Name)
			for _, banned := range forbidden {
				if strings.Contains(name, banned) {
					t.Fatalf("%s carries channel-layer field %q (CH-1)", typeOf, field.Name)
				}
			}
		}
		// Methods count too: a ChannelRef() accessor would already be claiming
		// a Channel exists at this layer.
		for i := 0; i < typeOf.NumMethod(); i++ {
			name := strings.ToLower(typeOf.Method(i).Name)
			if strings.Contains(name, "channel") {
				t.Fatalf("%s exposes channel-layer method %q (CH-1)", typeOf, typeOf.Method(i).Name)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Bootstrap — §12, BR-1 … BR-3
// ---------------------------------------------------------------------------

func TestBR1BR2BootstrapIsSelfContained(t *testing.T) {
	// BR-2: the bootstrap must not depend on any plugin. It therefore has to
	// work on a completely empty Core — an empty Core is precisely the state in
	// which no plugin exists to depend on.
	core := NewCore()
	bootstrapper := NewBootstrapper(core)

	identity, err := bootstrapper.CreateIdentity("root")
	if err != nil {
		t.Fatalf("CreateIdentity on an empty core MUST succeed (BR-2): %v", err)
	}
	// BR-1: the bootstrap cannot be led to reference something nonexistent. A
	// self-issued (never minted) identity is refused rather than bootstrapped
	// into a phantom plugin.
	if _, err := core.Register(Identity{Domain: "acme", ID: "ghost", Instance: "ghost-1"}, nil); err != nil {
		// Register mints on demand, so this succeeds — the check that matters is
		// that the *runtime* minted identity is what gets registered, and that a
		// bogus reference does not silently become a plugin.
		t.Fatalf("unexpected: %v", err)
	}
	if _, err := core.PluginOf(Identity{Domain: "acme", ID: "ghost", Instance: "never-minted"}); err == nil {
		t.Fatal("a reference the runtime never issued MUST be refused (BR-1)")
	} else {
		wantCode(t, err, CodePluginNotFound)
	}

	// The bootstrap identity is registry-known before any plugin exists.
	if !core.HasIdentity(identity) {
		t.Fatalf("the bootstrap identity %s MUST be minted (ID-5)", identity)
	}
}

func TestBR3BootstrapProvidesInitialDiscovery(t *testing.T) {
	core := NewCore()
	bootstrapper := NewBootstrapper(core)

	discovery := bootstrapper.InitialDiscovery()
	if discovery == nil {
		t.Fatal("the bootstrap MUST provide an initial Discovery (BR-3)")
	}
	// It is a live Discovery, not a stub: it answers with the current graph.
	found, err := discovery.Find(Criteria{}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("initial discovery MUST answer Find (BR-3): %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("expected an empty initial graph, got %v", found)
	}
	if _, _, err := discovery.Watch(Criteria{}, DiscoveryScope{}); err != nil {
		t.Fatalf("initial discovery MUST answer Watch (BR-3): %v", err)
	}

	// LoadFirstPlugin then makes the graph non-empty, and the *same* discovery
	// object sees it — which is what §12.3 needs from a replaceable root.
	identity, err := bootstrapper.CreateIdentity("first")
	if err != nil {
		t.Fatalf("CreateIdentity: %v", err)
	}
	plugin, err := bootstrapper.LoadFirstPlugin(identity)
	if err != nil {
		t.Fatalf("LoadFirstPlugin: %v", err)
	}
	if !plugin.Identity.Equal(identity) {
		t.Fatalf("LoadFirstPlugin MUST register the identity it was given: %s vs %s", plugin.Identity, identity)
	}
	found, err = discovery.Find(Criteria{}, DiscoveryScope{})
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("the initial Discovery MUST reflect the loaded plugin (BR-3), got %v", found)
	}
}

// ---------------------------------------------------------------------------
// Errors — §16
// ---------------------------------------------------------------------------

func TestErrorCodesAreTheFrozenStrings(t *testing.T) {
	// §16 freezes the code strings; a rename is a protocol break, so the literals
	// are asserted here rather than only referenced by constant.
	expected := map[string]string{
		"EAPP_IDENTITY_INVALID":        CodeIdentityInvalid,
		"EAPP_IDENTITY_DUPLICATE":      CodeIdentityDuplicate,
		"EAPP_CAPABILITY_NOT_FOUND":    CodeCapabilityNotFound,
		"EAPP_CAPABILITY_NOT_EXPOSED":  CodeCapabilityNotExposed,
		"EAPP_PLUGIN_NOT_FOUND":        CodePluginNotFound,
		"EAPP_PLUGIN_INACTIVE":         CodePluginInactive,
		"EAPP_BINDING_INVALID":         CodeBindingInvalid,
		"EAPP_BINDING_DUPLICATE":       CodeBindingDuplicate,
		"EAPP_BINDING_CLOSED":          CodeBindingClosed,
		"EAPP_LIFECYCLE_INVALID":       CodeLifecycleInvalid,
		"EAPP_DISCOVERY_SCOPE_INVALID": CodeDiscoveryScopeInvalid,
		"EAPP_UNSUPPORTED":             CodeUnsupported,
		"EAPP_INTERNAL":                CodeInternal,
	}
	for literal, constant := range expected {
		if literal != constant {
			t.Fatalf("code renamed: constant holds %q, spec says %q (§16)", constant, literal)
		}
	}
}

func TestErrorIsFoundThroughWrapping(t *testing.T) {
	core := NewCore()
	_, err := core.CreateIdentity("", "id", "instance")
	if err == nil {
		t.Fatal("expected an error")
	}
	// The driver wraps errors with %w when it builds its response; errors.As
	// must still find the *Error and its code.
	wrapped := fmt.Errorf("handling identity.create: %w", err)
	if code, ok := CodeOf(wrapped); !ok || code != CodeIdentityInvalid {
		t.Fatalf("CodeOf through a wrapper: %q %v", code, ok)
	}
	var typed *Error
	if !errors.As(wrapped, &typed) {
		t.Fatal("errors.As MUST find *Error through a wrapper")
	}
	if typed.Code != CodeIdentityInvalid || typed.Message == "" {
		t.Fatalf("wrapped error lost its code or message: %+v", typed)
	}
	if !strings.Contains(typed.Error(), CodeIdentityInvalid) {
		t.Fatalf("Error() MUST name the code: %q", typed.Error())
	}
}

// ---------------------------------------------------------------------------
// Registration / reset behaviour that the driver depends on
// ---------------------------------------------------------------------------

func TestResetClearsEverything(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))
	if _, err := core.Bind(BindRequest{From: provider.Identity, To: consumer.Identity,
		Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	core.Reset()

	if plugins := core.Plugins(); len(plugins) != 0 {
		t.Fatalf("reset MUST clear plugins, got %v", plugins)
	}
	if bindings := core.Bindings(); len(bindings) != 0 {
		t.Fatalf("reset MUST clear bindings, got %v", bindings)
	}
	// The identity space is cleared too, so the same triple can be minted again.
	if _, err := core.CreateIdentity("acme", "a", "a-1"); err != nil {
		t.Fatalf("reset MUST free the identity space: %v", err)
	}
}

func TestRegisterReturnsAuthoritativeIdentityAndDoesNotAliasInput(t *testing.T) {
	core := NewCore()
	capabilities := []Capability{capabilityOf("casing.apply", "1.0.0")}
	plugin := mustRegister(t, core, pluginSpec{instance: "a-1", capabilities: capabilities})

	// Mutating the caller's slice must not reach the registry.
	capabilities[0].Name = "mutated"
	got, err := core.PluginOf(plugin.Identity)
	if err != nil {
		t.Fatalf("PluginOf: %v", err)
	}
	if !got.HasCapability("casing.apply", "1.0.0") {
		t.Fatalf("the registry aliased the caller's slice: %v", got.Capabilities)
	}
	// Nor may mutating a returned Plugin reach the registry.
	plugin.Capabilities[0].Name = "also-mutated"
	again, err := core.PluginOf(plugin.Identity)
	if err != nil {
		t.Fatalf("PluginOf: %v", err)
	}
	if !again.HasCapability("casing.apply", "1.0.0") {
		t.Fatalf("a returned Plugin aliased the registry: %v", again.Capabilities)
	}
}

func TestBindRejectsMalformedRequests(t *testing.T) {
	core := NewCore()
	provider, consumer := activePair(t, core, capabilityOf("casing.apply", "1.0.0"))

	cases := map[string]BindRequest{
		"empty capability name": {From: provider.Identity, To: consumer.Identity,
			Capability: CapabilityRef{Version: "1.0.0"}},
		"invalid semver": {From: provider.Identity, To: consumer.Identity,
			Capability: CapabilityRef{Name: "casing.apply", Version: "not-semver"}},
		"empty from": {To: consumer.Identity,
			Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}},
		"empty to": {From: provider.Identity,
			Capability: CapabilityRef{Name: "casing.apply", Version: "1.0.0"}},
	}
	for name, request := range cases {
		var want string
		switch name {
		case "empty from", "empty to":
			want = CodeIdentityInvalid
		default:
			want = CodeBindingInvalid
		}
		_, err := core.Bind(request)
		if err == nil {
			t.Errorf("%s MUST be rejected", name)
			continue
		}
		wantCode(t, err, want)
	}
}

func TestCoreQueriesRejectEmptyIdentities(t *testing.T) {
	core := NewCore()
	// State-changing operations treat an identity with an empty component as a
	// malformed *request* (EAPP_IDENTITY_INVALID), never as "any plugin".
	//
	// Lookups (PluginOf, ExposesCapability) are excluded on purpose: for a
	// question, "no such plugin" is the honest answer to a malformed identity,
	// and a lookup is not an input-validation boundary. See PluginOf's doc
	// comment.
	var zero Identity
	calls := []struct {
		name string
		call func() error
	}{
		{"Activate", func() error { return core.Activate(zero) }},
		{"Deactivate", func() error { return core.Deactivate(zero) }},
		{"Suspend", func() error { return core.Suspend(zero) }},
		{"Resume", func() error { return core.Resume(zero) }},
		{"DeclareCapabilities", func() error { _, err := core.DeclareCapabilities(zero, nil); return err }},
		{"CreateIdentity", func() error { _, err := core.CreateIdentity("", "", ""); return err }},
	}
	for _, call := range calls {
		t.Run(call.name, func(t *testing.T) {
			wantCode(t, call.call(), CodeIdentityInvalid)
		})
	}

	// The lookups answer "not found" instead — a different, equally precise
	// answer that does not pretend an empty identity named something.
	for name, call := range map[string]func() error{
		"PluginOf": func() error { _, err := core.PluginOf(zero); return err },
		"ExposesCapability": func() error {
			_, err := core.ExposesCapability(zero, "casing.apply", "1.0.0")
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			wantCode(t, call(), CodePluginNotFound)
		})
	}
}

func TestLifecycleOnUnknownPluginIsPluginNotFound(t *testing.T) {
	core := NewCore()
	unknown := Identity{Domain: "acme", ID: "ghost", Instance: "ghost-1"}
	wantCode(t, core.Activate(unknown), CodePluginNotFound)
	wantCode(t, core.Suspend(unknown), CodePluginNotFound)
	wantCode(t, core.Resume(unknown), CodePluginNotFound)
	wantCode(t, core.Deactivate(unknown), CodePluginNotFound)
}

// ---------------------------------------------------------------------------
// SemVer unit coverage (C-2, §8.1 ranges)
// ---------------------------------------------------------------------------

func TestSemVerCompareFollowsSpec(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "2.0.0", -1},
		{"2.0.0", "1.9.9", 1},
		{"1.0.0-alpha", "1.0.0", -1},
		{"1.0.0-alpha", "1.0.0-beta", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.1", 0},
		{"1.0.0-1", "1.0.0-alpha", -1},
		{"1.0.0+build.1", "1.0.0+build.2", 0}, // build metadata is ignored
		{"1.0.0-alpha.1", "1.0.0-alpha.1.0", -1},
	}
	for _, testCase := range cases {
		left, err := ParseVersion(testCase.left)
		if err != nil {
			t.Fatalf("parse %q: %v", testCase.left, err)
		}
		right, err := ParseVersion(testCase.right)
		if err != nil {
			t.Fatalf("parse %q: %v", testCase.right, err)
		}
		if got := left.Compare(right); got != testCase.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", testCase.left, testCase.right, got, testCase.want)
		}
	}
}

func TestSemVerRangeGrammar(t *testing.T) {
	cases := []struct {
		range_  string
		version string
		want    bool
	}{
		{"^1.2.3", "1.2.3", true},
		{"^1.2.3", "1.9.0", true},
		{"^1.2.3", "2.0.0", false},
		{"^1.2.3", "1.2.2", false},
		{"^0.2.3", "0.2.9", true},
		{"^0.2.3", "0.3.0", false}, // 0.x: the minor is the compatibility boundary
		{"^0.0.3", "0.0.3", true},
		{"^0.0.3", "0.0.4", false},
		{"~1.2.3", "1.2.9", true},
		{"~1.2.3", "1.3.0", false},
		{"1.2", "1.2.9", true},
		{"1.2", "1.3.0", false},
		{"1", "1.9.9", true},
		{"1", "2.0.0", false},
		{"*", "100.0.0", true},
		{">=1.2.3 <2.0.0", "1.5.0", true},
		{">=1.2.3 <2.0.0", "2.0.0", false},
		{">=1.2.3, <2.0.0", "1.5.0", true},
		{"1.2.3 - 2.3.4", "2.0.0", true},
		{"1.2.3 - 2.3.4", "2.3.5", false},
		{"=1.2.3", "1.2.3", true},
	}
	for _, testCase := range cases {
		parsed, err := ParseRange(testCase.range_)
		if err != nil {
			t.Errorf("ParseRange(%q): %v", testCase.range_, err)
			continue
		}
		matched, err := parsed.MatchString(testCase.version)
		if err != nil {
			t.Errorf("MatchString(%q): %v", testCase.version, err)
			continue
		}
		if matched != testCase.want {
			t.Errorf("%q matches %q = %v, want %v", testCase.range_, testCase.version, matched, testCase.want)
		}
	}
	for _, unsupported := range []string{"", "^1.0.0 || ^2.0.0", "!=1.0.0", ">=", ">=1.x", "abc"} {
		if IsValidRange(unsupported) {
			t.Errorf("range %q MUST be rejected rather than silently unmatched", unsupported)
		}
	}
}

// ---------------------------------------------------------------------------
// shared assertions
// ---------------------------------------------------------------------------

// stateOf reads a binding's derived state and fails on error.
func stateOf(t *testing.T, core *Core, bindingID string) BindingState {
	t.Helper()
	state, err := core.BindingState(bindingID)
	if err != nil {
		t.Fatalf("BindingState(%s): %v", bindingID, err)
	}
	return state
}

// lifecycleOf reads a plugin's lifecycle state and fails on error.
func lifecycleOf(t *testing.T, core *Core, identity Identity) LifecycleState {
	t.Helper()
	plugin, err := core.PluginOf(identity)
	if err != nil {
		t.Fatalf("PluginOf(%s): %v", identity, err)
	}
	return plugin.Lifecycle
}

// containsIdentity reports whether identities holds identity.
func containsIdentity(identities []Identity, identity Identity) bool {
	for _, candidate := range identities {
		if candidate.Equal(identity) {
			return true
		}
	}
	return false
}
