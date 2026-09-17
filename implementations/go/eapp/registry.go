package eapp

import (
	"fmt"
	"sort"
)

// identityTripleKey is the registry key for an identity.
//
// ID-3 scopes `instance` uniqueness to (domain, id), which makes the *full*
// triple the natural key: two identities differing in any component are two
// identities, and the zero-length components are impossible because Validate
// rejects them before a key is ever built.
type identityTripleKey [3]string

// identityTriple reduces an identity to its registry key.
func identityTriple(id Identity) identityTripleKey {
	return identityTripleKey{id.Domain, id.ID, id.Instance}
}

// pluginRecord is the mutable registry entry for a plugin.
//
// It is separate from the exported Plugin value so that mutating the lifecycle
// or the capability set cannot be done through a value a caller is holding:
// callers always receive copies, and the registry stays the single source of
// truth (§6.4's derivation reads *this* record).
type pluginRecord struct {
	identity     Identity
	capabilities []Capability
	lifecycle    LifecycleState
}

// hasCapability reports whether the plugin exposes name@version.
func (p *pluginRecord) hasCapability(name, version string) bool {
	for _, c := range p.capabilities {
		// Version is compared as text, never by SemVer precedence: C-6 makes
		// the version *string* part of the binding identity, so `1.0.0` and
		// `1.0.0+build` denote two different capabilities even though SemVer
		// ranks them equal.
		if c.Name == name && c.Version == version {
			return true
		}
	}
	return false
}

// snapshot renders the record as the exported Plugin value.
//
// The capability slice is copied because P-4 allows the set to change: a caller
// holding a Plugin from an earlier call must not observe a later change through
// an aliased slice.
func (p *pluginRecord) snapshot() Plugin {
	capabilities := make([]Capability, len(p.capabilities))
	copy(capabilities, p.capabilities)
	return Plugin{Identity: p.identity, Capabilities: capabilities, Lifecycle: p.lifecycle}
}

// MintInstance issues a fresh `instance` for (domain, id).
//
// ID-5 is why this is a runtime facility: "Identity MUST NOT be self-issued by
// the plugin". A caller may *supply* an instance (the driver allows it), but
// when it does not, the runtime is the only source of the value — and the
// identity returned by CreateIdentity is the authoritative one.
//
// The shape "%s-%s-%d" is illustrative, not normative: only uniqueness matters
// (and the driver specifies nothing about the shape). Embedding domain and id
// makes a mismatch readable in logs.
func (c *Core) MintInstance(domain, id string) string {
	sequence := c.instanceSeq.Add(1)
	return fmt.Sprintf("%s-%s-%d", domain, id, sequence)
}

// CreateIdentity mints the authoritative Identity for the given coordinates,
// filling in `instance` when it is empty (ID-3, ID-5).
//
// The returned identity is registered as minted, so a second call with the same
// triple fails with EAPP_IDENTITY_DUPLICATE rather than issuing two identities
// that look identical (ID-3). Registering a *plugin* against the identity is a
// separate step (Register), which is what keeps P-1 ("every plugin MUST have a
// unique Identity") checkable at registration time.
func (c *Core) CreateIdentity(domain, id, instance string) (Identity, error) {
	if domain == "" {
		return Identity{}, errIdentityInvalid("identity.domain MUST NOT be empty (ID-1)")
	}
	if id == "" {
		return Identity{}, errIdentityInvalid("identity.id MUST NOT be empty (ID-2)")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	return c.createIdentityLocked(domain, id, instance)
}

// createIdentityLocked is CreateIdentity's body, callable with c.mu held.
func (c *Core) createIdentityLocked(domain, id, instance string) (Identity, error) {
	if instance == "" {
		instance = c.MintInstance(domain, id)
	}
	identity := Identity{Domain: domain, ID: id, Instance: instance}
	if err := identity.Validate(); err != nil {
		return Identity{}, err
	}
	triple := identityTriple(identity)
	if existing, present := c.identities[triple]; present {
		// ID-3: `instance` MUST be unique within (domain, id).
		return Identity{}, errIdentityDuplicate(
			"instance %q is already in use for (%s, %s) (ID-3)", existing.Instance, existing.Domain, existing.ID)
	}
	c.identities[triple] = identity
	return identity, nil
}

// EnsureIdentity returns the registered identity for the coordinates, minting
// one if it does not exist yet.
//
// This is registration's entry point: a plugin declares which identity it is,
// and the runtime answers with the authoritative identity. Re-declaring an
// identity the runtime already minted is a no-op rather than a duplicate error,
// because the plugin is *using* an identity the runtime owns (ID-5); the
// duplicate error belongs to registering two plugins with one identity (P-1),
// which Register checks separately.
func (c *Core) EnsureIdentity(domain, id, instance string) (Identity, error) {
	if domain == "" {
		return Identity{}, errIdentityInvalid("identity.domain MUST NOT be empty (ID-1)")
	}
	if id == "" {
		return Identity{}, errIdentityInvalid("identity.id MUST NOT be empty (ID-2)")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ensureIdentityLocked(domain, id, instance)
}

// ensureIdentityLocked is EnsureIdentity's body, callable with c.mu held.
func (c *Core) ensureIdentityLocked(domain, id, instance string) (Identity, error) {
	if instance != "" {
		if existing, present := c.identities[identityTripleKey{domain, id, instance}]; present {
			return existing, nil
		}
	}
	return c.createIdentityLocked(domain, id, instance)
}

// HasIdentity reports whether the identity was minted by this runtime.
//
// Registering a plugin requires a minted identity, which is how ID-5 is made
// observable; conversely a minted identity with no plugin is still "known", so
// this can be true while PluginOf reports EAPP_PLUGIN_NOT_FOUND.
func (c *Core) HasIdentity(identity Identity) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, present := c.identities[identityTriple(identity)]
	return present
}

// Register adds a plugin to the graph and returns its authoritative Plugin
// value (INACTIVE, §7.1).
//
// Identity handling — the runtime mints (ID-5):
//
//   - `identity.instance` empty: the runtime mints one, and the returned
//     Plugin.Identity is the value the caller MUST use from then on. Only
//     `domain` and `id` are required from the caller (ID-1, ID-2).
//   - `identity.instance` present: the instance is claimed for (domain, id).
//     Claiming an instance another plugin already holds is
//     EAPP_IDENTITY_DUPLICATE, because P-1 requires every plugin to have a
//     unique Identity and ID-3 scopes that uniqueness to (domain, id).
//
// Capability validation — each capability must satisfy C-1 (non-empty name) and
// C-2 (valid SemVer). A violation is rejected, not skipped: a plugin must never
// enter the graph exposing a capability that no query can address. P-2 makes an
// empty capability list legal.
//
// Re-registering an existing identity is EAPP_IDENTITY_DUPLICATE. Replacing a
// plugin is not one of §9's primitives, and doing it implicitly would silently
// destroy a node that live bindings point at.
func (c *Core) Register(identity Identity, capabilities []Capability) (Plugin, error) {
	// The instance is validated *after* minting, not before: a caller that
	// omits it is asking the runtime to mint one (ID-5), so an empty instance
	// is a request, not an invalid identity. Only domain and id are the
	// caller's obligation here.
	if identity.Domain == "" {
		return Plugin{}, errIdentityInvalid("identity.domain MUST NOT be empty (ID-1)")
	}
	if identity.ID == "" {
		return Plugin{}, errIdentityInvalid("identity.id MUST NOT be empty (ID-2)")
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	authoritative, err := c.ensureIdentityLocked(identity.Domain, identity.ID, identity.Instance)
	if err != nil {
		return Plugin{}, err
	}

	triple := identityTriple(authoritative)
	if _, present := c.plugins[triple]; present {
		return Plugin{}, errIdentityDuplicate("a plugin with identity %s is already registered (P-1)", authoritative)
	}

	validated := make([]Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		if err := capability.Valid(); err != nil {
			return Plugin{}, err
		}
		validated = append(validated, cloneCapability(capability))
	}

	record := &pluginRecord{identity: authoritative, capabilities: validated, lifecycle: LifecycleInactive}
	c.plugins[triple] = record
	plugin := record.snapshot()

	// A new plugin starts INACTIVE, so it cannot flip any binding to ACTIVE —
	// but it does become newly visible, which is D-6's `added` event.
	c.emitLocked(DiscoveryEvent{Type: EventAdded, Plugin: authoritative})
	return plugin, nil
}

// cloneCapability deep-copies the reference-typed parts of a Capability
// (constraints, contract schema) so that a caller mutating its own input after
// Register cannot reach into the registry.
func cloneCapability(capability Capability) Capability {
	out := capability
	if len(capability.Constraints) > 0 {
		out.Constraints = make([]Constraint, len(capability.Constraints))
		for i, constraint := range capability.Constraints {
			cloned := constraint
			if len(constraint.Value) > 0 {
				cloned.Value = append([]byte(nil), constraint.Value...)
			}
			out.Constraints[i] = cloned
		}
	}
	if capability.Contract != nil {
		contract := *capability.Contract
		if len(contract.Schema) > 0 {
			contract.Schema = append([]byte(nil), contract.Schema...)
		}
		out.Contract = &contract
	}
	return out
}

// PluginOf returns the plugin registered under identity.
//
// Failure is EAPP_PLUGIN_NOT_FOUND both for an identity that was never minted
// and for one that was minted but never registered: from a caller's point of
// view there is no plugin there, and distinguishing the two would leak the
// minting registry into the plugin API.
//
// The identity is *not* validated first, and that is deliberate. A lookup is not
// an input-validation boundary: asking about an identity that cannot exist has a
// perfectly good answer ("no such plugin"), whereas `Activate` and `Bind` are
// state-changing operations where a malformed identity is a caller error worth
// reporting as EAPP_IDENTITY_INVALID. Keeping the two apart means the same
// malformed input cannot produce two different codes depending on which method
// happened to be called.
func (c *Core) PluginOf(identity Identity) (Plugin, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pluginOfLocked(identity)
}

// pluginOfLocked is PluginOf's body, callable with c.mu held.
func (c *Core) pluginOfLocked(identity Identity) (Plugin, error) {
	record, present := c.plugins[identityTriple(identity)]
	if !present {
		return Plugin{}, errPluginNotFound("no plugin registered with identity %s (B-1)", identity)
	}
	return record.snapshot(), nil
}

// Plugins returns every registered plugin, ordered by (domain, id, instance).
//
// The order is fixed so two runs over the same graph produce identical output:
// Go randomises map iteration, and a harness comparing whole lists would
// otherwise flake on a correct implementation.
func (c *Core) Plugins() []Plugin {
	c.mu.Lock()
	defer c.mu.Unlock()
	records := make([]*pluginRecord, 0, len(c.plugins))
	for _, record := range c.plugins {
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		return lessIdentity(records[i].identity, records[j].identity)
	})
	out := make([]Plugin, 0, len(records))
	for _, record := range records {
		out = append(out, record.snapshot())
	}
	return out
}

// lessIdentity orders identities by (domain, id, instance).
func lessIdentity(a, b Identity) bool {
	if a.Domain != b.Domain {
		return a.Domain < b.Domain
	}
	if a.ID != b.ID {
		return a.ID < b.ID
	}
	return a.Instance < b.Instance
}

// ExposesCapability reports whether the plugin exposes name@version right now.
//
// This is the Core-side predicate behind B-2 and behind the "from still exposes
// the capability" clause of §6.4. Like PluginOf it is a pure lookup: an unknown
// identity is EAPP_PLUGIN_NOT_FOUND rather than a validation error, because
// "that plugin has no such capability" is the true answer for a plugin that does
// not exist.
func (c *Core) ExposesCapability(identity Identity, name, version string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	record, present := c.plugins[identityTriple(identity)]
	if !present {
		return false, errPluginNotFound("no plugin registered with identity %s", identity)
	}
	return record.hasCapability(name, version), nil
}

// DeclareCapabilities replaces a plugin's capability set (P-4).
//
// P-4 permits the set to change "via explicit declaration"; this is that
// declaration. It exists because P-4 and §6.4's third ACTIVE condition
// ("from 仍暴露 capability") are otherwise unobservable: without a way to
// withdraw a capability, no caller could ever exercise the DORMANT transition
// those rules describe.
//
// The transition rules of §6.6 then apply with no bookkeeping: a withdrawn
// capability makes every binding that named it read DORMANT, and re-declaring it
// makes them read ACTIVE again.
//
// Note what is *not* done: bindings are not closed, and no error is raised for
// bindings left without their capability. §6.6 says withdrawing a capability
// yields DORMANT, so closing them would contradict the spec's own table.
func (c *Core) DeclareCapabilities(identity Identity, capabilities []Capability) (Plugin, error) {
	if err := identity.Validate(); err != nil {
		return Plugin{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	record, present := c.plugins[identityTriple(identity)]
	if !present {
		return Plugin{}, errPluginNotFound("no plugin registered with identity %s", identity)
	}

	validated := make([]Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		if err := capability.Valid(); err != nil {
			return Plugin{}, err
		}
		validated = append(validated, cloneCapability(capability))
	}
	record.capabilities = validated
	return record.snapshot(), nil
}
