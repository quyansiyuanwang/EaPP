package eapp

import (
	"sort"
	"strings"
)

// Criteria filters discovery results (§8.1).
//
// Every field is optional; an empty Criteria matches every plugin in scope.
type Criteria struct {
	// Capability is the capability name to match (exact, case-sensitive).
	Capability string `json:"capability,omitempty"`
	// Version is a SemVer *range*, not a version (§8.1). An exact version is
	// also a valid range, so both readings work; an unsupported range is
	// rejected rather than silently matching nothing (errata E-E).
	Version string `json:"version,omitempty"`
	// Constraints are matched exactly against the offered capability's
	// constraints (C-7). All of them must match — see constraintSetMatches.
	Constraints []Constraint `json:"constraints,omitempty"`
	// Identity is a partial identity filter. An absent field means "any"; an
	// empty string is treated the same way, because the wire form cannot
	// distinguish an omitted member from an empty one for a string field and
	// guessing otherwise would make the filter non-portable.
	Identity PartialIdentity `json:"identity,omitempty"`
}

// PartialIdentity is the `Partial<Identity>` of §8.1.
//
// It is a distinct type from Identity on purpose: Identity is the frozen
// three-field record whose completeness is checked by ID-1…ID-3, whereas this
// is a query that is *allowed* to be incomplete. Reusing Identity would mean
// every discovery query had to invent two of its three fields.
type PartialIdentity struct {
	Domain   string `json:"domain,omitempty"`
	ID       string `json:"id,omitempty"`
	Instance string `json:"instance,omitempty"`
}

// Matches reports whether a full identity satisfies the partial filter.
func (p PartialIdentity) Matches(id Identity) bool {
	if p.Domain != "" && p.Domain != id.Domain {
		return false
	}
	if p.ID != "" && p.ID != id.ID {
		return false
	}
	if p.Instance != "" && p.Instance != id.Instance {
		return false
	}
	return true
}

// IsZero reports whether the filter constrains nothing.
func (p PartialIdentity) IsZero() bool {
	return p.Domain == "" && p.ID == "" && p.Instance == ""
}

// DiscoveryScope narrows a discovery query (§8.1).
//
// D-7 is the invariant that matters here: trust levels are a *classification*
// (L0 / L1 / L2), NOT an ordered authorization ladder. Nothing in this package
// compares two levels with < or >, and no code path derives "L2 may see L1"
// from the level values — visibility comes exclusively from the injected
// VisibilityPolicy, so an implementation cannot accidentally turn a taxonomy
// into a ranking.
type DiscoveryScope struct {
	// TrustLevel is one of L0, L1, L2; empty means "any".
	TrustLevel string `json:"trustLevel,omitempty"`
	// TrustDomain is a deployment/trust domain string; empty means "any".
	TrustDomain string `json:"trustDomain,omitempty"`
}

// Trust level constants. They are opaque labels: the ordering of these
// declarations carries no meaning.
const (
	TrustLevelL0 = "L0"
	TrustLevelL1 = "L1"
	TrustLevelL2 = "L2"
)

// Valid reports whether the scope is well formed (finite enum + string domain).
func (s DiscoveryScope) Valid() error {
	switch s.TrustLevel {
	case "", TrustLevelL0, TrustLevelL1, TrustLevelL2:
		return nil
	default:
		return errDiscoveryScopeInvalid("trustLevel %q MUST be one of L0, L1, L2 (D-7)", s.TrustLevel)
	}
}

// String renders the scope for diagnostics.
func (s DiscoveryScope) String() string {
	level := s.TrustLevel
	if level == "" {
		level = "*"
	}
	domain := s.TrustDomain
	if domain == "" {
		domain = "*"
	}
	return level + "/" + domain
}

// VisibilityPolicy answers "may a plugin be seen through this scope?".
//
// The Composition Core does not put trust metadata on a Plugin: §5.1 freezes
// Plugin to {identity, capabilities, lifecycle} and §8.2 says trust level is a
// deployment classification, not a plugin attribute. So the Core cannot compute
// visibility on its own without inventing a field the spec does not define.
// Injecting the policy keeps D-1/D-2 enforceable (find and watch consult the
// same function) while leaving the metadata question to the deployment, which
// is where the spec leaves it.
type VisibilityPolicy interface {
	// Visible reports whether plugin is visible through scope.
	Visible(plugin Plugin, scope DiscoveryScope) bool
}

// VisibilityFunc adapts a function to VisibilityPolicy.
type VisibilityFunc func(plugin Plugin, scope DiscoveryScope) bool

// Visible implements VisibilityPolicy.
func (f VisibilityFunc) Visible(plugin Plugin, scope DiscoveryScope) bool { return f(plugin, scope) }

// openVisibility is the default policy: every plugin is visible in every scope.
//
// It is the only default that does not fabricate a rule. A Core with no trust
// metadata will report every plugin for any scope — including a scope naming a
// trust level that nothing is tagged with — which is honest ("this deployment
// declares no trust boundaries") and lets D-1/D-2 be tested by injecting a
// policy that does restrict things.
func openVisibility() VisibilityPolicy {
	return VisibilityFunc(func(Plugin, DiscoveryScope) bool { return true })
}

// EventType is the frozen DiscoveryEvent.type of D-6.
type EventType string

const (
	// EventAdded fires when a plugin becomes visible in a scope.
	EventAdded EventType = "added"
	// EventRemoved fires when a plugin stops being visible in a scope.
	EventRemoved EventType = "removed"
	// EventChanged fires when a visible plugin's capabilities change (P-4).
	EventChanged EventType = "changed"
)

// Valid reports whether t is one of added / removed / changed (D-6).
func (t EventType) Valid() bool {
	switch t {
	case EventAdded, EventRemoved, EventChanged:
		return true
	default:
		return false
	}
}

// DiscoveryEvent is what a watcher receives (§8.1).
type DiscoveryEvent struct {
	Type   EventType `json:"type"`
	Plugin Identity  `json:"plugin"`
}

// matchesCriteria reports whether a plugin satisfies a criteria set.
//
// Semantics worth stating:
//   - A capability name is required for the capability/version/constraints
//     clauses to mean anything; without it, a version filter would have to
//     apply "some capability", which makes the result order-dependent and
//     therefore unstable.
//   - Any one capability may satisfy the whole clause. A plugin that exposes
//     `casing.apply@1.0.0` and `casing.apply@2.0.0` and is queried for
//     `version:"^1.0.0"` matches through the first, and MUST be reported once.
func matchesCriteria(plugin Plugin, criteria Criteria, rangeCache map[string]*SemverRange) (bool, error) {
	if !criteria.Identity.Matches(plugin.Identity) {
		return false, nil
	}
	if criteria.Capability == "" {
		// No capability clause: constraints/version cannot be evaluated against
		// a specific capability, so they are ignored rather than guessed at.
		return true, nil
	}

	var versionRange *SemverRange
	if strings.TrimSpace(criteria.Version) != "" {
		cached, ok := rangeCache[criteria.Version]
		if !ok {
			parsed, err := ParseRange(criteria.Version)
			if err != nil {
				// Explicit rejection, never a silent empty result (errata E-E).
				return false, errDiscoveryScopeInvalid("criteria.version is not a supported SemVer range: %v", err)
			}
			cached = &parsed
			rangeCache[criteria.Version] = cached
		}
		versionRange = cached
	}

	for _, capability := range plugin.Capabilities {
		if capability.Name != criteria.Capability {
			continue
		}
		if versionRange != nil {
			offered, err := ParseVersion(capability.Version)
			if err != nil {
				// Unreachable while registration enforces C-2, so this only
				// fires if a registry invariant was broken. Treating the
				// candidate as non-matching is safer than failing the whole
				// query; the point of the branch is that a malformed version is
				// never silently treated as a *match*.
				continue
			}
			if !versionRange.Match(offered) {
				continue
			}
		}
		if !constraintSetMatches(criteria.Constraints, capability.Constraints) {
			continue
		}
		return true, nil
	}
	return false, nil
}

// Find implements the `find` primitive (§8.1): the plugins visible in scope
// that satisfy criteria.
//
// D-1 requires only plugins inside the current trust scope; the scope is
// resolved through the Core's VisibilityPolicy, so `find` and `watch` cannot
// disagree about visibility (the alternative — filtering inside Find — would let
// a watcher fire for a plugin Find refuses to report).
//
// D-3 is why the result is a plain list and nothing more: discovery proves
// *visibility*, never composability. A plugin returned here still has to pass
// every Bind check, which is why `find` performs none of them.
//
// D-4 allows caching with an invalidation policy. This implementation caches
// nothing: the graph is in memory, a scan is O(plugins), and a cache would need
// an invalidation hook on every mutation — a bug surface with no payoff. The
// per-call SemVer-range cache below is not a discovery cache (it holds parsed
// grammar, not results, and cannot go stale).
//
// D-5 is respected by omission: this function has no side effects on bindings.
func (c *Core) Find(criteria Criteria, scope DiscoveryScope) ([]Identity, error) {
	if err := scope.Valid(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	rangeCache := make(map[string]*SemverRange)
	out := make([]Identity, 0, len(c.plugins))
	for _, record := range c.plugins {
		plugin := record.snapshot()
		if !c.visibility.Visible(plugin, scope) {
			continue // D-1
		}
		matched, err := matchesCriteria(plugin, criteria, rangeCache)
		if err != nil {
			return nil, err
		}
		if matched {
			out = append(out, record.identity)
		}
	}
	sort.Slice(out, func(i, j int) bool { return lessIdentity(out[i], out[j]) })
	return out, nil
}

// Watch implements the `watch` primitive (§8.1): it returns a handle and a
// channel of events for plugins that enter the interest set.
//
// The channel is buffered and delivery is non-blocking (see emitLocked), so a
// slow reader degrades to dropped notifications rather than stalling the
// composition operations that produce them. That is consistent with D-3/D-4:
// discovery is a hint, and a watcher that misses an event can always call Find.
//
// The channel is closed by Unwatch and by Reset. A caller MUST NOT assume it
// stays open, and MUST NOT be surprised by a `removed` event it never asked to
// stop — that is exactly what D-6's `removed` type is for.
func (c *Core) Watch(criteria Criteria, scope DiscoveryScope) (int64, <-chan DiscoveryEvent, error) {
	if err := scope.Valid(); err != nil {
		return 0, nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	c.watchSeq++
	watcher := &watcher{
		id:       c.watchSeq,
		criteria: criteria,
		scope:    scope,
		events:   make(chan DiscoveryEvent, watchBufferSize),
	}
	c.watches[watcher.id] = watcher
	return watcher.id, watcher.events, nil
}

// watchBufferSize bounds a watcher's queue. 64 is far more than any
// control-plane burst observed by the conformance driver; the point of the
// bound is that it exists, so a wedged consumer cannot grow the process without
// limit.
const watchBufferSize = 64

// Unwatch stops a watcher and closes its channel.
//
// Idempotent, like every other operator that removes something: unwatching an
// unknown handle is a no-op, because "that watcher is not running" is already
// true. (Contrast Unbind, where an unknown handle is EAPP_BINDING_INVALID: there
// the caller named a *binding*, and a binding that has never existed is a
// mistake worth reporting. A watcher id is a local subscription handle the
// driver mints, so there is no such thing as naming a nonexistent binding.)
func (c *Core) Unwatch(watchID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	watcher, present := c.watches[watchID]
	if !present {
		return
	}
	delete(c.watches, watchID)
	watcher.closed = true
	close(watcher.events)
}

// WatchExists reports whether a watcher handle is still live. The driver uses
// it to answer `discovery.watch` without retaining channels of its own.
func (c *Core) WatchExists(watchID int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, present := c.watches[watchID]
	return present
}

// watcher is a live discovery subscription (D-2).
type watcher struct {
	id       int64
	criteria Criteria
	scope    DiscoveryScope
	events   chan DiscoveryEvent
	closed   bool
}

// emitLocked delivers an event to every watcher whose criteria and scope accept
// it (D-2). c.mu MUST be held.
//
// Delivery is non-blocking: a watcher whose buffer is full loses the event
// rather than stalling the mutation that produced it. The Core defines no
// delivery guarantee — that is Delivery semantics, an explicit non-goal (§1.2,
// §20.1) — and blocking here would let a slow subscriber deadlock the operation
// that registers or deactivates a plugin, a far worse failure than a dropped
// notification a watcher can recover from by calling Find.
func (c *Core) emitLocked(event DiscoveryEvent) {
	for _, watcher := range c.watches {
		if watcher.closed {
			continue
		}
		record, present := c.plugins[identityTriple(event.Plugin)]
		if !present {
			continue
		}
		plugin := record.snapshot()
		if !c.visibility.Visible(plugin, watcher.scope) {
			continue // D-2: only events inside the watcher's scope
		}
		rangeCache := make(map[string]*SemverRange)
		matched, err := matchesCriteria(plugin, watcher.criteria, rangeCache)
		if err != nil || !matched {
			continue
		}
		select {
		case watcher.events <- event:
		default:
			// Buffer full: drop. See the doc comment above.
		}
	}
}
