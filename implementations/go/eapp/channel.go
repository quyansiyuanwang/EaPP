package eapp

// ChannelMode is the frozen set of §3: one Channel carries exactly one mode, and
// the mode MUST NOT change during the Channel's lifetime (CH-5).
type ChannelMode string

const (
	// ModeRequest is request/response (§3): the mode a request MUST have
	// exactly one answer to, or none.
	ModeRequest ChannelMode = "request"
	// ModeEvent is fire-and-forget (§3): delivery MAY be zero times or many
	// (EV-2, EV-3), and no response is ever expected (EV-1).
	ModeEvent ChannelMode = "event"
	// ModeStream is the cursor-ordered log (§3, §10): at-least-once only.
	ModeStream ChannelMode = "stream"
	// ModeState is the fourth frozen mode (§3). Its *runtime* semantics belong
	// to v3.2.0; at this layer a state Channel is a Channel like the others —
	// created, connected, sent to and consumed — with at-least-once delivery.
	ModeState ChannelMode = "state"
)

// Valid reports whether the mode is one of §3's four.
func (m ChannelMode) Valid() bool {
	switch m {
	case ModeRequest, ModeEvent, ModeStream, ModeState:
		return true
	default:
		return false
	}
}

// ParseChannelMode converts a wire string into a mode.
//
// An unknown mode is EAPP_MODE_INVALID. It is *not* EAPP_UNSUPPORTED: §10.4's
// EAPP_UNSUPPORTED is about a feature a transport cannot carry, whereas an
// unknown mode names nothing this layer could ever implement — and accepting it
// as some default would silently give the caller a Channel of the wrong kind.
func ParseChannelMode(text string) (ChannelMode, error) {
	mode := ChannelMode(text)
	if !mode.Valid() {
		return "", errModeInvalid(
			"channel mode MUST be one of request, event, stream, state (§3); got %q", text)
	}
	return mode, nil
}

// DeliveryGuarantee is §4's delivery semantics.
type DeliveryGuarantee string

const (
	// DeliveryAtMostOnce means a message is delivered at most once: no
	// retransmission, no acknowledgement (DL-3).
	DeliveryAtMostOnce DeliveryGuarantee = "at-most-once"
	// DeliveryAtLeastOnce means a message is delivered at least once, which
	// requires acknowledgement (DL-4) and idempotent consumption (DL-5).
	DeliveryAtLeastOnce DeliveryGuarantee = "at-least-once"
)

// Valid reports whether the guarantee is one of §4's two.
func (d DeliveryGuarantee) Valid() bool {
	return d == DeliveryAtMostOnce || d == DeliveryAtLeastOnce
}

// ParseDeliveryGuarantee converts a wire string into a guarantee.
//
// Anything outside the two is EAPP_DELIVERY_UNSUPPORTED, which is where DL-2
// ("exactly-once MUST NOT 出现在 Core") lands: a caller that asks for exactly-once
// gets a refusal that names delivery, not a silent downgrade to one of the two
// guarantees it did not ask for.
func ParseDeliveryGuarantee(text string) (DeliveryGuarantee, error) {
	guarantee := DeliveryGuarantee(text)
	if !guarantee.Valid() {
		return "", errDeliveryUnsupported(
			"delivery MUST be at-most-once or at-least-once (§4, DL-1, DL-2); got %q", text)
	}
	return guarantee, nil
}

// DefaultDelivery is §4.4's derivation, used when a caller omits `delivery`
// (CC-4): stream and state are at-least-once, everything else at-most-once.
//
// The asymmetry is not arbitrary. A stream or a state Channel exists to be
// resumed from a cursor (ST-2, §15's I4 ruling), and a position that can be lost
// cannot be resumed from — so those two modes cannot be served by a guarantee
// that permits loss.
func (m ChannelMode) DefaultDelivery() DeliveryGuarantee {
	switch m {
	case ModeStream, ModeState:
		return DeliveryAtLeastOnce
	default:
		return DeliveryAtMostOnce
	}
}

// AllowsDelivery reports which guarantees the mode permits (§4.4's table).
func (m ChannelMode) AllowsDelivery(guarantee DeliveryGuarantee) bool {
	switch m {
	case ModeStream, ModeState:
		// DL-6: stream and state are at-least-once only; asking for
		// at-most-once is EAPP_DELIVERY_UNSUPPORTED (CC-5).
		return guarantee == DeliveryAtLeastOnce
	default:
		return guarantee.Valid()
	}
}

// ChannelState is §2.1's lifecycle state.
type ChannelState string

const (
	// ChannelOpen is the state a freshly created Channel is in (CC-8): it exists
	// and is tied to its Binding, but nothing is being served yet.
	ChannelOpen ChannelState = "OPEN"
	// ChannelActive is the state after connect() (CC-8), and the state a
	// Channel returns to when its Binding recovers (CC-2, §2.2's
	// DRAINING --connect--> ACTIVE).
	ChannelActive ChannelState = "ACTIVE"
	// ChannelDraining is what a DORMANT Binding imposes (§2.4): stop taking new
	// messages, let what is in flight finish. It is deliberately not CLOSED,
	// because closing would discard in-flight work that a resume would have
	// completed.
	ChannelDraining ChannelState = "DRAINING"
	// ChannelClosed is terminal (CH-3).
	ChannelClosed ChannelState = "CLOSED"
)

// Valid reports whether the state is one of §2.1's four.
func (s ChannelState) Valid() bool {
	switch s {
	case ChannelOpen, ChannelActive, ChannelDraining, ChannelClosed:
		return true
	default:
		return false
	}
}

// IsTerminal reports whether the state admits no transition (CH-3).
func (s ChannelState) IsTerminal() bool { return s == ChannelClosed }

// Serves reports whether the state accepts new messages and new consumers.
//
// DRAINING does not: §2.4 explains that the whole point of DORMANT ⇒ DRAINING is
// to stop accepting new work ("停止接收新消息，等待在途完成"). A DRAINING Channel
// still *serves* what it already holds, which is why this is a separate question
// from `IsTerminal`.
func (s ChannelState) Serves() bool { return s == ChannelOpen || s == ChannelActive }

// ChannelRef is the only part of a Channel the Composition Core may see (§2.1).
//
// Its two members are exactly the two facts a Binding needs to state the
// relation: which Channel, and which Binding it belongs to. Nothing about mode or
// delivery appears, because the Core MUST NOT define Channel semantics
// (v3.0 CH-1).
type ChannelRef struct {
	// ID is an implementation-chosen handle. Like Binding.ID it is opaque to
	// callers: never parsed, never ordered by.
	ID string `json:"id"`
	// Binding is the id of the Binding this Channel is derived from (CH-1).
	Binding string `json:"binding"`
}

// Channel is §2.1's Channel: its reference plus mode, delivery and state.
//
// `Mode` and `Delivery` are set once at creation and never written again, which
// is how CH-5 and CH-6 ("MUST NOT 在生命周期内改变") are made structural rather
// than promised: there is no code path that assigns them after
// CreateChannel returns. `State` is *derived* on every read (see
// Interaction.channelState) and never stored, for the same reason the Core
// derives BindingState (B-3): a stored state needs every mutation that could
// affect it to remember to fix it up, and §2.4's table has four such mutations.
type Channel struct {
	// ID is the Channel's handle.
	ID string `json:"id"`
	// Binding is the Channel's Binding (CH-1).
	Binding string `json:"binding"`
	// Mode is §3's interactive mode.
	Mode ChannelMode `json:"mode"`
	// Delivery is §4's delivery guarantee.
	Delivery DeliveryGuarantee `json:"delivery"`
	// State is §2.1's lifecycle state, derived per §2.4.
	State ChannelState `json:"state"`
}

// Ref reduces the Channel to the part the Composition Core is allowed to see
// (§2.1, §11's `channelRef`).
func (c Channel) Ref() ChannelRef {
	return ChannelRef{ID: c.ID, Binding: c.Binding}
}

// CreateChannelRequest is §12's input.
//
// `Mode` has no default and MUST be given (CC-3): §3 says a Channel has exactly
// one mode, and a default would let a caller get a Channel of a kind it never
// asked for. `Delivery` may be omitted, and CC-4 says how it is then derived.
type CreateChannelRequest struct {
	// Binding is the id of an existing, non-CLOSED Binding.
	Binding string `json:"binding"`
	// Mode is the Channel's mode (CC-3).
	Mode ChannelMode `json:"mode"`
	// Delivery is optional; empty means "derive it from the mode" (CC-4).
	Delivery DeliveryGuarantee `json:"delivery,omitempty"`
}
