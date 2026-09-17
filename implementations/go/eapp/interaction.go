package eapp

import (
	"sort"
	"strconv"
	"sync"
	"time"
)

// Interaction is the v3.1 Interaction Layer over a Composition Core.
//
// It owns everything v3.1 defines and v3.0 deliberately does not: Channels and
// their lifecycle, the transport, cursors, Subscriptions, ConsumerGroups,
// Leases and acknowledgements. The Core below it owns Identity, Capability,
// Plugin, Binding and Lifecycle — the relation, not the interaction. The boundary
// is §11's, and it is one-directional in this implementation: this layer reads
// the Core (binding state, for §2.4), and the Core knows nothing about Channels
// at all (v3.0 CH-1).
//
// Concurrency. One mutex guards the whole interaction layer, for the same reason
// the Core uses one: the rules are joint. §2.4 derives a Channel's state from its
// Binding, §6.4 derives a cursor from the acknowledgements that arrived, and §8.3
// derives a group's cursor from its members' acknowledgements — none of those can
// be evaluated over a half-applied mutation. Lock order, wherever both locks are
// needed, is Interaction then Core; nothing takes them the other way round.
type Interaction struct {
	// core is the Composition Core this layer sits on (§11).
	core *Core
	// transport carries messages and assigns cursors (§10).
	transport Transport
	// ownsTransport records that the transport was created here, so Reset may
	// discard it outright.
	ownsTransport bool

	mu            sync.Mutex
	channels      map[string]*channelRecord
	channelSeq    uint64
	groups        map[string]*groupRecord
	groupSeq      uint64
	subscriptions map[string]*subscriptionRecord
	subSeq        uint64
	deliveries    map[string]*delivery
	deliverySeq   uint64
	leaseSeq      uint64
}

// channelRecord is one Channel's mutable state.
//
// Note what is *not* here: the Channel's state. §2.4 derives it from the Binding
// (and from whether connect() has happened), and deriving it on every read is
// what makes CC-2's "immediately" true without a notification path, a repair
// step, or a chance to forget one. The two fields that are stored — `connected`
// and `closed` — are not the state; they are the two facts the derivation needs
// and cannot recompute from the Binding.
type channelRecord struct {
	id       string
	binding  string
	mode     ChannelMode
	delivery DeliveryGuarantee
	// connected records that connect() has been called (CC-8). It is a fact
	// about this Channel, not a state: a Channel that has been connected but
	// whose Binding is DORMANT is DRAINING, and becomes ACTIVE again — not OPEN
	// — when the Binding recovers (CC-2).
	connected bool
	// closed records an explicit close(). CLOSED is terminal (CH-3), so nothing
	// ever clears it; a close that arrives after the Binding already closed the
	// Channel is accepted and changes nothing (CH-4).
	closed bool
}

// NewInteraction creates an Interaction layer over core, backed by a fresh
// memory transport (§10.3's Memory row).
func NewInteraction(core *Core) *Interaction {
	return &Interaction{
		core:          core,
		transport:     NewMemoryTransport(),
		ownsTransport: true,
		channels:      make(map[string]*channelRecord),
		groups:        make(map[string]*groupRecord),
		subscriptions: make(map[string]*subscriptionRecord),
		deliveries:    make(map[string]*delivery),
	}
}

// NewInteractionWithTransport creates an Interaction layer over an injected
// transport.
//
// It exists because §10 separates mechanism from semantics (TR-1): the layer must
// be testable and usable on a transport other than the in-memory one, and the
// capability checks of §10.4 only mean something if the transport can differ.
func NewInteractionWithTransport(core *Core, transport Transport) *Interaction {
	interaction := NewInteraction(core)
	if transport != nil {
		interaction.transport = transport
		interaction.ownsTransport = false
	}
	return interaction
}

// Core exposes the Composition Core underneath the layer (§11's downward edge).
func (l *Interaction) Core() *Core { return l.core }

// Transport exposes the transport (§10).
func (l *Interaction) Transport() Transport { return l.transport }

// Capabilities reports the transport's declaration (§10.2, TR-2).
func (l *Interaction) Capabilities() TransportCapabilities {
	return l.transport.Capabilities()
}

// Reset returns the layer to its initial state: no Channels, no Subscriptions,
// no ConsumerGroups, no retained messages.
//
// Like Core.Reset it exists for the conformance driver's `reset`, which has to
// give a harness a clean slate without restarting the process. Handles are not
// reused afterwards in a way that could matter, because every handle this layer
// mints is looked up in a map that is replaced wholesale.
func (l *Interaction) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.channels = make(map[string]*channelRecord)
	l.groups = make(map[string]*groupRecord)
	l.subscriptions = make(map[string]*subscriptionRecord)
	l.deliveries = make(map[string]*delivery)
	if resettable, ok := l.transport.(Resettable); ok {
		resettable.Reset()
	}
}

// ---------------------------------------------------------------------------
// §12: the Channel creation path
// ---------------------------------------------------------------------------

// CreateChannel derives and instantiates a Channel from a Binding (§12).
//
// The order of the checks is the order §12 states them in, and each failure is
// the code that names the condition:
//
//	CC-3  mode MUST be given explicitly          -> EAPP_MODE_INVALID
//	CC-4  an omitted delivery is derived here    -> (no failure)
//	CC-5  stream/state + at-most-once, DL-6      -> EAPP_DELIVERY_UNSUPPORTED
//	CC-6  the Binding MUST exist                 -> EAPP_BINDING_INVALID
//	CC-7  the Binding MUST NOT be CLOSED         -> EAPP_BINDING_CLOSED
//	CC-8  the result is OPEN until connect()     -> (derived)
//	CC-9  one Binding MAY derive several Channels -> (no uniqueness rule)
//
// A Binding that is DORMANT is accepted: §12 requires "existing and not CLOSED",
// and §2.4 then makes the Channel DRAINING rather than refusing to create it.
// Refusing would leave no way to have a Channel ready for the moment the Binding
// recovers, which CC-2 explicitly contemplates.
func (l *Interaction) CreateChannel(request CreateChannelRequest) (Channel, error) {
	if !request.Mode.Valid() {
		return Channel{}, errModeInvalid(
			"channel.create MUST name a mode explicitly (§3, CC-3); got %q", string(request.Mode))
	}
	delivery := request.Delivery
	if delivery == "" {
		// CC-4: stream/state derive to at-least-once, the others to
		// at-most-once.
		delivery = request.Mode.DefaultDelivery()
	}
	if !request.Mode.AllowsDelivery(delivery) {
		// CC-5 / DL-6.
		return Channel{}, errDeliveryUnsupported(
			"a %s channel MUST use at-least-once delivery (§4.4, DL-6); got %s",
			request.Mode, delivery)
	}
	// TR-4: a Channel MUST NOT use a feature the transport does not have, and
	// TR-9 says what to answer when it would. The check is here rather than at
	// first use because a Channel that was created and then failed on its first
	// message has already told its caller that the promise held.
	if err := l.transportSupports(request.Mode, delivery); err != nil {
		return Channel{}, err
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	bindingState, err := l.bindingState(request.Binding)
	if err != nil {
		// CC-6: EAPP_BINDING_INVALID, produced by the Core.
		return Channel{}, err
	}
	if bindingState == BindingClosed {
		return Channel{}, errBindingClosed(
			"binding %s is CLOSED; a Channel MUST NOT outlive its Binding (CC-7, CH-2)", request.Binding)
	}

	l.channelSeq++
	record := &channelRecord{
		id:       "channel-" + strconv.FormatUint(l.channelSeq, 10),
		binding:  request.Binding,
		mode:     request.Mode,
		delivery: delivery,
	}
	l.channels[record.id] = record
	return l.channelSnapshot(record, bindingState), nil
}

// ConnectChannel brings a Channel into service (CC-8).
//
// §2.2's table has two edges into ACTIVE: `OPEN --connect--> ACTIVE`, and
// `DRAINING --connect--> ACTIVE`. Both are this operation, and the second is why
// connecting a Channel whose Binding is DORMANT is *accepted* rather than
// refused: it records the intent, and the derived state stays DRAINING until the
// Binding recovers. Refusing here would make §2.2's second edge unreachable,
// which is exactly what the erratum E-B restored it for.
func (l *Interaction) ConnectChannel(channelID string) (Channel, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	record, state, err := l.requireChannel(channelID)
	if err != nil {
		return Channel{}, err
	}
	if state == ChannelClosed {
		return Channel{}, errChannelClosed(
			"channel %s is CLOSED; CLOSED is terminal (CH-3)", channelID)
	}
	record.connected = true
	return l.channelSnapshot(record, l.bindingStateOf(record.binding)), nil
}

// CloseChannel closes a Channel (§2.2).
//
// CH-4 makes it idempotent, and the trivial way to honour that is to not treat a
// second close as an error. Closing also terminates what depends on the Channel:
// subscriptions (SUB-1) and ConsumerGroups (CG-7) MUST NOT exist independently of
// it, so a close that left them running would be the very thing those invariants
// forbid.
func (l *Interaction) CloseChannel(channelID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	record, _, err := l.requireChannel(channelID)
	if err != nil {
		return err
	}
	if record.closed {
		return nil // CH-4
	}
	record.closed = true
	l.terminateChannelDependents(record)
	return nil
}

// terminateChannelDependents closes every Subscription and ConsumerGroup derived
// from a Channel. Callers MUST hold l.mu.
func (l *Interaction) terminateChannelDependents(record *channelRecord) {
	for _, group := range l.groups {
		if group.channel == record && !group.closed {
			l.closeGroupLocked(group)
		}
	}
	for _, subscription := range l.subscriptions {
		if subscription.channel == record && !subscription.closed {
			l.closeSubscriptionLocked(subscription)
		}
	}
}

// Channel returns a Channel by handle (§11's `channel(id)`).
func (l *Interaction) Channel(channelID string) (Channel, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	record, _, err := l.requireChannel(channelID)
	if err != nil {
		return Channel{}, err
	}
	return l.channelSnapshot(record, l.bindingStateOf(record.binding)), nil
}

// ChannelRef returns the part of a Channel the Composition Core may see (§2.1,
// §11's `channelRef`).
func (l *Interaction) ChannelRef(channelID string) (ChannelRef, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	record, _, err := l.requireChannel(channelID)
	if err != nil {
		return ChannelRef{}, err
	}
	return ChannelRef{ID: record.id, Binding: record.binding}, nil
}

// ChannelState returns a Channel's derived state (§2.4, §11's `channelState`).
func (l *Interaction) ChannelState(channelID string) (ChannelState, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, state, err := l.requireChannel(channelID)
	if err != nil {
		return "", err
	}
	return state, nil
}

// Channels returns every Channel, ordered by creation.
//
// CLOSED Channels are included, exactly as Core.Bindings includes CLOSED
// bindings: CH-3 makes CLOSED a state rather than a removal, so a list that
// dropped them could not be used to observe that the transition happened.
func (l *Interaction) Channels() []Channel {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make([]Channel, 0, len(l.channels))
	for _, record := range l.channels {
		bindingState, err := l.bindingState(record.binding)
		if err != nil {
			// A Channel whose Binding cannot be read cannot exist
			// independently of it (CC-1); CLOSED is the only state that says so.
			bindingState = BindingClosed
		}
		out = append(out, l.channelSnapshot(record, bindingState))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// transportSupports enforces TR-4 against the transport's own declaration
// (§10.2, §10.4).
//
// TR-3 forbids a transport from overstating what it can do, TR-4 forbids a
// Channel from using what was not declared, and TR-9 names both refusals:
// EAPP_UNSUPPORTED for a guarantee the transport does not offer, and
// EAPP_CURSOR_UNSUPPORTED — not the generic code — when it is the cursor feature
// that is missing (CR-5).
//
// The two cursor-bearing modes are checked as well as the delivery guarantee,
// because §15 settles the question explicitly: "承载 state / stream Channel 的
// 实现 MUST 满足 I4" (an implementation carrying state or stream Channels MUST
// satisfy I4, the cursor level). A stream Channel on a transport without cursors
// could not satisfy ST-2's resumption at all.
func (l *Interaction) transportSupports(mode ChannelMode, delivery DeliveryGuarantee) error {
	capabilities := l.transport.Capabilities()
	switch delivery {
	case DeliveryAtLeastOnce:
		if !capabilities.Delivery.AtLeastOnce {
			// TR-4 / TR-9: the transport declares no at-least-once delivery, so
			// the guarantee the mode needs cannot be honoured.
			return errUnsupported(
				"transport %q does not support at-least-once delivery (§10.2, TR-4); a %s channel cannot be served by it",
				l.transport.ID(), mode)
		}
	case DeliveryAtMostOnce:
		if !capabilities.Delivery.AtMostOnce {
			return errUnsupported(
				"transport %q does not support at-most-once delivery (§10.2, TR-4)", l.transport.ID())
		}
	}
	switch mode {
	case ModeStream, ModeState:
		if !capabilities.SupportsCursor {
			return errCursorUnsupported(
				"transport %q does not support cursors, so it cannot carry a %s channel (CR-5, §15 I4)",
				l.transport.ID(), mode)
		}
	}
	return nil
}

// requireChannel resolves a handle. Callers MUST hold l.mu.
func (l *Interaction) requireChannel(channelID string) (*channelRecord, ChannelState, error) {
	record, present := l.channels[channelID]
	if !present {
		return nil, "", errChannelInvalid("no channel with id %q", channelID)
	}
	return record, l.stateOf(record), nil
}

// requireServable resolves a handle and refuses one that takes no new work.
//
// The two refusals are distinct because they mean different things to a caller:
// DRAINING says "not now" (the Binding may recover, CC-2), CLOSED says "never
// again" (CH-3).
func (l *Interaction) requireServable(channelID string) (*channelRecord, error) {
	record, state, err := l.requireChannel(channelID)
	if err != nil {
		return nil, err
	}
	switch state {
	case ChannelClosed:
		return nil, errChannelClosed("channel %s is CLOSED (CH-3)", channelID)
	case ChannelDraining:
		// §2.4: DORMANT ⇒ DRAINING exists to stop accepting new messages while
		// in-flight ones finish.
		return nil, errChannelDraining(
			"channel %s is DRAINING: its Binding is DORMANT, so it MUST NOT take new work (§2.4)", channelID)
	}
	return record, nil
}

// ResolveAnchor resolves a §6.2 anchor against a Channel, eagerly.
//
// §6.2 rule 5 makes resolution eager at subscription creation, and exposing it
// has a second use that is worth the export: a caller that wants to read a log
// *from* an anchor ("everything after the head") can ask for the position instead
// of inventing one. Inventing one is the single thing an opaque cursor MUST NOT
// invite, since a wrong position and a right one look identical.
//
// A concrete cursor comes back normalized, and it is validated on the way: a
// position that was already discarded is EAPP_CURSOR_TOO_OLD and is NOT silently
// moved up to the retention floor (§6.2 rule 7).
func (l *Interaction) ResolveAnchor(channelID string, anchor CursorAnchor) (Cursor, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	record, state, err := l.requireChannel(channelID)
	if err != nil {
		return "", err
	}
	if state == ChannelClosed {
		return "", errChannelClosed("channel %s is CLOSED (CH-3)", channelID)
	}
	position, err := l.resolveAnchor(record, anchor)
	if err != nil {
		return "", err
	}
	return formatCursor(position), nil
}

// stateOf derives a Channel's state from its Binding and its own history (§2.4).
// Callers MUST hold l.mu.
//
// This function is §2.4's table, and it is the whole of CC-2:
//
//	Binding CLOSED   -> CLOSED   (and the Channel stays there: CH-3)
//	Binding DORMANT  -> DRAINING (not CLOSED: in-flight work must be able to
//	                              finish, and the state must be recoverable)
//	Binding ACTIVE   -> ACTIVE once connect() has been called, OPEN before that
//	                              (CC-8)
//
// The third row is where §2.2's `DRAINING --connect--> ACTIVE` earns its place:
// because the derived state does not remember having been DRAINING, a Channel
// whose Binding recovers returns to the service state it had, which is CC-2's
// "Binding 恢复 ACTIVE 时，Channel MUST 回到 ACTIVE".
func (l *Interaction) stateOf(record *channelRecord) ChannelState {
	if record.closed {
		return ChannelClosed
	}
	bindingState, err := l.bindingState(record.binding)
	if err != nil || bindingState == BindingClosed {
		// CC-1: a Channel MUST NOT exist independently of its Binding, so a
		// Binding that cannot be read (or is CLOSED) makes the Channel CLOSED.
		return ChannelClosed
	}
	if bindingState == BindingDormant {
		return ChannelDraining
	}
	if record.connected {
		return ChannelActive
	}
	return ChannelOpen
}

// bindingState reads the Binding's derived state from the Core.
//
// The Core derives it (v3.0 B-3) and this layer only reads it, which is what
// keeps CH-1 (one Channel, one Binding) a property of the derivation rather than
// a fact the layer has to keep in sync.
func (l *Interaction) bindingState(bindingID string) (BindingState, error) {
	return l.core.BindingState(bindingID)
}

// bindingStateOf is bindingState for a Channel whose record is known. Callers
// MUST hold l.mu.
func (l *Interaction) bindingStateOf(bindingID string) BindingState {
	state, err := l.bindingState(bindingID)
	if err != nil {
		return BindingClosed
	}
	return state
}

// channelSnapshot renders a Channel value. Callers MUST hold l.mu.
func (l *Interaction) channelSnapshot(record *channelRecord, bindingState BindingState) Channel {
	state := ChannelClosed
	if !record.closed {
		switch {
		case bindingState == BindingClosed:
			state = ChannelClosed
		case bindingState == BindingDormant:
			state = ChannelDraining
		case record.connected:
			state = ChannelActive
		default:
			state = ChannelOpen
		}
	}
	return Channel{
		ID:       record.id,
		Binding:  record.binding,
		Mode:     record.mode,
		Delivery: record.delivery,
		State:    state,
	}
}

// ---------------------------------------------------------------------------
// §10: messages
// ---------------------------------------------------------------------------

// Send appends a message to a Channel and returns its cursor (§10.1's
// `send(channel, msg)`, which assigns the cursor in the transport).
//
// A Channel that is DRAINING accepts nothing new (§2.4) and a CLOSED Channel
// accepts nothing at all (CH-3), so both are refused before the transport is
// reached. The state check and the append happen under one lock, which is what
// keeps "the Channel was open when I looked" and "my message is in the log" from
// being two different moments.
func (l *Interaction) Send(channelID string, payload any) (Cursor, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	record, err := l.requireServable(channelID)
	if err != nil {
		return "", err
	}
	return l.transport.Send(record.id, payload)
}

// ReadAfter reads a Channel's log directly (§10.1's `readAfter`).
//
// It is the transport's contract as seen from outside a Subscription: strictly
// greater than the argument (TR-5), undefined means from the earliest retained
// position (TR-6), and no match is an empty slice (TR-7). Errors from the
// transport (an unparsable cursor, an unsupported pattern) are passed through
// unchanged, because TR-9 requires the code that names the condition.
func (l *Interaction) ReadAfter(channelID string, after *Cursor, pattern Pattern) ([]TransportMessage, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	record, state, err := l.requireChannel(channelID)
	if err != nil {
		return nil, err
	}
	if state == ChannelClosed {
		return nil, errChannelClosed("channel %s is CLOSED (CH-3)", channelID)
	}
	return l.transport.ReadAfter(record.id, after, pattern)
}

// positionOfMessage is positionOf for a message read from the transport. Callers
// MUST hold l.mu.
func positionOfMessage(message TransportMessage) (uint64, error) {
	return positionOf(message.Cursor)
}

// messagesAtOrAfter returns the Channel's messages whose cursor is at or after
// `position`, in cursor order, by asking the transport for everything strictly
// after `position-1` (TR-5).
//
// Reading through the transport rather than into a private slice is deliberate:
// the Subscription's own bookkeeping then cannot drift from what the transport
// actually holds, and a transport with retention would have its §6.2 rules
// applied in one place.
func (l *Interaction) messagesAtOrAfter(record *channelRecord, position uint64) ([]TransportMessage, error) {
	var after *Cursor
	if position > 0 {
		cursor := formatCursor(position - 1)
		after = &cursor
	}
	return l.transport.ReadAfter(record.id, after, PatternAll)
}

// ---------------------------------------------------------------------------
// §11: the Composition ↔ Interaction boundary
// ---------------------------------------------------------------------------

// InteractionToComposition is §11's upward edge: what the Interaction Layer
// offers the Composition Core.
//
// This implementation satisfies it with *queries* rather than state: the Core
// can ask which ChannelRef belongs to a Channel, and what state that Channel is
// in, but it is never told anything by the Channel. That is the direction CH-1
// requires — the Core MUST NOT define Channel semantics — and it is why the
// interface has no `setState`-like member in §11 either.
type InteractionToComposition interface {
	// ChannelRef returns the ChannelRef for a Channel id (§2.1).
	ChannelRef(id string) (ChannelRef, error)
	// ChannelState returns a Channel's lifecycle state (§2.4).
	ChannelState(id string) (ChannelState, error)
}

// Interaction satisfies §11's upward edge.
var _ InteractionToComposition = (*Interaction)(nil)

// CompositionToInteraction is §11's downward edge: what the Composition Core
// tells the Interaction Layer when a Binding moves.
//
// This implementation implements it eagerly (see OnBindingClosed) and needs it
// for nothing: §2.4's derivation already makes every Channel read correctly after
// any Binding transition, whether or not anyone was notified. The callbacks exist
// so that a Core which *wants* to drive the layer — and an integrator that wires
// the two, as the conformance driver does for `unbind` — has the four events §11
// names, and so that the eager path and the derived path cannot disagree: both
// end in the same `stateOf`.
type CompositionToInteraction interface {
	// OnBindingCreated reports a new Binding. §11's shape returns the ChannelRef
	// derived for it.
	OnBindingCreated(binding Binding) ChannelRef
	// OnBindingActive reports a Binding that became ACTIVE (§2.4 row 1).
	OnBindingActive(binding Binding)
	// OnBindingDormant reports a Binding that became DORMANT (§2.4 row 2).
	OnBindingDormant(binding Binding)
	// OnBindingClosed reports a Binding that reached CLOSED (§2.4 row 3).
	OnBindingClosed(binding Binding)
}

// Interaction offers §11's downward edge as well.
var _ CompositionToInteraction = (*Interaction)(nil)

// OnBindingCreated answers with the ChannelRef of the Channel derived from this
// Binding, or the zero ChannelRef when there is none.
//
// It deliberately does NOT create a Channel. §12 (added by erratum E1-5)
// prescribes the creation path, and it requires the caller to name the mode
// explicitly (CC-3) — a callback that receives only a Binding has no mode to use,
// and inventing one would violate CC-3 in the service of §11. So this reports
// what exists instead of guessing.
func (l *Interaction) OnBindingCreated(binding Binding) ChannelRef {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, record := range l.channels {
		if record.binding == binding.ID {
			return ChannelRef{ID: record.id, Binding: record.binding}
		}
	}
	return ChannelRef{}
}

// OnBindingActive reports §2.4's first row.
//
// Nothing is stored: a Channel whose Binding is ACTIVE reads OPEN or ACTIVE
// (depending on connect) the moment it is queried, so there is no transition to
// apply and no chance of applying it twice.
func (l *Interaction) OnBindingActive(binding Binding) {}

// OnBindingDormant reports §2.4's second row.
//
// Again nothing is stored. The one thing worth saying is what is deliberately NOT
// done here: closing the Channels of a dormant Binding. §2.4's DORMANT ⇒ DRAINING
// （not CLOSED）is precisely there to keep in-flight messages alive, so
// "the Binding stopped" MUST NOT be turned into "the Channel is gone".
func (l *Interaction) OnBindingDormant(binding Binding) {}

// OnBindingClosed reports §2.4's third row: the Binding reached CLOSED, so its
// Channels MUST reach CLOSED immediately.
//
// This one has an effect, because closing is not derivable from a *read*: the
// Subscriptions and ConsumerGroups hanging off the Channel have to be terminated,
// and that is a mutation. CH-2's "immediately" is satisfied either way — a reader
// sees CLOSED through stateOf even if nobody called this — but a caller that
// wires the boundary gets the teardown at the instant the Binding closed rather
// than at the next read.
func (l *Interaction) OnBindingClosed(binding Binding) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, record := range l.channels {
		if record.binding != binding.ID || record.closed {
			continue
		}
		record.closed = true
		l.terminateChannelDependents(record)
	}
}

// now is the clock, indirected so that claim expiry can be reasoned about in one
// place rather than sprinkled through the group code.
func (l *Interaction) now() time.Time { return time.Now() }
