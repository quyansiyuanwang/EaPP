package eapp

import (
	"sort"
	"strconv"
	"time"
)

// AckContext is §9: what acknowledges or rejects one consumption.
//
// It is an interface rather than a pair of methods on the Subscription because
// the *item* is what is being answered for, not the stream: acking is "this
// position is done" (§6.4), and two consumptions of the same stream must be
// settleable independently.
type AckContext interface {
	// Ack confirms the item; the cursor advances to its position, taking the
	// maximum (§6.4).
	Ack() error
	// Nack rejects the item; the cursor does not advance and the position
	// returns to the available set (§6.4).
	Nack() error
}

// Item is one consumption unit (§7.1's `T`): the position it came from, its
// payload, and the AckContext that settles it.
//
// The delivery handle is part of the unit because an AckContext is a live object
// and cannot cross a process boundary (conformance/driver.md): the handle is its
// addressable stand-in.
type Item struct {
	// Cursor is the item's position in the Channel (§6.1).
	Cursor Cursor
	// Payload is the message. This layer never interprets it beyond pattern
	// matching — a layer that understood payloads would be inventing shapes §3.1
	// already froze.
	Payload any

	// context is the live AckContext behind this item.
	context *delivery
}

// Delivery returns the item's opaque handle (conformance/driver.md's `delivery`).
func (i Item) Delivery() string {
	if i.context == nil {
		return ""
	}
	return i.context.handle
}

// Ack settles the item (§9's `ack()`).
func (i Item) Ack() error {
	if i.context == nil {
		return errSubscriptionInvalid("item carries no acknowledgement context (§9)")
	}
	return i.context.Ack()
}

// Nack rejects the item (§9's `nack()`).
func (i Item) Nack() error {
	if i.context == nil {
		return errSubscriptionInvalid("item carries no acknowledgement context (§9)")
	}
	return i.context.Nack()
}

// Lease returns the item's lease, or nil.
//
// Only a group claim carries one: §8.3 makes a claim a Lease, and a claim exists
// to arbitrate between competing members (L-2). An exclusive Subscription has no
// competitor to arbitrate with, so its items carry none.
func (i Item) Lease() *Lease {
	if i.context == nil {
		return nil
	}
	return i.context.lease
}

// SubscriptionMode is §7.1's mode.
type SubscriptionMode string

const (
	// SubscriptionExclusive is the default: the subscription holds its own
	// cursor and receives every matching item (SUB-2).
	SubscriptionExclusive SubscriptionMode = "exclusive"
	// SubscriptionGroup shares one cursor with the other members of a
	// ConsumerGroup and competes with them for each item (§8).
	SubscriptionGroup SubscriptionMode = "group"
)

// Valid reports whether the mode is one of §7.1's two.
func (m SubscriptionMode) Valid() bool {
	return m == SubscriptionExclusive || m == SubscriptionGroup
}

// SubscriptionState is §7.1's state.
type SubscriptionState string

const (
	// SubscriptionActive is delivering.
	SubscriptionActive SubscriptionState = "ACTIVE"
	// SubscriptionSuspended has stopped delivering; items already handed out
	// remain valid (§7.2).
	SubscriptionSuspended SubscriptionState = "SUSPENDED"
	// SubscriptionClosed is terminated (SUB-6, SUB-7).
	SubscriptionClosed SubscriptionState = "CLOSED"
)

// SubscriptionOptions is §7.1's options.
type SubscriptionOptions struct {
	// Mode defaults to 'exclusive' when empty.
	Mode SubscriptionMode `json:"mode,omitempty"`
	// Group is required when Mode is 'group' (SUB-4).
	Group string `json:"group,omitempty"`
	// Cursor is §6.2's anchor union. An empty value means the caller named no
	// anchor; §7.1's default is 'latest' for an exclusive subscription. For a
	// group member it means "whatever the group's position is", because CG-2
	// gives the group exactly one cursor and a joining member does not get to
	// move it.
	Cursor CursorAnchor `json:"cursor,omitempty"`
}

// Subscription is §7.1's subscription: a cursor, a state, and three operations
// over them.
//
// The handle is a thin view over a record held by the layer, which is where the
// mutex lives. Everything the caller can observe is either readonly (id, channel,
// mode, cursor, state) or one of §7.1's operations.
type Subscription struct {
	layer  *Interaction
	record *subscriptionRecord
}

// subscriptionRecord is a subscription's mutable state.
//
// `cursorPosition` and `scan` are two different things on purpose, and §6.4 is
// why: `cursorPosition` is the *confirmed* position, advanced only by ack, while
// `scan` is where delivery has reached. Collapsing them into one field is the
// mistake CR-3 names — the cursor would then advance on delivery, implicitly
// skipping unacknowledged positions.
type subscriptionRecord struct {
	id      string
	channel *channelRecord
	mode    SubscriptionMode
	// group is the ConsumerGroup this subscription belongs to, for group mode.
	group *groupRecord
	// cursorPosition is the confirmed position (§6.4). Unused in group mode,
	// where the group holds the one shared cursor (CG-2).
	cursorPosition uint64
	// scan is the position delivery will consider next: always the confirmed
	// position plus one after a cursor is set, and advanced as items are handed
	// out.
	scan uint64
	// retry holds positions that were handed out and then nacked. §6.4: "该项
	// 回到可用，并在下一次迭代重新投递".
	retry map[uint64]bool
	// pending maps a delivery handle to the live AckContext handed to the
	// caller.
	pending map[string]*delivery
	// suspended stops delivery without terminating anything (SUB-5).
	suspended bool
	// closed is terminal (SUB-6, SUB-7).
	closed bool
}

// Subscription returns the live Subscription for an id, for callers that hold the
// handle rather than the object.
func (l *Interaction) Subscription(subscriptionID string) (*Subscription, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	record, present := l.subscriptions[subscriptionID]
	if !present {
		return nil, errSubscriptionInvalid("no subscription with id %q", subscriptionID)
	}
	return &Subscription{layer: l, record: record}, nil
}

// OpenSubscription creates a Subscription on a Channel (§7.1).
//
// The rules, in the order they are applied:
//
//	SUB-4  mode 'group' MUST name a non-empty group    -> EAPP_SUBSCRIPTION_INVALID
//	SUB-1  the Channel MUST exist and be servable      -> EAPP_CHANNEL_INVALID /
//	                                                     EAPP_CHANNEL_CLOSED /
//	                                                     EAPP_CHANNEL_DRAINING
//	SUB-9  the cursor MUST be resolved before returning -> (eager resolution)
//	CC-9   / CG-8  group mode names a ConsumerGroup on this Channel
//
// §6.2 rule 5 is the reason resolution happens here rather than on first use: a
// subscription that returns without a cursor and resolves it later can hand the
// caller a `cursor` that is undefined *and* can defer a retention failure
// (EAPP_CURSOR_TOO_OLD) to a moment when the caller has no way to react.
func (l *Interaction) OpenSubscription(channelID string, options SubscriptionOptions) (*Subscription, error) {
	mode := options.Mode
	if mode == "" {
		mode = SubscriptionExclusive
	}
	if !mode.Valid() {
		return nil, errSubscriptionInvalid(
			"subscription mode MUST be exclusive or group (§7.1); got %q", string(options.Mode))
	}
	if mode == SubscriptionGroup && options.Group == "" {
		// SUB-4 / CG-8: a group subscription that names no group names nothing
		// to compete within.
		return nil, errSubscriptionInvalid(
			"mode 'group' MUST name a non-empty group (SUB-4, CG-8); use mode 'exclusive' or pass a group name")
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	channel, err := l.requireServable(channelID)
	if err != nil {
		return nil, err
	}

	l.subSeq++
	record := &subscriptionRecord{
		id:      "subscription-" + strconv.FormatUint(l.subSeq, 10),
		channel: channel,
		mode:    mode,
		retry:   make(map[uint64]bool),
		pending: make(map[string]*delivery),
	}

	if mode == SubscriptionExclusive {
		position, err := l.resolveExclusiveAnchor(channel, options.Cursor)
		if err != nil {
			return nil, err
		}
		record.cursorPosition = position
		record.scan = position + 1
	} else {
		group, err := l.joinableGroupLocked(channel, options.Group)
		if err != nil {
			return nil, err
		}
		if err := l.adoptGroupAnchorLocked(group, options.Cursor); err != nil {
			return nil, err
		}
		record.group = group
		group.members[record.id] = record
	}

	l.subscriptions[record.id] = record
	return &Subscription{layer: l, record: record}, nil
}

// resolveExclusiveAnchor resolves §7.1's `cursor` for an exclusive subscription.
//
// The default is 'latest' (§7.1), which is the Channel's current head: a new
// exclusive subscription starts at the present and sees what comes after it.
// 'earliest' is the earliest position the Channel can still serve (§6.2 rule 3),
// and anything else is a concrete cursor that MUST NOT be silently replaced when
// it has already been discarded (§6.2 rule 7).
func (l *Interaction) resolveExclusiveAnchor(channel *channelRecord, anchor CursorAnchor) (uint64, error) {
	if anchor == "" {
		anchor = AnchorLatest
	}
	return l.resolveAnchor(channel, anchor)
}

// adoptGroupAnchorLocked applies a joining member's anchor to its group.
//
// CG-2 gives a group exactly one cursor, so a member cannot have an anchor of its
// own — that is the whole difference between the two modes. The one moment the
// anchor is meaningful is when the group has not started: a group with no members
// and nothing confirmed has no history to be inconsistent with, and the member
// that arrives with an explicit anchor is stating where the group should begin.
// After that the anchor is ignored, which is what makes two members that were
// opened with different anchors agree on one cursor.
//
// Callers MUST hold l.mu.
func (l *Interaction) adoptGroupAnchorLocked(group *groupRecord, anchor CursorAnchor) error {
	if anchor == "" || !group.pristineLocked() {
		return nil
	}
	position, err := l.resolveAnchor(group.channel, anchor)
	if err != nil {
		return err
	}
	group.cursorPosition = position
	group.scan = position + 1
	return nil
}

// resolveAnchor turns §6.2's union into a concrete position.
func (l *Interaction) resolveAnchor(channel *channelRecord, anchor CursorAnchor) (uint64, error) {
	switch {
	case anchor.IsEarliest():
		floor, err := l.floorOf(channel)
		if err != nil {
			return 0, err
		}
		return positionOf(floor)
	case anchor.IsLatest():
		head, err := l.headOf(channel)
		if err != nil {
			return 0, err
		}
		return positionOf(head)
	default:
		return l.validateConcreteCursor(channel, Cursor(anchor))
	}
}

// validateConcreteCursor applies §6.2's retention table to a concrete cursor.
//
// The rule that matters is rule 7, and it is the one an implementation is tempted
// to soften: a cursor that was already discarded MUST fail with
// EAPP_CURSOR_TOO_OLD, and MUST NOT be quietly moved up to the retention floor.
// Quietly moving it produces a consumer that believes it resumed where it left off
// while the gap in between is lost forever — a silent data-loss bug that reports
// success. Failing is the whole point.
func (l *Interaction) validateConcreteCursor(channel *channelRecord, cursor Cursor) (uint64, error) {
	position, err := positionOf(cursor)
	if err != nil {
		return 0, err
	}
	floor, err := l.floorOf(channel)
	if err != nil {
		return 0, err
	}
	floorPosition, err := positionOf(floor)
	if err != nil {
		return 0, err
	}
	if position < floorPosition {
		return 0, errCursorTooOld(
			"cursor %s is earlier than the earliest retained position %s; it MUST NOT be silently replaced (§6.2 rule 7)",
			cursor, floor)
	}
	return position, nil
}

// floorOf asks the transport for the earliest position still serviceable.
//
// A transport that cannot answer is refused with EAPP_CURSOR_UNSUPPORTED (CR-5)
// rather than being assumed to retain everything: "probably the beginning" is not
// a position.
func (l *Interaction) floorOf(channel *channelRecord) (Cursor, error) {
	positions, ok := l.transport.(CursorPositions)
	if !ok {
		return "", errCursorUnsupported(
			"transport %q does not expose its retention floor, so 'earliest' cannot be resolved (§6.2 rule 3, CR-5)",
			l.transport.ID())
	}
	return positions.Floor(channel.id)
}

// headOf asks the transport for the Channel's current head (§6.2 rule 4).
func (l *Interaction) headOf(channel *channelRecord) (Cursor, error) {
	positions, ok := l.transport.(CursorPositions)
	if !ok {
		return "", errCursorUnsupported(
			"transport %q does not expose its head, so 'latest' cannot be resolved (§6.2 rule 4, CR-5)",
			l.transport.ID())
	}
	return positions.Head(channel.id)
}

// ID returns the subscription's handle.
func (s *Subscription) ID() string { return s.record.id }

// Channel returns the id of the Channel this subscription belongs to (SUB-1).
func (s *Subscription) Channel() string { return s.record.channel.id }

// Mode returns the subscription's mode.
func (s *Subscription) Mode() SubscriptionMode { return s.record.mode }

// Cursor returns the confirmed position (§6.1, §6.4).
//
// For a group member this is the *group's* cursor: CG-2 says all members of a
// group share exactly one, so a member that reported its own would be reporting
// something that does not exist.
func (s *Subscription) Cursor() Cursor {
	s.layer.mu.Lock()
	defer s.layer.mu.Unlock()
	return s.layer.cursorOf(s.record)
}

// cursorOf renders a subscription's confirmed position. Callers MUST hold l.mu.
func (l *Interaction) cursorOf(record *subscriptionRecord) Cursor {
	if record.group != nil {
		return formatCursor(record.group.cursorPosition)
	}
	return formatCursor(record.cursorPosition)
}

// State returns the subscription's state (§7.1).
func (s *Subscription) State() SubscriptionState {
	s.layer.mu.Lock()
	defer s.layer.mu.Unlock()
	return s.layer.subscriptionState(s.record)
}

// subscriptionState derives a subscription's state. Callers MUST hold l.mu.
//
// It is derived rather than stored for the same reason a Channel's is (§2.4):
// a subscription MUST NOT exist independently of its Channel (SUB-1) or of its
// ConsumerGroup (CG-7), and a stored state would have to be repaired from two
// different places every time one of those closed.
func (l *Interaction) subscriptionState(record *subscriptionRecord) SubscriptionState {
	if l.subscriptionTerminated(record) {
		return SubscriptionClosed
	}
	if record.suspended {
		return SubscriptionSuspended
	}
	return SubscriptionActive
}

// subscriptionTerminated reports whether a subscription can no longer deliver.
// Callers MUST hold l.mu.
func (l *Interaction) subscriptionTerminated(record *subscriptionRecord) bool {
	if record.closed {
		return true
	}
	if record.group != nil && record.group.closed {
		return true
	}
	return l.stateOf(record.channel) == ChannelClosed
}

// CursorState returns §6.1's {cursor, pending} for a subscription: the confirmed
// position plus the received-but-unacknowledged positions.
func (s *Subscription) CursorState() CursorState {
	s.layer.mu.Lock()
	defer s.layer.mu.Unlock()

	record := s.record
	state := CursorState{Cursor: s.layer.cursorOf(record), Pending: []Cursor{}}
	for _, pending := range record.pending {
		if pending.settled() {
			continue
		}
		state.Pending = append(state.Pending, pending.cursor)
	}
	sort.Slice(state.Pending, func(i, j int) bool { return state.Pending[i] < state.Pending[j] })
	return state
}

// Next returns the next item, or reports that nothing is available or that the
// subscription has ended (§7.1's iteration).
//
// Three outcomes, and the difference between them is load-bearing:
//
//	(item, done=false)  there is something to consume
//	(nil,   done=false) nothing is available *right now*      — not an error
//	(nil,   done=true)  the subscription is terminated
//
// The middle case MUST NOT be an error: reading a log with no new message is the
// normal condition of a stream, and §10.1's TR-7 states the same rule one layer
// down ("无匹配 MUST 返回空数组，MUST NOT 阻塞").
func (s *Subscription) Next() (*Item, bool, error) {
	layer := s.layer
	layer.mu.Lock()
	defer layer.mu.Unlock()

	record := s.record
	if layer.subscriptionTerminated(record) {
		return nil, true, nil
	}
	if record.suspended {
		// SUB-5: after suspend() nothing is delivered until resume().
		return nil, false, nil
	}

	delivered, err := layer.nextDelivery(record)
	if err != nil {
		return nil, false, err
	}
	if delivered == nil {
		return nil, false, nil
	}
	return &Item{Cursor: delivered.cursor, Payload: delivered.payload, context: delivered}, false, nil
}

// nextDelivery finds the next item to hand out. Callers MUST hold l.mu.
func (l *Interaction) nextDelivery(record *subscriptionRecord) (*delivery, error) {
	if record.group != nil {
		return l.nextGroupDelivery(record)
	}
	return l.nextExclusiveDelivery(record)
}

// nextExclusiveDelivery implements the delivery scan of an exclusive
// subscription.
//
// Order of consideration, and why:
//
//  1. A nacked position first, because §6.4 says a nacked item "回到可用，并在下一次
//     迭代重新投递" — redelivering it before anything newer is what makes the
//     promise true.
//  2. The first message at or after `scan`, which is the ordinary forward read.
//
// Nothing here consults the confirmed cursor to decide *what* to deliver, and that
// is deliberate: CR-3 forbids an *implicit* skip, but §6.4 requires an
// acknowledgement of a later position to be accepted, so delivery must be able to
// run ahead of the confirmed cursor. Tying the scan to the first unacknowledged
// position would make §6.4's explicit skip unreachable and is exactly the
// implementation §6.4 declares a violation.
func (l *Interaction) nextExclusiveDelivery(record *subscriptionRecord) (*delivery, error) {
	if position, ok := minPosition(record.retry); ok {
		delete(record.retry, position)
		message, found, err := l.messageAt(record.channel, position)
		if err != nil {
			return nil, err
		}
		if !found {
			// The message is gone (a transport with retention discarded it
			// between the nack and this read). Skip it rather than delivering
			// something else in its place.
			return l.nextExclusiveDelivery(record)
		}
		return l.deliver(record, record.channel, message, position), nil
	}

	message, found, err := l.messageAtOrAfter(record.channel, record.scan)
	if err != nil || !found {
		return nil, err
	}
	position, err := positionOfMessage(message)
	if err != nil {
		return nil, err
	}
	record.scan = position + 1
	return l.deliver(record, record.channel, message, position), nil
}

// messageAt returns the message at an exact position, if the transport still has
// it. Callers MUST hold l.mu.
func (l *Interaction) messageAt(channel *channelRecord, position uint64) (TransportMessage, bool, error) {
	messages, err := l.messagesAtOrAfter(channel, position)
	if err != nil {
		return TransportMessage{}, false, err
	}
	for _, message := range messages {
		messagePosition, err := positionOfMessage(message)
		if err != nil {
			return TransportMessage{}, false, err
		}
		if messagePosition == position {
			return message, true, nil
		}
		if messagePosition > position {
			break
		}
	}
	return TransportMessage{}, false, nil
}

// messageAtOrAfter returns the first message at or after a position.
// Callers MUST hold l.mu.
func (l *Interaction) messageAtOrAfter(channel *channelRecord, position uint64) (TransportMessage, bool, error) {
	messages, err := l.messagesAtOrAfter(channel, position)
	if err != nil {
		return TransportMessage{}, false, err
	}
	if len(messages) == 0 {
		return TransportMessage{}, false, nil
	}
	return messages[0], true, nil
}

// deliver registers a delivery for an exclusive subscription. Callers MUST hold
// l.mu.
func (l *Interaction) deliver(record *subscriptionRecord, channel *channelRecord, message TransportMessage, position uint64) *delivery {
	l.deliverySeq++
	created := &delivery{
		handle:       "delivery-" + strconv.FormatUint(l.deliverySeq, 10),
		position:     position,
		cursor:       message.Cursor,
		payload:      message.Payload,
		layer:        l,
		subscription: record,
	}
	record.pending[created.handle] = created
	l.deliveries[created.handle] = created
	return created
}

// minPosition returns the smallest key of a position set.
func minPosition(positions map[uint64]bool) (uint64, bool) {
	found := false
	var smallest uint64
	for position := range positions {
		if !found || position < smallest {
			smallest = position
			found = true
		}
	}
	return smallest, found
}

// Ack settles one item, addressed by its delivery handle (§9, AK-1 … AK-5).
//
// The handle rather than the Item is taken here because the driver protocol
// models an AckContext as an opaque token: a caller in another process holds the
// token, not the object.
func (s *Subscription) Ack(deliveryHandle string) error {
	layer := s.layer
	layer.mu.Lock()
	pending, present := s.record.pending[deliveryHandle]
	layer.mu.Unlock()
	if !present {
		return errSubscriptionInvalid(
			"delivery %q is not outstanding on subscription %s (§9)", deliveryHandle, s.record.id)
	}
	return layer.ack(pending)
}

// Nack rejects one item, addressed by its delivery handle (§9, AK-2 … AK-5).
func (s *Subscription) Nack(deliveryHandle string) error {
	layer := s.layer
	layer.mu.Lock()
	pending, present := s.record.pending[deliveryHandle]
	layer.mu.Unlock()
	if !present {
		return errSubscriptionInvalid(
			"delivery %q is not outstanding on subscription %s (§9)", deliveryHandle, s.record.id)
	}
	return layer.nack(pending)
}

// ack is the single acknowledgement path: the subscription's handle-addressed
// form and the Item's AckContext both arrive here.
func (l *Interaction) ack(settled *delivery) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ackLocked(settled, l.now())
}

// ackLocked implements §9's ack table. Callers MUST hold l.mu.
//
//	AK-1  ack() MUST be idempotent                       -> second ack is a no-op
//	AK-4  nack() 之后 MUST NOT allow ack()                -> EAPP_LEASE_CLOSED
//	AK-5  a call conflicting with a terminated context   -> EAPP_LEASE_CLOSED
//	SUB-8 after close(), acking a yielded item is a no-op that changes nothing
//	L-7   an expired lease MUST NOT affect a new lease   -> EAPP_LEASE_EXPIRED
//	§6.4  cursor = max(cursor, c)
//
// The ordering of the checks is the interesting part. A *conflict* is reported
// even after the subscription closed (a settled item answered the other way is a
// contradiction, not a no-op), while an *ordinary* settlement after close is the
// no-op SUB-8 requires.
func (l *Interaction) ackLocked(settled *delivery, now time.Time) error {
	if l.leaseLost(settled) {
		// The claim lapsed and the position went to someone else. Letting this
		// acknowledgement land would settle an item another member is holding —
		// exactly what L-7 forbids.
		return errLeaseExpired(
			"the claim on position %s lapsed and the position was claimed again; an expired lease MUST NOT affect a new one (L-6, L-7)",
			settled.cursor)
	}
	switch {
	case settled.nacked:
		return errLeaseClosed(
			"ack() after nack() MUST NOT be allowed; the AckContext is terminated (AK-4, AK-5)")
	case settled.acked:
		return nil // AK-1
	}
	if settled.detached || l.subscriptionTerminated(settled.subscription) {
		// SUB-8: after close() an ack on an already-yielded item is a no-op —
		// it MUST NOT fail and MUST NOT move the cursor.
		return nil
	}

	settled.acked = true
	if settled.group != nil {
		l.settleClaimLocked(settled)
		return nil
	}
	// §6.4: the cursor becomes max(current, this position) — an explicit skip of
	// everything unacknowledged in between, which MUST be allowed.
	delete(settled.subscription.retry, settled.position)
	if settled.position > settled.subscription.cursorPosition {
		settled.subscription.cursorPosition = settled.position
	}
	return nil
}

// nack is the single rejection path.
func (l *Interaction) nack(rejected *delivery) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.nackLocked(rejected, l.now())
}

// nackLocked implements §9's nack table. Callers MUST hold l.mu.
//
//	AK-2  nack() MUST be idempotent                  -> second nack is a no-op
//	AK-3  ack() 之后 MUST NOT allow nack()            -> EAPP_LEASE_CLOSED
//	§6.4  nack MUST NOT advance the cursor, and the item returns to the available
//	      set for redelivery
func (l *Interaction) nackLocked(rejected *delivery, now time.Time) error {
	if l.leaseLost(rejected) {
		return errLeaseExpired(
			"the claim on position %s lapsed and the position was claimed again (L-6, L-7)",
			rejected.cursor)
	}
	switch {
	case rejected.acked:
		return errLeaseClosed(
			"nack() after ack() MUST NOT be allowed; the AckContext is terminated (AK-3, AK-5)")
	case rejected.nacked:
		return nil // AK-2
	}
	if rejected.detached || l.subscriptionTerminated(rejected.subscription) {
		return nil
	}

	rejected.nacked = true
	if rejected.group != nil {
		l.releaseClaimLocked(rejected)
		return nil
	}
	rejected.subscription.retry[rejected.position] = true
	return nil
}

// leaseLost reports whether an item's claim was superseded. Callers MUST hold
// l.mu.
//
// The test is not "has the expiry time passed" but "did anyone else receive this
// position after us", because that is what L-7 is about: an expired lease MUST NOT
// affect a new one. A lease that lapsed while nobody claimed the position harms
// nobody by settling, whereas one that lapsed and was handed on would let two
// members settle one item.
func (l *Interaction) leaseLost(settled *delivery) bool {
	if settled.group == nil {
		return false
	}
	return settled.group.served[settled.position] != settled
}

// renew implements §5's renew() for the lease behind an item.
func (l *Interaction) renew(settled *delivery, ttl time.Duration) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if ttl <= 0 {
		return errSubscriptionInvalid("renew() requires a positive ttl (§5)")
	}
	if settled.lease == nil {
		return errLeaseClosed(
			"this item carries no lease: only a ConsumerGroup claim is a Lease (§5, §8.3)")
	}
	if settled.settled() || settled.detached || l.subscriptionTerminated(settled.subscription) {
		// L-5: renew is only defined for an ACTIVE lease.
		return errLeaseClosed("renew() applies only to an ACTIVE lease (L-5)")
	}
	if l.leaseLost(settled) {
		return errLeaseExpired("the claim lapsed and the position was claimed again (L-6, L-7)")
	}
	// L-5 is stated over the lease being ACTIVE, so a lapsed claim is refused
	// here even though nobody has taken the position: extending ownership is
	// granting it again, and a lease that has expired is exactly the thing L-5
	// says may not be renewed. (Settling such a claim is a different question —
	// see leaseLost — because §6.4 puts no expiry on an acknowledgement.)
	if !settled.lease.Active(now) {
		return errLeaseExpired(
			"the lease on position %s expired at %s and MUST NOT be renewed (L-5, L-6)",
			settled.cursor, settled.lease.ExpiresAt.UTC().Format(time.RFC3339Nano))
	}
	settled.lease.ExpiresAt = now.Add(ttl)
	if claim, present := settled.group.claims[settled.position]; present && claim.lease == settled.lease {
		claim.lease.ExpiresAt = settled.lease.ExpiresAt
	}
	return nil
}

// Suspend stops delivery without terminating the subscription (§7.2, SUB-5).
//
// Items already handed out stay valid: their AckContexts remain usable, because
// §7.2 says so in as many words ("已 yield 未 ack 的项仍然有效").
func (s *Subscription) Suspend() error {
	layer := s.layer
	layer.mu.Lock()
	defer layer.mu.Unlock()
	if layer.subscriptionTerminated(s.record) {
		// A terminated subscription has nothing to stop. It is not an error: the
		// caller asked for a state the subscription is already past.
		return nil
	}
	s.record.suspended = true
	return nil
}

// Resume continues delivery (§7.2, SUB-5).
//
// "从当前 cursor 继续；MUST NOT 重投已 ack 的项" — the clause that matters here is
// the negative one: an acknowledged item is gone. Delivery continues from the
// scan position, which is at or after the confirmed cursor, so nothing already
// acknowledged is handed out again. Positions handed out and not yet settled are
// *not* rewound either: §7.2 allows redelivery of those but does not require it,
// and rewinding would make the one guarantee it does state ("MUST NOT re-deliver
// what was acked") the only thing resume could be trusted to do.
func (s *Subscription) Resume() error {
	layer := s.layer
	layer.mu.Lock()
	defer layer.mu.Unlock()
	if layer.subscriptionTerminated(s.record) {
		return nil
	}
	s.record.suspended = false
	return nil
}

// Close terminates the subscription (§7.2, SUB-6, SUB-7).
//
// Idempotent by construction: the second call finds `closed` already set and does
// nothing, which is the only way to make SUB-6 true without a case analysis. A
// member of a group also gives back everything it holds (CG-5): a member that
// left while holding claims must not stall the group until those claims time out.
func (s *Subscription) Close() error {
	layer := s.layer
	layer.mu.Lock()
	defer layer.mu.Unlock()
	if s.record.closed {
		return nil // SUB-6
	}
	layer.closeSubscriptionLocked(s.record)
	return nil
}

// closeSubscriptionLocked terminates a subscription and releases what it holds.
// Callers MUST hold l.mu.
func (l *Interaction) closeSubscriptionLocked(record *subscriptionRecord) {
	record.closed = true
	record.suspended = false
	// Everything handed out becomes detached: SUB-8 says a later ack on a yielded
	// item is a no-op that changes nothing. Without this, closing a subscription
	// could still move a cursor.
	for _, pending := range record.pending {
		pending.detached = true
	}
	if record.group != nil {
		// CG-5: a member leaving MUST NOT stall the group, so its claims return
		// to the group immediately rather than at their expiry.
		for position, claim := range record.group.claims {
			if claim.holder == record.id {
				delete(record.group.claims, position)
				if claim.lease != nil {
					claim.lease.delivery.detached = true
				}
				if !record.group.closed {
					record.group.retry[position] = true
				}
			}
		}
		delete(record.group.members, record.id)
	}
}
