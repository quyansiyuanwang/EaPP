package eapp

// LifecycleState is the Core lifecycle state of §7.1.
//
// The three Core states are frozen. §7.1 permits an implementation to extend
// them (STARTING / STOPPING / DRAINING / FAILED) but requires the Core semantics
// to survive; this implementation defines no extension state, because none of
// the eight Composition/Lifecycle primitives needs one and an unused state is
// just a place for the Core semantics to drift.
type LifecycleState string

const (
	// LifecycleInactive is the state a plugin starts in: it has an Identity and
	// may hold Bindings, but it is not part of the active composition.
	LifecycleInactive LifecycleState = "INACTIVE"
	// LifecycleActive is the only state in which a plugin's bindings can derive
	// to ACTIVE (§6.4).
	LifecycleActive LifecycleState = "ACTIVE"
	// LifecycleSuspended means the plugin keeps its Identity and Bindings but no
	// longer participates in the active composition (§7.5).
	LifecycleSuspended LifecycleState = "SUSPENDED"
)

// String returns the frozen wire name of the state.
func (s LifecycleState) String() string { return string(s) }

// Valid reports whether s is one of the three Core states.
func (s LifecycleState) Valid() bool {
	switch s {
	case LifecycleInactive, LifecycleActive, LifecycleSuspended:
		return true
	default:
		return false
	}
}

// ParseLifecycleState converts a wire string into a LifecycleState.
//
// An unknown state is EAPP_LIFECYCLE_INVALID rather than a silently-accepted
// zero value: accepting "ACTIVE " or "running" would let a caller believe a
// plugin participates in composition when the Core does not recognise the state
// at all.
func ParseLifecycleState(text string) (LifecycleState, error) {
	state := LifecycleState(text)
	if !state.Valid() {
		return "", errLifecycleInvalid("lifecycle state MUST be one of INACTIVE, ACTIVE, SUSPENDED; got %q", text)
	}
	return state, nil
}

// lifecycleTransition names the four Core transitions so the rules can be
// stated once, in a table, and read like §7.3.
type lifecycleTransition struct {
	// from lists the legal source states. A source outside the list is
	// EAPP_LIFECYCLE_INVALID (§7.3).
	from []LifecycleState
	// to is the resulting state.
	to LifecycleState
	// idempotentOn lists states from which the operation succeeds and changes
	// nothing. This is how O-5 is satisfied without weakening L-1/L-6.
	idempotentOn []LifecycleState
}

// The transition table of §7.3, verbatim:
//
//	activate    INACTIVE only          -> ACTIVE
//	deactivate  ACTIVE/SUSPENDED/INACTIVE -> INACTIVE
//	suspend     ACTIVE only            -> SUSPENDED
//	resume      SUSPENDED only         -> ACTIVE
//
// activate/idempotentOn is the interesting entry. L-6 says "activate applies
// only to INACTIVE" and O-5 says "activate MUST be idempotent". An already
// ACTIVE plugin is therefore *not* a legal source (it is not INACTIVE) but the
// operation MUST still succeed and leave the state ACTIVE. Splitting "legal
// source" from "accepted-and-unchanged" states is the only way to honour both
// invariants at once; treating ACTIVE as a legal source would make
// EAPP_LIFECYCLE_INVALID unreachable for activate, and treating it as a failure
// would violate O-5.
//
// SUSPENDED is deliberately NOT in idempotentOn for activate: §7.3 and §14
// answer 8 are explicit that a suspended plugin MUST be resumed, not activated.
var lifecycleTransitions = map[string]lifecycleTransition{
	"activate": {
		from:         []LifecycleState{LifecycleInactive},
		to:           LifecycleActive,
		idempotentOn: []LifecycleState{LifecycleActive},
	},
	"deactivate": {
		from: []LifecycleState{LifecycleInactive, LifecycleActive, LifecycleSuspended},
		to:   LifecycleInactive,
		// deactivate is idempotent on INACTIVE as a consequence of L-2
		// ("any -> INACTIVE"), which includes INACTIVE itself (§7.2).
		idempotentOn: []LifecycleState{LifecycleInactive},
	},
	"suspend": {
		from: []LifecycleState{LifecycleActive},
		to:   LifecycleSuspended,
	},
	"resume": {
		from: []LifecycleState{LifecycleSuspended},
		to:   LifecycleActive,
	},
}

// applyTransition computes the next state for an operation.
//
// It returns the resulting state (which may equal the current one, see the
// idempotent cases above). An illegal source state is EAPP_LIFECYCLE_INVALID.
func applyTransition(op string, current LifecycleState) (LifecycleState, error) {
	transition, ok := lifecycleTransitions[op]
	if !ok {
		// Unreachable through the exported API; kept so a future operation
		// cannot silently inherit some other operation's rules.
		return current, errLifecycleInvalid("unknown lifecycle operation %q", op)
	}
	for _, state := range transition.idempotentOn {
		if current == state {
			// Accepted, no change: this is what makes activate idempotent
			// (O-5) without making ACTIVE a legal *source* for activate (L-6).
			return current, nil
		}
	}
	for _, state := range transition.from {
		if current == state {
			return transition.to, nil
		}
	}
	return current, errLifecycleInvalid(
		"%s applies only to %s; plugin is %s (L-1, L-3, L-4, L-6)", op, legalSources(transition), current)
}

// legalSources renders the legal source states for an error message.
func legalSources(transition lifecycleTransition) string {
	switch len(transition.from) {
	case 0:
		return "no state"
	case 1:
		return string(transition.from[0])
	default:
		out := ""
		for i, state := range transition.from {
			if i > 0 {
				out += "/"
			}
			out += string(state)
		}
		return out
	}
}

// Activate applies the `activate` primitive (§7.3): INACTIVE -> ACTIVE.
//
// Idempotent (O-5): activating an ACTIVE plugin succeeds and changes nothing.
// Activating a SUSPENDED plugin is EAPP_LIFECYCLE_INVALID — L-6 and §14's
// answer 8 both forbid using `activate` to leave SUSPENDED, and `resume` is the
// only way back.
//
// A plugin becoming ACTIVE can make its bindings ACTIVE again. Nothing has to
// be repaired for that: the binding state is derived on read (B-3), so the
// mutation of this one record *is* the re-derivation.
func (c *Core) Activate(identity Identity) error {
	return c.lifecycle("activate", identity)
}

// Deactivate applies the `deactivate` primitive (§7.3): any state -> INACTIVE.
//
// It never closes a binding: §7.4 says deactivate MUST NOT directly CLOSE
// bindings, and §14's answer 7 confirms that deactivate and suspend both merely
// make bindings derive to DORMANT. The bindings survive, which is what lets a
// later `activate` bring them back with no re-bind (O-6).
func (c *Core) Deactivate(identity Identity) error {
	return c.lifecycle("deactivate", identity)
}

// Suspend applies the `suspend` primitive (§7.3): ACTIVE -> SUSPENDED.
//
// L-5 is decisive: SUSPENDED MUST NOT unbind. Suspending keeps the identity and
// every binding and only removes the plugin from the active composition (§7.5),
// so its bindings read DORMANT — never CLOSED (O-7).
func (c *Core) Suspend(identity Identity) error {
	return c.lifecycle("suspend", identity)
}

// Resume applies the `resume` primitive (§7.3): SUSPENDED -> ACTIVE.
//
// O-8: resuming re-evaluates every binding. Here that is automatic — the state
// is derived at read time — but a binding whose *other* endpoint is still
// INACTIVE or SUSPENDED correctly stays DORMANT, which is the part a naive
// "resume sets bindings ACTIVE" implementation gets wrong.
func (c *Core) Resume(identity Identity) error {
	return c.lifecycle("resume", identity)
}

// lifecycle implements the four §7.3 primitives through the one transition
// table, so the rules exist in exactly one place.
func (c *Core) lifecycle(op string, identity Identity) error {
	if err := identity.Validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	record, present := c.plugins[identityTriple(identity)]
	if !present {
		// A lifecycle operation on a plugin that does not exist is
		// EAPP_PLUGIN_NOT_FOUND, not a lifecycle error: the transition rules
		// only make sense for an existing plugin, and reporting
		// EAPP_LIFECYCLE_INVALID would suggest a state problem where there is
		// no entity at all.
		return errPluginNotFound("no plugin registered with identity %s", identity)
	}

	next, err := applyTransition(op, record.lifecycle)
	if err != nil {
		return err
	}

	// §7.4 / O-6 / O-7 / O-8: entering INACTIVE or SUSPENDED must make this
	// plugin's bindings DORMANT, and recovering must re-derive them. There is
	// no stored binding state, so the line below *is* the whole of that rule:
	// deriveBindingState reads this record, and every subsequent read of every
	// binding that names this plugin sees the new value. No list of affected
	// bindings is maintained, because maintaining one is precisely how an
	// implementation ends up with a binding that reads ACTIVE after its plugin
	// was suspended.
	record.lifecycle = next
	return nil
}
