// Package eapp implements the EaPP v3.0.0 Composition Core.
//
// The normative source is docs/spec/v3.0.0-core.md; section references in this
// package (§x.y) and invariant ids (ID-1, B-3, …) point at that document. The
// package deliberately stops at the Composition Core boundary: it defines what
// may be composed, but nothing about how composed entities interact
// (Interaction Layer) or how those interactions are carried (Transport), per
// §1.3 and CH-1.
//
// The five frozen ontologies are Identity (§3), Capability (§4), Plugin (§5),
// Binding (§6) and Lifecycle (§7); Discovery (§8) is the set of operations over
// them. The operations are §9's eight control primitives plus registration,
// inspection and reset, which the conformance driver needs.
package eapp

import (
	"sync"
	"sync/atomic"
	"time"
)

// Core is an in-memory Composition Core: the plugin graph, its bindings, its
// discovery watchers, and the lifecycle of the plugins in it.
//
// Concurrency. Every exported method takes the single mutex for the whole
// operation. The invariants make this the right shape rather than a lazy one:
//
//   - B-8 requires the uniqueness check and the creation in Bind to be *one*
//     atomic step (§6.8). Per-entity locking would leave exactly the TOCTOU gap
//     the invariant names.
//   - A lifecycle transition must make every affected binding read correctly
//     (§7.4, O-6, O-7) at the instant it becomes visible; otherwise a concurrent
//     reader can observe a plugin that is already SUSPENDED while a binding
//     that depends on it still reads ACTIVE.
//   - Binding state is derived from the plugin registry (§6.4), so deriving it
//     requires the registry to be stable for the whole derivation.
//
// A single lock also serialises unrelated operations, which costs throughput no
// invariant cares about — this is a control plane, not a data plane. If a
// deployment ever needs more concurrency, the replacement is a graph-level
// read-write lock or a copy-on-write snapshot, not per-binding locks: the
// atomicity requirement spans the plugin registry and the binding registry
// *jointly*.
type Core struct {
	mu sync.Mutex

	// identities is the minted-identity registry. ID-3 scopes uniqueness of
	// `instance` to (domain, id), so the key is the full triple: minting the
	// same triple twice is EAPP_IDENTITY_DUPLICATE.
	identities map[identityTripleKey]Identity
	// plugins is keyed by the same triple. A plugin can only be registered
	// against an identity this runtime minted, which is how ID-5 (no
	// self-issued identities) becomes structural.
	plugins map[identityTripleKey]*pluginRecord
	// bindingsByID is the handle-indexed view of every binding ever created,
	// CLOSED ones included: unbind MUST be idempotent (O-4) and inspecting a
	// closed binding is legal, so closing must not delete the record.
	bindingsByID map[string]*binding
	// openByKey is the uniqueness domain of B-6: it holds only bindings that
	// are not CLOSED. Closing removes the entry, which is what makes a closed
	// triple bindable again while CLOSED itself stays terminal (B-4).
	openByKey map[string]*binding
	// watches are the live discovery watchers (D-1, D-2).
	watches map[int64]*watcher
	// visibility answers "may this plugin be seen through this scope?" (§8.2).
	visibility VisibilityPolicy
	// bindingSeq mints opaque binding handles. Monotonic and never reused, so a
	// stale handle can never address a different binding.
	bindingSeq atomic.Uint64
	// watchSeq mints watcher ids.
	watchSeq int64
	// instanceSeq mints `instance` values (ID-3, ID-5).
	instanceSeq atomic.Uint64
}

// NewCore creates an empty Composition Core.
//
// The identity minter is seeded from the wall clock so that two Cores in one
// process never mint overlapping instance names. ID-3 only requires uniqueness
// within (domain, id), but a cross-Core collision would be a genuinely
// confusing surprise when a caller merges two graphs.
func NewCore() *Core {
	core := &Core{
		identities:   make(map[identityTripleKey]Identity),
		plugins:      make(map[identityTripleKey]*pluginRecord),
		bindingsByID: make(map[string]*binding),
		openByKey:    make(map[string]*binding),
		watches:      make(map[int64]*watcher),
		visibility:   openVisibility(),
	}
	core.instanceSeq.Store(uint64(time.Now().UnixNano() % 1_000_000_000))
	return core
}

// SetVisibilityPolicy installs the trust-scope policy discovery consults.
//
// Nil restores the default (everything visible). See VisibilityPolicy for why
// this is injected rather than derived from Plugin.
func (c *Core) SetVisibilityPolicy(policy VisibilityPolicy) {
	if policy == nil {
		policy = openVisibility()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.visibility = policy
}

// Reset returns the Core to its initial state: no plugins, no bindings, no
// watchers.
//
// It exists for the conformance driver, whose `reset` operation has to give a
// harness a clean slate without restarting the process. It is *not* a
// composition primitive (§9 defines exactly eight), and it deliberately does
// not keep a tombstone of the cleared graph: unlike Unbind, nothing in the spec
// requires Reset to be a transition of an existing object.
func (c *Core) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.identities = make(map[identityTripleKey]Identity)
	c.plugins = make(map[identityTripleKey]*pluginRecord)
	c.bindingsByID = make(map[string]*binding)
	c.openByKey = make(map[string]*binding)
	for _, watcher := range c.watches {
		watcher.closed = true
		close(watcher.events)
	}
	c.watches = make(map[int64]*watcher)
	c.watchSeq = 0
	// Watcher ids restart with the graph, because the graph is what they address
	// and because a fresh driver and a reset driver must look identical from
	// outside. Binding handles deliberately do *not* restart (bindingSeq is left
	// alone): a binding handle that is already in someone's hand must never come
	// to mean a different binding.
}
