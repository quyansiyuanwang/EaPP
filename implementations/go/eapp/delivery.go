package eapp

import "time"

// delivery is §9's AckContext: one item that has been handed to a consumer, plus
// the state that decides what a further call on it means.
//
// It is the single place acknowledgements are recorded, for both modes and for
// both entry points — the Item's `Ack()` and the Subscription's handle-addressed
// `Ack(handle)` — because AK-1 … AK-5 are rules about *this object*, and a second
// implementation of them would be a second chance to disagree.
//
// The three booleans are not a state enum on purpose: `detached` is orthogonal to
// the settled-ness of the item. An item can be un-settled and detached (the
// subscription closed under it: SUB-8 says a later ack is a no-op) or settled and
// then detached (the item was acked, then the subscription closed: a later
// *conflicting* call is still a contradiction).
type delivery struct {
	// handle is the opaque token a caller holds (conformance/driver.md's
	// `delivery`): an AckContext cannot cross a process boundary, so it is
	// addressed by name.
	handle string
	// position is the log position this delivery came from.
	position uint64
	// cursor is the position rendered as §6.1's Cursor.
	cursor Cursor
	// payload is the message, untouched.
	payload any

	// layer is the owning layer: every mutation has to happen under its mutex.
	layer *Interaction
	// subscription is the consumer this item was handed to.
	subscription *subscriptionRecord
	// group is the ConsumerGroup whose claim backs this item, or nil for an
	// exclusive subscription.
	group *groupRecord
	// lease is §5's temporary ownership, present exactly when `group` is not.
	lease *Lease

	// acked and nacked are the settlement state (AK-3, AK-4 forbid the second).
	acked  bool
	nacked bool
	// detached means the item no longer belongs to a live subscription, so
	// settling it MUST be a no-op that changes no cursor (SUB-8).
	detached bool
}

// Ack implements §9's `ack()`.
func (d *delivery) Ack() error { return d.layer.ack(d) }

// Nack implements §9's `nack()`.
func (d *delivery) Nack() error { return d.layer.nack(d) }

// renew extends the claim behind this delivery (§5's `renew(ttl)`).
func (d *delivery) renew(ttl time.Duration) error { return d.layer.renew(d, ttl) }

// settled reports whether the item has been answered one way or the other.
func (d *delivery) settled() bool { return d.acked || d.nacked }
