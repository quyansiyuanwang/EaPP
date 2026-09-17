package eapp

import (
	"strconv"
	"time"
)

// DefaultClaimTTL is §8.2's default for `claimTtlMs`: how long one member may
// hold a claim before the position goes back to the group.
//
// It is 30 seconds because §8.2 says so. The value is a compromise the spec
// states rather than derives: too short and a slow-but-alive member loses work it
// is still doing, too long and a crashed member holds a position nobody can
// touch.
const DefaultClaimTTL = 30 * time.Second

// ConsumerGroupOptions is §8.2's group configuration.
type ConsumerGroupOptions struct {
	// Name is unique within the Channel (CG-1).
	Name string `json:"name"`
	// ClaimTTL is how long one claim may be held; MUST be > 0 (§8.2).
	ClaimTTL time.Duration `json:"-"`
}

// Group is §8.2's ConsumerGroup: its identity, its one shared cursor, and how
// many members are competing within it.
//
// `Cursor` and `MemberCount` are synchronous properties of a shared object: §8.2
// freezes their shape, so this value reports what the group held at the moment it
// was read. There is no "watch the group" operation and no promise that two reads
// agree.
type Group struct {
	// ID is the group's handle.
	ID string `json:"id"`
	// Name is unique within the Channel (CG-1).
	Name string `json:"name"`
	// Channel is the Channel the group belongs to (CG-7: it MUST NOT exist
	// without one).
	Channel string `json:"channel"`
	// Cursor is the group's shared position: the greatest position its members
	// have acknowledged (§8.3).
	Cursor Cursor `json:"cursor"`
	// MemberCount is how many members are currently competing.
	MemberCount int `json:"memberCount"`
}

// groupRecord is a ConsumerGroup's mutable state.
type groupRecord struct {
	id       string
	name     string
	channel  *channelRecord
	claimTTL time.Duration

	// cursorPosition is the group's one cursor (§8.3): the maximum position its
	// members have acknowledged.
	//
	// It is emphatically NOT the smallest unsettled position. §8.3 forbids that
	// substitution in as many words, and the reason is stated there: a single
	// member that fell behind would hold the whole group's position back
	// forever. The maximum is also what keeps the group's cursor consistent with
	// §6.4 — a member acknowledging a later position is declaring everything
	// before it settled.
	cursorPosition uint64
	// settled records that at least one acknowledgement has moved the cursor,
	// which is one of the two things that end the group's "pristine" state (see
	// pristineLocked).
	settled bool
	// scan is the position the group will consider handing out next.
	scan uint64
	// claims are the positions currently held, one claim per position, which is
	// how CG-3 and L-2 hold: there is no second place a claim can be created.
	claims map[uint64]*claim
	// retry holds positions that came back to the group: nacked (CG-6) or
	// released because their claim lapsed (CG-6) or because their member left
	// (CG-5).
	retry map[uint64]bool
	// served remembers, for each position, the last delivery handed out for it.
	// It is what makes L-7 checkable: a delivery that is no longer the one
	// `served` names has lost its claim to someone else, and MUST NOT settle
	// anything.
	served map[uint64]*delivery
	// members are the subscriptions competing inside the group.
	members map[string]*subscriptionRecord
	// closed is terminal for the group. Unlike a Binding it is not a spec-level
	// state (§8 has no group lifecycle); it exists so that a closed group cannot
	// silently keep competing, and because CG-7 requires a group to die with its
	// Channel.
	closed bool
}

// claim is one member's temporary ownership of one position (§8.3: a claim *is* a
// Lease).
type claim struct {
	position uint64
	holder   string
	lease    *Lease
}

// pristineLocked reports whether a group has not started yet.
//
// "Pristine" is the one moment a member's cursor anchor is honoured (see
// adoptGroupAnchorLocked): no member has joined, no acknowledgement has landed,
// and nothing is claimed. After that the group has a position of its own and CG-2
// says it has exactly one.
//
// Callers MUST hold l.mu.
func (g *groupRecord) pristineLocked() bool {
	return !g.settled && len(g.members) == 0 && len(g.claims) == 0
}

// OpenGroup creates a ConsumerGroup on a Channel (§8.2).
//
// CG-1 makes a group's name unique within its Channel, and this implementation
// enforces that by refusing a second creation with EAPP_SUBSCRIPTION_INVALID
// rather than by handing back the group that already holds the name.
//
// The reading matters because it decides what CG-8 can mean. If `group.open` on an
// existing name succeeded, "MUST name an existing ConsumerGroup" would still hold,
// but nothing would ever fail on the creation path, and a group would be
// indistinguishable from a name. Refusing keeps `group.open` and joining two
// distinct acts: `group.open` states where a group begins, and
// `subscription.open {mode: 'group', group: …}` joins one that exists.
//
// The name is unique per *Channel* (CG-1), so two Channels may each have a group
// named "workers", and their cursors are unrelated (CG-4).
func (l *Interaction) OpenGroup(channelID, name string, claimTTL time.Duration) (Group, error) {
	if name == "" {
		return Group{}, errSubscriptionInvalid("a ConsumerGroup MUST have a non-empty name (§8.2, CG-1)")
	}
	if claimTTL < 0 {
		return Group{}, errSubscriptionInvalid("claimTtlMs MUST be > 0 (§8.2); got %d", claimTTL)
	}
	if claimTTL == 0 {
		claimTTL = DefaultClaimTTL
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	channel, err := l.requireServable(channelID)
	if err != nil {
		return Group{}, err
	}
	if existing, present := l.groupNamedLocked(channel, name); present {
		return Group{}, errSubscriptionInvalid(
			"a ConsumerGroup named %q already exists on channel %s (CG-1); the existing group is %s",
			name, channel.id, existing.id)
	}
	group, err := l.createGroupLocked(channel, name, claimTTL)
	if err != nil {
		return Group{}, err
	}
	return l.groupSnapshotLocked(group), nil
}

// joinableGroupLocked resolves the group a `mode: 'group'` subscription names.
//
// CG-8: the subscription MUST name an existing ConsumerGroup on the same Channel.
// It does not create one — a subscription that silently brought a group into
// existence would make "names an existing group" unobservable, and would put the
// group's start position under the control of whoever happened to subscribe first
// rather than of `group.open`.
//
// Callers MUST hold l.mu.
func (l *Interaction) joinableGroupLocked(channel *channelRecord, name string) (*groupRecord, error) {
	group, present := l.groupNamedLocked(channel, name)
	if !present {
		return nil, errSubscriptionInvalid(
			"no ConsumerGroup named %q exists on channel %s; a group-mode subscription MUST name one (CG-8)",
			name, channel.id)
	}
	return group, nil
}

// groupNamedLocked finds the open group of a name on a Channel.
//
// A CLOSED group does not count as holding its name: matching §6.8's uniqueness
// domain ("the set of non-CLOSED bindings"), a name becomes available again once
// the group that held it is gone.
//
// Callers MUST hold l.mu.
func (l *Interaction) groupNamedLocked(channel *channelRecord, name string) (*groupRecord, bool) {
	for _, group := range l.groups {
		if group.channel == channel && group.name == name && !group.closed {
			return group, true
		}
	}
	return nil, false
}

// createGroupLocked registers a new group. Callers MUST hold l.mu.
func (l *Interaction) createGroupLocked(channel *channelRecord, name string, claimTTL time.Duration) (*groupRecord, error) {
	if claimTTL <= 0 {
		claimTTL = DefaultClaimTTL
	}
	l.groupSeq++
	group := &groupRecord{
		id:       "group-" + strconv.FormatUint(l.groupSeq, 10),
		name:     name,
		channel:  channel,
		claimTTL: claimTTL,
		// A new group starts at the earliest position the Channel can still
		// serve (§6.2 rule 3), not at the head.
		//
		// §8.1 says what a group is for: "组之间：每个组都收到全部消息" — each
		// group receives *all* the messages, and groups do not divide the stream
		// among themselves. A group that started at the head would satisfy that
		// sentence only for messages sent after it was created, and would make
		// the group's own history — the part a cursor exists to resume from
		// (SUB-9, CR-4) — unreadable. A member that wants to start at the present
		// says so with cursor: 'latest', which is honoured while the group is
		// pristine.
		cursorPosition: 0,
		scan:           0,
		claims:         make(map[uint64]*claim),
		retry:          make(map[uint64]bool),
		served:         make(map[uint64]*delivery),
		members:        make(map[string]*subscriptionRecord),
	}
	l.groups[group.id] = group
	return group, nil
}

// Group returns a ConsumerGroup by handle (§8.2's `group.view`).
func (l *Interaction) Group(groupID string) (Group, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	group, present := l.groups[groupID]
	if !present {
		return Group{}, errSubscriptionInvalid("no consumer group with id %q", groupID)
	}
	// CG-7 first: a group whose Channel is gone is not a closed group, it is a
	// group that MUST NOT exist. Reporting it as merely closed would hide which
	// precondition failed.
	if l.stateOf(group.channel) == ChannelClosed {
		return Group{}, errChannelClosed(
			"consumer group %s belongs to channel %s, which is CLOSED; a group MUST NOT exist independently of its Channel (CG-7)",
			group.id, group.channel.id)
	}
	if group.closed {
		return Group{}, errSubscriptionInvalid("consumer group %s is closed", groupID)
	}
	return l.groupSnapshotLocked(group), nil
}

// CloseGroup closes a ConsumerGroup (§8.2).
//
// It is idempotent, like every other close in this layer. Its members are
// terminated with it, because a member's only way to consume is through its
// group: leaving them running would leave subscriptions reading a group that no
// longer exists, which is CG-7's prohibition one level down.
func (l *Interaction) CloseGroup(groupID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	group, present := l.groups[groupID]
	if !present {
		return errSubscriptionInvalid("no consumer group with id %q", groupID)
	}
	if group.closed {
		return nil
	}
	l.closeGroupLocked(group)
	return nil
}

// closeGroupLocked terminates a group and everything in it. Callers MUST hold
// l.mu.
func (l *Interaction) closeGroupLocked(group *groupRecord) {
	group.closed = true
	members := make([]*subscriptionRecord, 0, len(group.members))
	for _, member := range group.members {
		members = append(members, member)
	}
	for _, member := range members {
		l.closeSubscriptionLocked(member)
	}
	group.claims = make(map[uint64]*claim)
	group.retry = make(map[uint64]bool)
}

// groupSnapshotLocked renders the §8.2 value. Callers MUST hold l.mu.
func (l *Interaction) groupSnapshotLocked(group *groupRecord) Group {
	return Group{
		ID:          group.id,
		Name:        group.name,
		Channel:     group.channel.id,
		Cursor:      formatCursor(group.cursorPosition),
		MemberCount: len(group.members),
	}
}

// nextGroupDelivery hands the next available position to one member (§8).
//
// The order is the same shape as the exclusive scan, with one addition: positions
// that came back to the group are considered before new ones, because CG-6 says a
// nacked or timed-out position "MUST 重新对该组可用" — available means available to
// the next member that asks, not to some later one.
func (l *Interaction) nextGroupDelivery(record *subscriptionRecord) (*delivery, error) {
	group := record.group
	l.sweepExpiredClaimsLocked(group, l.now())

	if position, ok := minPosition(group.retry); ok {
		delete(group.retry, position)
		message, found, err := l.messageAt(group.channel, position)
		if err != nil {
			return nil, err
		}
		if !found {
			// The position is no longer in the log (retention discarded it).
			// Nothing is delivered in its place: a substitution would hand the
			// member a message it did not ask for under the cursor it did.
			return l.nextGroupDelivery(record)
		}
		return l.claimLocked(group, record, message, position), nil
	}

	message, found, err := l.messageAtOrAfter(group.channel, group.scan)
	if err != nil || !found {
		return nil, err
	}
	position, err := positionOfMessage(message)
	if err != nil {
		return nil, err
	}
	group.scan = position + 1
	return l.claimLocked(group, record, message, position), nil
}

// claimLocked gives one position to one member and records the lease. Callers
// MUST hold l.mu.
//
// This function is the only place a claim is created, which is what makes CG-3
// ("一条消息在同一时刻 MUST NOT 被同一组的多个成员同时持有") and L-2 ("同一 cursor 在
// 任意时刻 MUST NOT 被多个 ACTIVE Lease 持有") the same fact: a position leaves the
// available set the instant it is claimed, and the group's `scan` has already
// moved past it.
func (l *Interaction) claimLocked(group *groupRecord, record *subscriptionRecord, message TransportMessage, position uint64) *delivery {
	l.leaseSeq++
	l.deliverySeq++

	lease := &Lease{
		ID:        "lease-" + strconv.FormatUint(l.leaseSeq, 10),
		Cursor:    message.Cursor,
		ExpiresAt: l.now().Add(group.claimTTL),
	}
	created := &delivery{
		handle:       "delivery-" + strconv.FormatUint(l.deliverySeq, 10),
		position:     position,
		cursor:       message.Cursor,
		payload:      message.Payload,
		layer:        l,
		subscription: record,
		group:        group,
		lease:        lease,
	}
	lease.delivery = created

	group.claims[position] = &claim{position: position, holder: record.id, lease: lease}
	// Overwriting `served` is what retires the previous delivery for this
	// position: it is now the old one, and leaseLost says so.
	group.served[position] = created
	record.pending[created.handle] = created
	l.deliveries[created.handle] = created
	return created
}

// sweepExpiredClaimsLocked returns every lapsed claim to the group (L-6, CG-6).
//
// Expiry is evaluated when the group is asked for work rather than by a timer.
// That is not a shortcut: a timer would have to take the layer's mutex from a
// goroutine, and L-6 only requires that a lapsed position *may* be claimed again —
// which is exactly what this makes true at the moment it matters.
//
// A lapsed claim does not mark its delivery as lost. L-7 ("过期的 Lease MUST NOT
// 影响新 Lease") is about affecting a *new* lease, so a claim that lapsed while
// nobody else wanted the position can still be settled by its holder: no second
// owner exists to be affected. What retires the old delivery is a *new* one being
// handed out for the same position, which `served` records.
//
// Callers MUST hold l.mu.
func (l *Interaction) sweepExpiredClaimsLocked(group *groupRecord, now time.Time) {
	for position, held := range group.claims {
		if held.lease == nil || held.lease.ExpiresAt.IsZero() || now.Before(held.lease.ExpiresAt) {
			continue
		}
		delete(group.claims, position)
		if !group.closed {
			// CG-6: a timed-out position MUST become available to the group
			// again.
			group.retry[position] = true
		}
	}
}

// settleClaimLocked records an acknowledged claim. Callers MUST hold l.mu.
//
// §8.3: the group cursor is the maximum position acknowledged within the group.
// Taking the maximum — rather than, say, the minimum of what is left — is what
// §8.3 requires and what §6.4 already decided for a single cursor: an
// acknowledgement of a later position declares everything before it settled, and
// the unacknowledged positions in between are explicitly abandoned.
func (l *Interaction) settleClaimLocked(settled *delivery) {
	group := settled.group
	delete(group.claims, settled.position)
	delete(group.retry, settled.position)
	group.settled = true
	if settled.position > group.cursorPosition {
		group.cursorPosition = settled.position
	}
}

// releaseClaimLocked returns a rejected claim to the group (CG-6).
//
// The cursor is untouched: §6.4 says nack MUST NOT advance it.
func (l *Interaction) releaseClaimLocked(rejected *delivery) {
	group := rejected.group
	delete(group.claims, rejected.position)
	if !group.closed {
		group.retry[rejected.position] = true
	}
}
