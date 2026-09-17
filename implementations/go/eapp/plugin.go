package eapp

// Plugin is a composable entity (§5.1): an Identity, an optionally-empty set of
// capabilities, and a lifecycle state.
//
// §5.2 is emphatic that a plugin may be an in-process module, a process, a
// worker, a remote service, a device, a database, an AI model, a UI component,
// or another plugin system. Nothing in this type therefore describes *how* a
// plugin is hosted or reached — that is what keeps the Composition Core
// independent of the layers above it.
type Plugin struct {
	// Identity is the plugin's identity. It MUST NOT change during the
	// plugin's life (P-3, ID-4); Core never mutates this field after
	// registration, which is how P-3 is enforced structurally rather than by
	// discipline.
	Identity Identity `json:"identity"`
	// Capabilities MAY be empty (P-2) and MAY change during the lifecycle via
	// an explicit declaration (P-4).
	Capabilities []Capability `json:"capabilities"`
	// Lifecycle is the plugin's participation state (§7.1).
	Lifecycle LifecycleState `json:"lifecycle"`
}

// HasCapability reports whether the plugin currently exposes name@version.
//
// This is the predicate behind B-2 ("capability MUST be exposed by from") and
// behind the "from 仍暴露 capability" clause of §6.4 — the two places where a
// binding's fate depends on the capability set.
func (p Plugin) HasCapability(name, version string) bool {
	for _, c := range p.Capabilities {
		// Version is compared as text, not by SemVer precedence: C-6 makes the
		// version *string* part of the binding identity, so `1.0.0` and `1.0.0+b`
		// are two different capabilities even though SemVer ranks them equal.
		if c.Name == name && c.Version == version {
			return true
		}
	}
	return false
}

// FindCapability returns the first capability matching name@version.
func (p Plugin) FindCapability(name, version string) (Capability, bool) {
	for _, c := range p.Capabilities {
		if c.Name == name && c.Version == version {
			return c, true
		}
	}
	return Capability{}, false
}
