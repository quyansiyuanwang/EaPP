package eapp

import "time"

// Lease is §5's temporary ownership of one position.
//
// A Lease answers "who currently holds this position, and until when". It exists
// because at-least-once delivery needs a way to hand a position to *one*
// consumer while keeping the position recoverable if that consumer disappears:
// a crash cannot call `nack`, so the only way to get the position back is for the
// ownership to expire on its own.
//
// Where it is used. §8.3 is explicit that a ConsumerGroup's claim *is* a Lease —
// "一次 claim 就是一次 Lease" — and that L-2 is the mechanism behind CG-3. This
// implementation puts leases exactly there and nowhere else: an `exclusive`
// Subscription has no competitor, so there is nothing for a lease to arbitrate
// and its deliveries carry none (`Item.Lease()` is nil). Inventing a lease
// without a competing claim would be an ownership record with no one to exclude.
//
// Invariants served: L-1 (uniqueness of leaseId — minted from a layer-wide
// counter), L-2 (a cursor is never held by two active leases — enforced by the
// group's claim map, the single place a claim is created), L-3/L-4 (ack and nack
// idempotent — the delivery's state machine, §9), L-5 (renew only on an active
// lease), L-6/L-7 (expiry returns the position to the group without letting the
// old lease act on the new owner).
type Lease struct {
	// ID is globally unique within the process (L-1).
	ID string
	// Cursor is the position this lease holds.
	Cursor Cursor
	// ExpiresAt is when the claim lapses and the position becomes available to
	// the group again (L-6). A zero time means "no expiry", which cannot happen
	// for a group claim: §8.2 gives ConsumerGroupOptions a claim TTL precisely
	// so that ownership always ends.
	ExpiresAt time.Time

	// delivery is the context this lease settles. Reaching the position's
	// acknowledgement through the lease is deliberate: acking a claim and acking
	// a delivery are the same operation, and having two paths to it would make
	// "cursor advanced twice" possible.
	delivery *delivery
}

// Ack acknowledges the leased position (§5, §9).
//
// L-3 says it MUST be idempotent, and §9's AK-1 says the same thing about the
// AckContext: this is one implementation because they are one requirement.
func (l *Lease) Ack() error {
	if l == nil || l.delivery == nil {
		return errLeaseClosed("lease is not attached to a delivery (§5)")
	}
	return l.delivery.Ack()
}

// Nack releases the leased position back to the group (§5, §9).
//
// L-4 (idempotent) and AK-2 are again the same requirement. §6.4 states the
// effect on position: nack MUST NOT advance the cursor, and the item returns to
// the log's available set for redelivery.
func (l *Lease) Nack() error {
	if l == nil || l.delivery == nil {
		return errLeaseClosed("lease is not attached to a delivery (§5)")
	}
	return l.delivery.Nack()
}

// Renew extends the lease by ttl (L-5: only an ACTIVE lease may be renewed).
//
// An already-settled lease is EAPP_LEASE_CLOSED, and an expired one is
// EAPP_LEASE_EXPIRED. Both are refusals rather than silent success for the same
// reason: L-7 says an expired lease MUST NOT affect a new one, and a `renew` that
// revived a lapsed claim would do exactly that — the position belongs to whoever
// claimed it next.
func (l *Lease) Renew(ttl time.Duration) error {
	if l == nil || l.delivery == nil {
		return errLeaseClosed("lease is not attached to a delivery (§5)")
	}
	return l.delivery.renew(ttl)
}

// Active reports whether the lease still owns its position at `now`.
//
// A lease is active while it is neither settled nor detached, and its expiry has
// not passed. This is the predicate L-2 is stated over: two *active* leases may
// not hold one cursor, while an expired one no longer counts.
func (l *Lease) Active(now time.Time) bool {
	if l == nil || l.delivery == nil {
		return false
	}
	if l.delivery.settled() || l.delivery.detached {
		return false
	}
	return l.ExpiresAt.IsZero() || now.Before(l.ExpiresAt)
}
