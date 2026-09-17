package eapp

import (
	"sort"
	"strconv"
	"strings"
)

// BindingState is the stable semantic state of a Binding (§6.2, §6.5):
//
//	ACTIVE   / DORMANT   for an OPEN binding
//	CLOSED               terminal
//
// PENDING appears in §6.2 as a permitted *internal* transaction state of bind(),
// but B-9 forbids it from ever being externally observable, so this package
// defines no constant for it. A constant that must never be returned is an
// invitation to return it.
type BindingState string

const (
	// BindingActive means the binding is OPEN and both ends participate: both
	// plugins are ACTIVE and `from` still exposes the capability (§6.4).
	BindingActive BindingState = "ACTIVE"
	// BindingDormant means the binding is OPEN but the ACTIVE conditions do not
	// hold — an endpoint is INACTIVE/SUSPENDED, or `from` no longer exposes the
	// capability (§6.4, §6.6, B-5).
	BindingDormant BindingState = "DORMANT"
	// BindingClosed means the binding was explicitly unbound. Terminal (B-4).
	BindingClosed BindingState = "CLOSED"
)

// IsOpen reports whether a state is the base property OPEN of §6.3, i.e. the
// binding has not been explicitly unbound.
//
// §6.3 is careful that OPEN is a *base property*, not a stable semantic state:
// it is the complement of CLOSED, and an OPEN binding is always either ACTIVE
// or DORMANT (§6.5). Keeping it a predicate over a *derived* state — rather
// than a field on Binding — preserves B-3 while still letting callers ask the
// question §6.3 defines.
func (s BindingState) IsOpen() bool { return s != BindingClosed }

// IsTerminal reports whether a state admits no further transition. Only CLOSED
// does (B-4).
func (s BindingState) IsTerminal() bool { return s == BindingClosed }

// Valid reports whether s is one of the three states §6.2 freezes.
func (s BindingState) Valid() bool {
	switch s {
	case BindingActive, BindingDormant, BindingClosed:
		return true
	default:
		return false
	}
}

// Binding is the relation between two plugins (§6.1):
//
//	{id, from, to, capability, contract?}
//
// **There is deliberately no `state` field.** B-3 requires the state to be
// derived and forbids it being set directly, and the only way to make "derived"
// a structural property rather than a promise is to have nowhere to store an
// assigned state. Core.BindingState recomputes it from (closed? ∧ from
// lifecycle ∧ to lifecycle ∧ capability still exposed) on every call, which is
// also what makes §6.6's "any of the above recovering" clause work with no
// invalidation logic and no repair step.
type Binding struct {
	// ID is an implementation-chosen handle (conformance/driver.md leaves its
	// shape free). It is opaque to callers: never parse it, never order by it.
	ID string `json:"id"`
	// From is the plugin that provides the capability.
	From Identity `json:"from"`
	// To is the plugin that consumes it.
	To Identity `json:"to"`
	// Capability names what composes. Its Plugin member always equals From
	// (B-7); Bind sets it by construction.
	Capability CapabilityRef `json:"capability"`
	// Contract is optional context, never required (C-3, §14 answer 3).
	Contract *ContractRef `json:"contract,omitempty"`
}

// binding is the registry record: the relation plus the single piece of mutable
// state the Core actually owns — whether the binding was explicitly unbound.
//
// Everything else about a binding's state lives in the plugin registry. Keeping
// `closed` here, and never clearing it, is what makes CLOSED terminal (B-4).
type binding struct {
	id         string
	from       Identity
	to         Identity
	capability CapabilityRef
	contract   *ContractRef
	closed     bool
}

// snapshot renders the registry record as a Binding value.
//
// The result shares no mutable state with the record: Capability and Contract
// are copied by value, so a caller that mutates the result cannot reach back
// into the registry.
func (b *binding) snapshot() Binding {
	out := Binding{
		ID:         b.id,
		From:       b.from,
		To:         b.to,
		Capability: b.capability,
	}
	if b.contract != nil {
		contract := *b.contract
		out.Contract = &contract
	}
	return out
}

// BindingKey is the uniqueness domain of B-6/B-8: (from, to, capability), with
// the capability including its version (C-6).
//
// Two binds that agree on all three components are the *same* binding for
// uniqueness purposes, however they were spelled.
//
// Capability.constraints are deliberately NOT part of the key. §6.8 defines
// uniqueness over `(from, to, capability)`, and §4.4 defines a capability
// *reference* as plugin + name + version — constraints are filtering context,
// not reference identity. Including them would let a caller create unbounded
// parallel bindings between the same two plugins by varying a constraint value,
// which is exactly what B-6 exists to prevent.
type BindingKey struct {
	from    Identity
	to      Identity
	name    string
	version string
}

// NewBindingKey builds the uniqueness key for a triple.
func NewBindingKey(from, to Identity, capability CapabilityRef) BindingKey {
	return BindingKey{from: from, to: to, name: capability.Name, version: capability.Version}
}

// String renders the key. Components are length-prefixed, so the encoding is
// injective: a capability name containing the separator cannot collide with a
// different triple.
func (k BindingKey) String() string {
	var buf []byte
	appendKeyComponent(&buf, identityKey(k.from))
	appendKeyComponent(&buf, identityKey(k.to))
	appendKeyComponent(&buf, k.name)
	appendKeyComponent(&buf, k.version)
	return string(buf)
}

// Equal reports whether two keys denote the same triple.
//
// BindingKey holds only strings and comparable Identities, so struct equality
// is already correct; this exists to make the intent explicit at call sites.
func (k BindingKey) Equal(other BindingKey) bool { return k == other }

// appendKeyComponent writes a length-prefixed component into dst.
func appendKeyComponent(dst *[]byte, s string) {
	*dst = appendInt(*dst, len(s))
	*dst = append(*dst, ':')
	*dst = append(*dst, s...)
	*dst = append(*dst, '|')
}

// appendInt appends a decimal integer.
func appendInt(dst []byte, n int) []byte {
	if n == 0 {
		return append(dst, '0')
	}
	var digits [20]byte
	position := len(digits)
	for n > 0 {
		position--
		digits[position] = byte('0' + n%10)
		n /= 10
	}
	return append(dst, digits[position:]...)
}

// deriveBindingState computes the semantic state of a binding from the current
// state of the graph (§6.4). This is the single most important function in the
// package: every binding state a caller observes comes from here.
//
//	CLOSED   iff explicitly unbound
//	ACTIVE   iff OPEN and from is ACTIVE and to is ACTIVE and from still
//	         exposes the capability
//	DORMANT  otherwise
//
// Note what is *not* consulted: nothing about the binding itself beyond
// `closed`. A binding is never "made DORMANT" — suspending a plugin makes the
// binding *read* as DORMANT because one of the ACTIVE conditions stopped
// holding, and resuming it makes the binding read ACTIVE again with no repair
// step (§6.6 "上述任一恢复 -> ACTIVE", O-8). Storing the state instead would
// require every mutation of every plugin to remember to fix up its bindings,
// and would leave the two silently out of sync the first time one forgot.
func deriveBindingState(record *binding, from, to pluginRecord) BindingState {
	if record.closed {
		return BindingClosed
	}
	if from.lifecycle != LifecycleActive || to.lifecycle != LifecycleActive {
		return BindingDormant
	}
	if !from.hasCapability(record.capability.Name, record.capability.Version) {
		return BindingDormant
	}
	return BindingActive
}

// BindRequest is the input of Bind (§9.2).
type BindRequest struct {
	// From is the plugin that provides the capability.
	From Identity `json:"from"`
	// To is the plugin that consumes it.
	To Identity `json:"to"`
	// Capability names what composes; Version is required (C-5).
	Capability CapabilityRef `json:"capability"`
	// Contract is optional context (C-3).
	Contract *ContractRef `json:"contract,omitempty"`
}

// Bind creates a Binding between two plugins (§6, §9.2).
//
// The checks below run inside a single critical section, which is what B-8
// requires; §9.5 and §6 state them in this order:
//
//	B-1  from and to MUST be existing plugins       -> EAPP_PLUGIN_NOT_FOUND
//	B-2  the capability MUST be exposed by from     -> EAPP_CAPABILITY_NOT_EXPOSED
//	C-5  the capability reference MUST carry a version
//	B-7  capability.plugin MUST equal from          -> EAPP_BINDING_INVALID
//	B-6  at most one non-CLOSED binding per
//	     (from, to, capability)                     -> EAPP_BINDING_DUPLICATE
//
// B-8 ("uniqueness check + creation MUST be atomic") is satisfied by doing the
// lookup and the insert under one lock acquisition: there is no window between
// "no such binding" and "insert", so two concurrent binds of the same triple
// cannot both create. One wins; the other observes the winner and fails with
// EAPP_BINDING_DUPLICATE. §6.8 permits either returning the existing binding or
// failing; failing is chosen because silently handing back another caller's
// binding hides a real duplicate-composition bug.
//
// The new binding is stored directly in the OPEN index, because §6.8 makes the
// *non-CLOSED* set the uniqueness domain: there is no PENDING state to publish,
// and B-9 forbids publishing one.
//
// A binding records no copy of the capability's `constraints`: they are
// filtering context (§4.1, C-3, C-7), not part of the (from, to, capability)
// uniqueness domain of §6.8, and storing them here would suggest they
// distinguish two otherwise identical bindings.
func (c *Core) Bind(request BindRequest) (Binding, error) {
	if err := validateBindRequest(request); err != nil {
		return Binding{}, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	fromRecord, present := c.plugins[identityTriple(request.From)]
	if !present {
		return Binding{}, errPluginNotFound("no plugin registered with identity %s (B-1)", request.From)
	}
	// B-1 for the other end. The `to` record is deliberately not used further:
	// nothing in §6.4's derivation depends on the consumer's capabilities, only
	// on its lifecycle (read at derivation time, see bindingStateLocked).
	if _, present := c.plugins[identityTriple(request.To)]; !present {
		return Binding{}, errPluginNotFound("no plugin registered with identity %s (B-1)", request.To)
	}

	// O-2 / B-2. Exposure is checked against the *current* capability set, so a
	// plugin that withdrew the capability (P-4) cannot be bound to it.
	if !fromRecord.hasCapability(request.Capability.Name, request.Capability.Version) {
		return Binding{}, errCapabilityNotExposed(
			"plugin %s does not expose capability %s@%s (O-2, B-2)",
			fromRecord.identity, request.Capability.Name, request.Capability.Version)
	}

	key := NewBindingKey(request.From, request.To, request.Capability)
	keyString := key.String()
	if existing, exists := c.openByKey[keyString]; exists {
		return Binding{}, errBindingDuplicate(
			"a non-CLOSED binding already exists for (%s -> %s, %s@%s) (B-6, B-8)",
			request.From, request.To, request.Capability.Name, request.Capability.Version).
			withDetails(map[string]any{"binding": existing.id})
	}

	// B-7 by construction: the stored reference always carries From as its
	// plugin, so `Binding.capability.plugin == Binding.from` cannot drift.
	capability := request.Capability
	capability.Plugin = request.From

	record := &binding{
		id:         bindingIDPrefix + strconv.FormatUint(c.bindingSeq.Add(1), 10),
		from:       request.From,
		to:         request.To,
		capability: capability,
	}
	if request.Contract != nil {
		contract := *request.Contract
		if len(contract.Schema) > 0 {
			contract.Schema = append([]byte(nil), contract.Schema...)
		}
		record.contract = &contract
	}

	c.bindingsByID[record.id] = record
	c.openByKey[keyString] = record

	// The returned state is derived, never assigned (B-3). Binding two
	// INACTIVE plugins yields DORMANT, and that is the correct, observable
	// answer for O-1: bind created the binding, and §6.4 decided its state.
	return c.bindingSnapshotLocked(record), nil
}

// validateBindRequest performs the whole-request checks of Bind before the
// registry is consulted, so that a malformed request never takes the lock.
func validateBindRequest(request BindRequest) error {
	if err := request.From.Validate(); err != nil {
		return err
	}
	if err := request.To.Validate(); err != nil {
		return err
	}
	if request.Capability.Name == "" {
		return errBindingInvalid("capability.name MUST NOT be empty (C-1)")
	}
	// C-5: a CapabilityRef MUST include its version. An empty version is not a
	// wildcard here — C-6 makes the version part of the binding identity, so
	// admitting "" would create a binding no capability could ever satisfy.
	if request.Capability.Version == "" {
		return errBindingInvalid("capability.version MUST be present in a capability reference (C-5)")
	}
	if _, err := ParseVersion(request.Capability.Version); err != nil {
		return errBindingInvalid(
			"capability.version %q MUST be valid SemVer (C-2): %v", request.Capability.Version, err)
	}
	// §6.7 / B-7. A zero Plugin means the caller omitted the redundant field,
	// which is the normal case (the wire form has no `plugin` member);
	// anything else that disagrees with `from` is rejected rather than
	// rewritten, so the caller's mistake stays visible.
	if !request.Capability.Plugin.IsZero() && !request.Capability.Plugin.Equal(request.From) {
		return errBindingInvalid(
			"capability.plugin MUST equal from: capability names %s but the request binds from %s (§6.7, B-7)",
			request.Capability.Plugin, request.From)
	}
	return nil
}

// Unbind closes a binding (§9.2, O-3).
//
// Idempotent (O-4): unbinding an already-CLOSED binding succeeds. That is why
// the record stays in bindingsByID after closing — deleting it would make the
// second call indistinguishable from "no such binding", and O-4 says it MUST
// succeed.
//
// Closing removes the binding from the uniqueness index, which is exactly the
// §6.8 rule: the uniqueness domain is the set of *non-CLOSED* bindings, so a
// closed triple can be bound again. CLOSED is terminal (B-4), so nothing ever
// puts the record back.
func (c *Core) Unbind(bindingID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	record, present := c.bindingsByID[bindingID]
	if !present {
		// Unknown handle: EAPP_BINDING_INVALID. There is no binding to close,
		// and reporting success would claim a state (CLOSED) that no binding
		// holds.
		return errBindingInvalid("no binding with id %q", bindingID)
	}
	if record.closed {
		return nil // O-4
	}
	record.closed = true
	delete(c.openByKey, NewBindingKey(record.from, record.to, record.capability).String())
	return nil
}

// Binding returns a binding by handle.
//
// A CLOSED binding is returned like any other: O-3 makes CLOSED a state, not a
// removal, so the handle remains valid and its state remains observable.
func (c *Core) Binding(bindingID string) (Binding, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	record, present := c.bindingsByID[bindingID]
	if !present {
		return Binding{}, errBindingInvalid("no binding with id %q", bindingID)
	}
	return c.bindingSnapshotLocked(record), nil
}

// BindingState returns the derived state of a binding by handle (§6.4).
//
// The state is recomputed on every call from the current plugin registry: an
// ACTIVE binding whose consumer was suspended since the previous read reports
// DORMANT here, with no notification and no repair step (§6.6, O-6, O-7).
func (c *Core) BindingState(bindingID string) (BindingState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	record, present := c.bindingsByID[bindingID]
	if !present {
		return "", errBindingInvalid("no binding with id %q", bindingID)
	}
	return c.bindingStateLocked(record), nil
}

// Bindings returns every binding, ordered by creation.
//
// CLOSED bindings are included: O-3 says unbind sets a binding to CLOSED rather
// than removing it, so a list that dropped them could not be used to observe
// that O-3 happened.
func (c *Core) Bindings() []Binding {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Binding, 0, len(c.bindingsByID))
	for _, record := range c.bindingsByID {
		out = append(out, c.bindingSnapshotLocked(record))
	}
	// Order by creation. Handles are opaque, so this comparison parses the
	// minted numeric suffix and falls back to text order for anything that does
	// not parse (defensive: every handle here was minted by this Core).
	sort.Slice(out, func(i, j int) bool {
		left, leftErr := strconv.ParseUint(strings.TrimPrefix(out[i].ID, bindingIDPrefix), 10, 64)
		right, rightErr := strconv.ParseUint(strings.TrimPrefix(out[j].ID, bindingIDPrefix), 10, 64)
		if leftErr != nil || rightErr != nil {
			return out[i].ID < out[j].ID
		}
		return left < right
	})
	return out
}

// bindingStateLocked derives the state of a stored binding.
//
// c.mu MUST be held: the derivation reads the plugin registry (§6.4).
func (c *Core) bindingStateLocked(record *binding) BindingState {
	from, haveFrom := c.plugins[identityTriple(record.from)]
	to, haveTo := c.plugins[identityTriple(record.to)]
	if !haveFrom || !haveTo {
		// Unreachable while the Core never deletes a plugin (there is no such
		// primitive, §9). If it ever became reachable, DORMANT is the only safe
		// answer: the binding cannot be ACTIVE, and CLOSED must stay reserved
		// for an explicit unbind (B-4).
		return BindingDormant
	}
	return deriveBindingState(record, *from, *to)
}

// bindingIDPrefix is the text every minted binding handle starts with. It is an
// implementation detail: callers MUST treat the handle as opaque and never parse
// it (conformance/driver.md leaves the shape free).
const bindingIDPrefix = "binding-"

// bindingSnapshotLocked renders a binding for a caller.
//
// The Capability.Plugin field is stamped from the record rather than trusted
// from it, so B-7 holds in every value this package hands out, including ones
// built before a future refactor moved the construction.
func (c *Core) bindingSnapshotLocked(record *binding) Binding {
	snapshot := record.snapshot()
	snapshot.Capability.Plugin = record.from
	return snapshot
}
