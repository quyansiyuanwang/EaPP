package eapp

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Test layout: one test function per invariant of v3.1 §14, named after its id,
// so that a reviewer can diff the invariant list (CH-1 … CC-9) against this file
// directly.
//
// The tests drive the layer through its exported API only, exactly as an
// integrator would. That is deliberate: the invariants are statements about
// observable behaviour, and a test that reached into the layer's records could
// pass while the API was wrong.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// interactionFixture is a Core with one ACTIVE Binding and a Channel over it.
type interactionFixture struct {
	core     *Core
	layer    *Interaction
	binding  string
	provider Plugin
	consumer Plugin
	channel  Channel
}

// newInteractionFixture builds the composition a Channel needs: two ACTIVE
// plugins, one exposing a capability, bound, and a Channel created and connected.
//
// `mode` selects the Channel's mode; stream is the usual choice in these tests
// because it is the mode whose delivery guarantee makes acknowledgement
// meaningful (DL-4), which is what most of §6, §7 and §9 is about.
func newInteractionFixture(t *testing.T, mode ChannelMode) *interactionFixture {
	t.Helper()
	core := NewCore()
	capability := capabilityOf("casing.apply", "1.0.0")
	provider, consumer := activePair(t, core, capability)

	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: capability.Name, Version: capability.Version},
	})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}

	layer := NewInteraction(core)
	channel, err := layer.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: mode})
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	channel, err = layer.ConnectChannel(channel.ID)
	if err != nil {
		t.Fatalf("connect channel: %v", err)
	}
	if channel.State != ChannelActive {
		t.Fatalf("connected channel is %s, want ACTIVE", channel.State)
	}
	return &interactionFixture{
		core:     core,
		layer:    layer,
		binding:  binding.ID,
		provider: provider,
		consumer: consumer,
		channel:  channel,
	}
}

// send appends a message and returns its cursor.
func (f *interactionFixture) send(t *testing.T, payload any) Cursor {
	t.Helper()
	cursor, err := f.layer.Send(f.channel.ID, payload)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	return cursor
}

// open opens an exclusive subscription on the fixture's Channel.
func (f *interactionFixture) open(t *testing.T, anchor CursorAnchor) *Subscription {
	t.Helper()
	subscription, err := f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{Cursor: anchor})
	if err != nil {
		t.Fatalf("open subscription: %v", err)
	}
	return subscription
}

// pull returns the next item, failing when the subscription reports termination.
func (f *interactionFixture) pull(t *testing.T, subscription *Subscription) Item {
	t.Helper()
	item, done, err := subscription.Next()
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if done {
		t.Fatalf("subscription is done, expected an item")
	}
	if item == nil {
		t.Fatalf("no item available, expected one")
	}
	return *item
}

// state reads a Channel's state.
func (f *interactionFixture) state(t *testing.T) ChannelState {
	t.Helper()
	channel, err := f.layer.Channel(f.channel.ID)
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	return channel.State
}

// ---------------------------------------------------------------------------
// Channel — §2, CH-1 … CH-6
// ---------------------------------------------------------------------------

func TestCH1AChannelCorrespondsToExactlyOneBinding(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	channel, err := f.layer.Channel(f.channel.ID)
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	if channel.Binding != f.binding {
		t.Fatalf("channel.binding = %q, want %q", channel.Binding, f.binding)
	}
	ref, err := f.layer.ChannelRef(f.channel.ID)
	if err != nil {
		t.Fatalf("channelRef: %v", err)
	}
	if ref.ID != channel.ID || ref.Binding != f.binding {
		t.Fatalf("channelRef = %+v, want {%s %s}", ref, channel.ID, f.binding)
	}
}

func TestCH2AChannelMustNotOutliveItsBinding(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	if err := f.core.Unbind(f.binding); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	if got := f.state(t); got != ChannelClosed {
		t.Fatalf("channel state after unbind = %s, want CLOSED (CH-2, CC-2)", got)
	}
}

func TestCH3ClosedIsTerminal(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	if err := f.layer.CloseChannel(f.channel.ID); err != nil {
		t.Fatalf("close: %v", err)
	}
	if got := f.state(t); got != ChannelClosed {
		t.Fatalf("state = %s, want CLOSED", got)
	}
	_, err := f.layer.ConnectChannel(f.channel.ID)
	wantCode(t, err, CodeChannelClosed)
	if _, err := f.layer.Send(f.channel.ID, "after-close"); err == nil {
		t.Fatal("sending on a CLOSED channel MUST fail (CH-3)")
	} else {
		wantCode(t, err, CodeChannelClosed)
	}
	if got := f.state(t); got != ChannelClosed {
		t.Fatalf("state = %s, want CLOSED", got)
	}
}

func TestCH4CloseIsIdempotent(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	for i := 0; i < 3; i++ {
		if err := f.layer.CloseChannel(f.channel.ID); err != nil {
			t.Fatalf("close #%d: %v", i+1, err)
		}
	}
}

func TestCH5ModeMustNotChangeDuringLifetime(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	f.pull(t, subscription)
	if err := f.layer.CloseChannel(f.channel.ID); err != nil {
		t.Fatalf("close: %v", err)
	}
	channel, err := f.layer.Channel(f.channel.ID)
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	if channel.Mode != ModeStream {
		t.Fatalf("mode = %q, want stream", channel.Mode)
	}
}

func TestCH6DeliveryMustNotChangeDuringLifetime(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	f.pull(t, subscription)
	if err := f.layer.CloseChannel(f.channel.ID); err != nil {
		t.Fatalf("close: %v", err)
	}
	channel, err := f.layer.Channel(f.channel.ID)
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	if channel.Delivery != DeliveryAtLeastOnce {
		t.Fatalf("delivery = %q, want at-least-once", channel.Delivery)
	}
}

// ---------------------------------------------------------------------------
// The creation path — §12, CC-1 … CC-9
// ---------------------------------------------------------------------------

func TestCC2BindingStateIsMirroredByChannelState(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)

	// ACTIVE -> DRAINING when the Binding becomes DORMANT (suspend and
	// deactivate have the same effect, §2.4).
	if err := f.core.Suspend(f.consumer.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if got := f.state(t); got != ChannelDraining {
		t.Fatalf("state after suspend = %s, want DRAINING (CC-2)", got)
	}
	// A DRAINING Channel takes no new work: that is what DRAINING is for (§2.4).
	if _, err := f.layer.Send(f.channel.ID, "while-draining"); err == nil {
		t.Fatal("a DRAINING channel MUST NOT accept new messages (§2.4)")
	} else {
		wantCode(t, err, CodeChannelDraining)
	}
	// DRAINING -> ACTIVE when the Binding recovers: §2.2's second edge into
	// ACTIVE exists for this clause of CC-2.
	if err := f.core.Resume(f.consumer.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := f.state(t); got != ChannelActive {
		t.Fatalf("state after resume = %s, want ACTIVE (CC-2)", got)
	}

	// deactivate derives DORMANT too, and so the same DRAINING.
	if err := f.core.Deactivate(f.provider.Identity); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if got := f.state(t); got != ChannelDraining {
		t.Fatalf("state after deactivate = %s, want DRAINING (CC-2)", got)
	}
	if err := f.core.Activate(f.provider.Identity); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if got := f.state(t); got != ChannelActive {
		t.Fatalf("state after activate = %s, want ACTIVE", got)
	}
}

func TestCC2AChannelCreatedOnADormantBindingIsDraining(t *testing.T) {
	core := NewCore()
	capability := capabilityOf("casing.apply", "1.0.0")
	provider, consumer := activePair(t, core, capability)
	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: capability.Name, Version: capability.Version},
	})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := core.Suspend(consumer.Identity); err != nil {
		t.Fatalf("suspend: %v", err)
	}

	layer := NewInteraction(core)
	channel, err := layer.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeStream})
	if err != nil {
		t.Fatalf("create channel on a DORMANT binding: %v", err)
	}
	if channel.State != ChannelDraining {
		t.Fatalf("state = %s, want DRAINING (§2.4)", channel.State)
	}
	// connect() is accepted while DRAINING (it is §2.2's second edge into
	// ACTIVE), but the derived state stays DRAINING until the Binding recovers.
	if _, err := layer.ConnectChannel(channel.ID); err != nil {
		t.Fatalf("connect while draining: %v", err)
	}
	if state, err := layer.ChannelState(channel.ID); err != nil || state != ChannelDraining {
		t.Fatalf("state = %s (%v), want DRAINING", state, err)
	}
	if err := core.Resume(consumer.Identity); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if state, err := layer.ChannelState(channel.ID); err != nil || state != ChannelActive {
		t.Fatalf("state = %s (%v), want ACTIVE (CC-2)", state, err)
	}
}

func TestCC3ModeMustBeSpecifiedExplicitly(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	_, err := f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding})
	wantCode(t, err, CodeModeInvalid)

	_, err = f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding, Mode: ChannelMode("broadcast")})
	wantCode(t, err, CodeModeInvalid)
}

func TestCC4OmittedDeliveryIsDerivedFromTheMode(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	cases := []struct {
		mode ChannelMode
		want DeliveryGuarantee
	}{
		{ModeRequest, DeliveryAtMostOnce},
		{ModeEvent, DeliveryAtMostOnce},
		{ModeStream, DeliveryAtLeastOnce},
		{ModeState, DeliveryAtLeastOnce},
	}
	for _, testCase := range cases {
		channel, err := f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding, Mode: testCase.mode})
		if err != nil {
			t.Fatalf("create %s channel: %v", testCase.mode, err)
		}
		if channel.Delivery != testCase.want {
			t.Fatalf("%s delivery = %s, want %s (CC-4)", testCase.mode, channel.Delivery, testCase.want)
		}
	}
}

func TestCC5StreamAndStateRefuseAtMostOnce(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	for _, mode := range []ChannelMode{ModeStream, ModeState} {
		_, err := f.layer.CreateChannel(CreateChannelRequest{
			Binding: f.binding, Mode: mode, Delivery: DeliveryAtMostOnce,
		})
		wantCode(t, err, CodeDeliveryUnsupported) // CC-5, DL-6
	}
	// DL-2: exactly-once MUST NOT appear in Core.
	_, err := f.layer.CreateChannel(CreateChannelRequest{
		Binding: f.binding, Mode: ModeEvent, Delivery: DeliveryGuarantee("exactly-once"),
	})
	wantCode(t, err, CodeDeliveryUnsupported)
	// request and event MAY use either guarantee (§4.4).
	for _, mode := range []ChannelMode{ModeRequest, ModeEvent} {
		for _, delivery := range []DeliveryGuarantee{DeliveryAtMostOnce, DeliveryAtLeastOnce} {
			if _, err := f.layer.CreateChannel(CreateChannelRequest{
				Binding: f.binding, Mode: mode, Delivery: delivery,
			}); err != nil {
				t.Fatalf("create %s/%s channel: %v", mode, delivery, err)
			}
		}
	}
}

func TestCC6NonexistentBindingIsBindingInvalid(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	_, err := f.layer.CreateChannel(CreateChannelRequest{Binding: "binding-does-not-exist", Mode: ModeStream})
	wantCode(t, err, CodeBindingInvalid)
	_, err = f.layer.CreateChannel(CreateChannelRequest{Mode: ModeStream})
	wantCode(t, err, CodeBindingInvalid)
}

func TestCC7ClosedBindingIsBindingClosed(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	if err := f.core.Unbind(f.binding); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	_, err := f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding, Mode: ModeStream})
	wantCode(t, err, CodeBindingClosed)
}

func TestCC8OpenAtCreationAndActiveAfterConnect(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	fresh, err := f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding, Mode: ModeEvent})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if fresh.State != ChannelOpen {
		t.Fatalf("state at creation = %s, want OPEN (CC-8)", fresh.State)
	}
	connected, err := f.layer.ConnectChannel(fresh.ID)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if connected.State != ChannelActive {
		t.Fatalf("state after connect = %s, want ACTIVE (CC-8)", connected.State)
	}
}

func TestCC9OneBindingMayDeriveSeveralChannels(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	for _, mode := range []ChannelMode{ModeRequest, ModeEvent, ModeState} {
		if _, err := f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding, Mode: mode}); err != nil {
			t.Fatalf("create %s channel: %v", mode, err)
		}
	}
	channels := f.layer.Channels()
	if len(channels) != 4 {
		t.Fatalf("channels = %d, want 4 (CC-9)", len(channels))
	}
	for _, channel := range channels {
		if channel.Binding != f.binding {
			t.Fatalf("channel %s reports binding %s, want %s", channel.ID, channel.Binding, f.binding)
		}
	}
}

// ---------------------------------------------------------------------------
// Cursor — §6, CR-1 … CR-5
// ---------------------------------------------------------------------------

func TestCR1CursorsAreGloballyOrderedWithinAChannel(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	previous := f.send(t, "one")
	for i := 0; i < 12; i++ {
		next := f.send(t, i)
		order, err := CompareCursor(previous, next)
		if err != nil {
			t.Fatalf("compare: %v", err)
		}
		if order >= 0 {
			t.Fatalf("cursor %s is not after %s (CR-1)", next, previous)
		}
		previous = next
	}
	// Lexicographic order must agree with numeric order, because neither is
	// promised to a caller and both are natural to assume.
	if !(Cursor("0000000000000002") < Cursor("0000000000000010")) {
		t.Fatal("cursors MUST order the same way as text and as positions")
	}
}

func TestCR3CursorMustNotAdvanceWithoutAnAck(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")
	subscription := f.open(t, AnchorEarliest)
	start := subscription.Cursor()

	first := f.pull(t, subscription)
	if subscription.Cursor() != start {
		t.Fatalf("delivery advanced the cursor to %s; only ack may advance it (CR-3)", subscription.Cursor())
	}
	second := f.pull(t, subscription)
	if subscription.Cursor() != start {
		t.Fatalf("delivery advanced the cursor to %s; only ack may advance it (CR-3)", subscription.Cursor())
	}

	// An explicit acknowledgement of a later position abandons the unacked ones,
	// and §6.4 says that MUST be allowed.
	if err := second.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if subscription.Cursor() != second.Cursor {
		t.Fatalf("cursor = %s, want %s (§6.4 takes the maximum)", subscription.Cursor(), second.Cursor)
	}
	if order, _ := CompareCursor(subscription.Cursor(), first.Cursor); order <= 0 {
		t.Fatalf("cursor = %s, want past %s", subscription.Cursor(), first.Cursor)
	}
}

func TestCR4ResumeContinuesFromTheCursor(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")

	first := f.open(t, AnchorEarliest)
	item := f.pull(t, first)
	if err := item.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	resumed := first.Cursor()

	// A subscription opened at the confirmed cursor continues where the first
	// one stopped rather than replaying acknowledged items (CR-4).
	second, err := f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{Cursor: CursorAnchor(resumed)})
	if err != nil {
		t.Fatalf("open at cursor: %v", err)
	}
	next := f.pull(t, second)
	if order, _ := CompareCursor(next.Cursor, resumed); order <= 0 {
		t.Fatalf("resumed item %s is not after %s (CR-4)", next.Cursor, resumed)
	}
}

func TestCR5ATransportWithoutCursorSupportIsRefused(t *testing.T) {
	core := NewCore()
	capability := capabilityOf("casing.apply", "1.0.0")
	provider, consumer := activePair(t, core, capability)
	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: capability.Name, Version: capability.Version},
	})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}

	layer := NewInteractionWithTransport(core, noPositionTransport{inner: NewMemoryTransport()})
	channel, err := layer.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeStream})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := layer.OpenSubscription(channel.ID, SubscriptionOptions{Cursor: AnchorEarliest}); err == nil {
		t.Fatal("'earliest' MUST NOT be resolved by a transport that cannot report its floor (CR-5)")
	} else {
		wantCode(t, err, CodeCursorUnsupported)
	}
	if _, err := layer.OpenSubscription(channel.ID, SubscriptionOptions{Cursor: AnchorLatest}); err == nil {
		t.Fatal("'latest' MUST NOT be resolved by a transport that cannot report its head (CR-5)")
	} else {
		wantCode(t, err, CodeCursorUnsupported)
	}
}

func TestCursorAnchorsAreLiteralsNotPositions(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	earliest, err := f.layer.ResolveAnchor(f.channel.ID, AnchorEarliest)
	if err != nil {
		t.Fatalf("resolve earliest: %v", err)
	}
	if earliest != ZeroCursor {
		t.Fatalf("'earliest' resolved to %s, want the retention floor %s (§6.2 rule 3)", earliest, ZeroCursor)
	}
	latest, err := f.layer.ResolveAnchor(f.channel.ID, AnchorLatest)
	if err != nil {
		t.Fatalf("resolve latest: %v", err)
	}
	if latest != ZeroCursor {
		t.Fatalf("'latest' on an empty channel resolved to %s, want %s (§6.2 rule 4)", latest, ZeroCursor)
	}
	sent := f.send(t, "one")
	latest, err = f.layer.ResolveAnchor(f.channel.ID, AnchorLatest)
	if err != nil {
		t.Fatalf("resolve latest: %v", err)
	}
	if latest != sent {
		t.Fatalf("'latest' resolved to %s, want the head %s", latest, sent)
	}
}

func TestCursorTooOldIsRefusedNotMovedUpToTheFloor(t *testing.T) {
	core := NewCore()
	capability := capabilityOf("casing.apply", "1.0.0")
	provider, consumer := activePair(t, core, capability)
	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: capability.Name, Version: capability.Version},
	})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}

	// A transport whose log has already been compacted up to position 5.
	layer := NewInteractionWithTransport(core, compactingTransport{inner: NewMemoryTransport(), floor: formatCursor(5)})
	channel, err := layer.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeStream})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, err = layer.OpenSubscription(channel.ID, SubscriptionOptions{Cursor: CursorAnchor(formatCursor(2))})
	wantCode(t, err, CodeCursorTooOld) // §6.2 rule 7

	// Rule 7's other half: MUST NOT be silently replaced by the floor. The
	// subscription was not created at all.
	earliest, err := layer.ResolveAnchor(channel.ID, AnchorEarliest)
	if err != nil {
		t.Fatalf("resolve earliest: %v", err)
	}
	if earliest != formatCursor(5) {
		t.Fatalf("'earliest' = %s, want the retention floor %s (§6.2 rule 6)", earliest, formatCursor(5))
	}
	// A cursor that was not discarded is still accepted.
	if _, err := layer.OpenSubscription(channel.ID, SubscriptionOptions{Cursor: CursorAnchor(formatCursor(7))}); err != nil {
		t.Fatalf("a retained cursor MUST be accepted: %v", err)
	}
	// A cursor that is not a position at all is EAPP_CURSOR_INVALID.
	_, err = layer.OpenSubscription(channel.ID, SubscriptionOptions{Cursor: CursorAnchor("not-a-cursor")})
	wantCode(t, err, CodeCursorInvalid)
}

// ---------------------------------------------------------------------------
// Subscription — §7, SUB-1 … SUB-9
// ---------------------------------------------------------------------------

func TestSUB1SubscriptionMustNotOutliveItsChannel(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	if _, err := f.layer.OpenSubscription("channel-nope", SubscriptionOptions{}); err == nil {
		t.Fatal("a subscription MUST NOT exist without a Channel (SUB-1)")
	} else {
		wantCode(t, err, CodeChannelInvalid)
	}
	if err := f.layer.CloseChannel(f.channel.ID); err != nil {
		t.Fatalf("close channel: %v", err)
	}
	item, done, err := subscription.Next()
	if err != nil {
		t.Fatalf("next after channel close: %v", err)
	}
	if !done || item != nil {
		t.Fatalf("subscription delivered %v (done=%v) after its channel closed (SUB-1)", item, done)
	}
	if state := subscription.State(); state != SubscriptionClosed {
		t.Fatalf("state = %s, want CLOSED", state)
	}
}

func TestSUB2AnExclusiveSubscriptionHasItsOwnCursor(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")
	first := f.open(t, AnchorEarliest)
	second := f.open(t, AnchorEarliest)

	item := f.pull(t, first)
	if err := item.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if first.Cursor() == second.Cursor() {
		t.Fatal("two exclusive subscriptions MUST have independent cursors (SUB-2)")
	}
	if second.Cursor() != ZeroCursor {
		t.Fatalf("the second subscription's cursor moved to %s (SUB-2, SUB-3)", second.Cursor())
	}
}

func TestSUB3OneSubscriptionMustNotAffectAnother(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")
	first := f.open(t, AnchorEarliest)
	second := f.open(t, AnchorEarliest)

	item := f.pull(t, first)
	if err := item.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	// The second subscription still receives everything from its own position.
	for _, want := range []string{"one", "two"} {
		got := f.pull(t, second)
		if got.Payload != want {
			t.Fatalf("payload = %v, want %q (SUB-3)", got.Payload, want)
		}
	}
}

func TestSUB4GroupModeMustNameANonEmptyGroup(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	_, err := f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{Mode: SubscriptionGroup})
	wantCode(t, err, CodeSubscriptionInvalid)
	_, err = f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{Mode: SubscriptionMode("shared")})
	wantCode(t, err, CodeSubscriptionInvalid)
}

func TestSUB5SuspendStopsDeliveryUntilResume(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "before")
	subscription := f.open(t, AnchorEarliest)
	f.pull(t, subscription) // an item already yielded stays valid

	if err := subscription.Suspend(); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if state := subscription.State(); state != SubscriptionSuspended {
		t.Fatalf("state = %s, want SUSPENDED", state)
	}
	f.send(t, "while-suspended")
	item, done, err := subscription.Next()
	if err != nil {
		t.Fatalf("next while suspended: %v", err)
	}
	if item != nil || done {
		t.Fatalf("delivery happened while suspended: %v (done=%v) (SUB-5)", item, done)
	}

	if err := subscription.Resume(); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if state := subscription.State(); state != SubscriptionActive {
		t.Fatalf("state = %s, want ACTIVE", state)
	}
	resumed := f.pull(t, subscription)
	if resumed.Payload != "while-suspended" {
		t.Fatalf("payload = %v, want the message sent while suspended (SUB-5)", resumed.Payload)
	}
}

func TestSUB6CloseIsIdempotent(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	subscription := f.open(t, AnchorEarliest)
	for i := 0; i < 3; i++ {
		if err := subscription.Close(); err != nil {
			t.Fatalf("close #%d: %v", i+1, err)
		}
	}
	if state := subscription.State(); state != SubscriptionClosed {
		t.Fatalf("state = %s, want CLOSED", state)
	}
}

func TestSUB7NothingIsDeliveredAfterClose(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	subscription := f.open(t, AnchorEarliest)
	if err := subscription.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	f.send(t, "after-close")
	item, done, err := subscription.Next()
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if !done {
		t.Fatal("a CLOSED subscription MUST report done (SUB-7)")
	}
	if item != nil {
		t.Fatalf("a CLOSED subscription delivered %v (SUB-7)", item)
	}
}

func TestSUB8AckAfterCloseIsANoOp(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")
	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)
	before := subscription.Cursor()

	if err := subscription.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := item.Ack(); err != nil {
		t.Fatalf("ack after close MUST be a no-op, not an error (SUB-8): %v", err)
	}
	if err := subscription.Ack(item.Delivery()); err != nil {
		t.Fatalf("handle-addressed ack after close MUST be a no-op (SUB-8): %v", err)
	}
	if after := subscription.Cursor(); after != before {
		t.Fatalf("cursor moved from %s to %s after close (SUB-8)", before, after)
	}
}

func TestSUB9CursorIsResolvedBeforeTheSubscriptionIsReturned(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	for _, anchor := range []CursorAnchor{"", AnchorEarliest, AnchorLatest} {
		subscription := f.open(t, anchor)
		if subscription.Cursor() == "" {
			t.Fatalf("cursor for anchor %q is empty (SUB-9)", anchor)
		}
		if _, err := positionOf(subscription.Cursor()); err != nil {
			t.Fatalf("cursor for anchor %q is not a concrete position: %v", anchor, err)
		}
	}
	// §7.1's default is 'latest': a subscription that names no anchor starts at
	// the head and therefore sees nothing that was already sent.
	subscription := f.open(t, "")
	item, done, err := subscription.Next()
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if item != nil || done {
		t.Fatalf("default-anchor subscription delivered %v; the default is 'latest' (§7.1)", item)
	}
}

// ---------------------------------------------------------------------------
// Ack / Nack — §9, AK-1 … AK-5
// ---------------------------------------------------------------------------

func TestAK1AckIsIdempotent(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)

	if err := item.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	cursor := subscription.Cursor()
	if err := item.Ack(); err != nil {
		t.Fatalf("second ack MUST succeed (AK-1): %v", err)
	}
	if err := subscription.Ack(item.Delivery()); err != nil {
		t.Fatalf("handle-addressed second ack MUST succeed (AK-1): %v", err)
	}
	if after := subscription.Cursor(); after != cursor {
		t.Fatalf("cursor moved from %s to %s on a repeated ack (AK-1)", cursor, after)
	}
}

func TestAK2NackIsIdempotent(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)

	if err := item.Nack(); err != nil {
		t.Fatalf("nack: %v", err)
	}
	if subscription.Cursor() != ZeroCursor {
		t.Fatalf("nack advanced the cursor to %s (§6.4)", subscription.Cursor())
	}
	if err := item.Nack(); err != nil {
		t.Fatalf("second nack MUST succeed (AK-2): %v", err)
	}
	// §6.4: the nacked item is available again and is delivered on the next
	// iteration.
	again := f.pull(t, subscription)
	if again.Cursor != item.Cursor {
		t.Fatalf("redelivered cursor = %s, want the nacked %s (§6.4)", again.Cursor, item.Cursor)
	}
}

func TestAK3NackAfterAckIsRefused(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)
	if err := item.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	wantCode(t, item.Nack(), CodeLeaseClosed) // AK-3, AK-5
}

func TestAK4AckAfterNackIsRefused(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)
	if err := item.Nack(); err != nil {
		t.Fatalf("nack: %v", err)
	}
	wantCode(t, item.Ack(), CodeLeaseClosed) // AK-4, AK-5
}

func TestAK5AConflictingCallOnATerminatedContextIsLeaseClosed(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)

	if err := subscription.Nack(item.Delivery()); err != nil {
		t.Fatalf("nack: %v", err)
	}
	// Both entry points report the same termination, because they address the
	// same AckContext.
	if err := subscription.Ack(item.Delivery()); err == nil {
		t.Fatal("ack after nack MUST be refused (AK-4)")
	} else {
		wantCode(t, err, CodeLeaseClosed)
	}
	if err := subscription.Ack("delivery-nope"); err == nil {
		t.Fatal("a handle that names no outstanding delivery MUST be refused")
	} else {
		wantCode(t, err, CodeSubscriptionInvalid)
	}
}

// ---------------------------------------------------------------------------
// ConsumerGroup — §8, CG-1 … CG-8
// ---------------------------------------------------------------------------

// groupFixture opens a group and the given number of members on a stream channel
// with `messages` already sent.
func groupFixture(t *testing.T, messages int, claimTTL time.Duration) (*interactionFixture, Group, []*Subscription) {
	t.Helper()
	f := newInteractionFixture(t, ModeStream)
	for i := 0; i < messages; i++ {
		f.send(t, i)
	}
	group, err := f.layer.OpenGroup(f.channel.ID, "workers", claimTTL)
	if err != nil {
		t.Fatalf("open group: %v", err)
	}
	return f, group, nil
}

// joinGroup opens one more member of a group.
func (f *interactionFixture) joinGroup(t *testing.T, group Group) *Subscription {
	t.Helper()
	subscription, err := f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{
		Mode:  SubscriptionGroup,
		Group: group.Name,
	})
	if err != nil {
		t.Fatalf("join group: %v", err)
	}
	return subscription
}

func TestCG1ConsumerGroupNameIsUniqueWithinItsChannel(t *testing.T) {
	f, group, _ := groupFixture(t, 0, 0)
	if group.Name != "workers" || group.ID == "" {
		t.Fatalf("group = %+v", group)
	}
	if _, err := f.layer.OpenGroup(f.channel.ID, "workers", 0); err == nil {
		t.Fatal("a second group with the same name MUST be refused (CG-1)")
	} else {
		wantCode(t, err, CodeSubscriptionInvalid)
	}
	// The uniqueness domain is the Channel, so another Channel may hold the name.
	other, err := f.layer.CreateChannel(CreateChannelRequest{Binding: f.binding, Mode: ModeEvent})
	if err != nil {
		t.Fatalf("create second channel: %v", err)
	}
	if _, err := f.layer.OpenGroup(other.ID, "workers", 0); err != nil {
		t.Fatalf("the same name on another channel MUST be allowed (CG-1): %v", err)
	}
}

func TestCG2AllMembersShareExactlyOneCursor(t *testing.T) {
	f, group, _ := groupFixture(t, 3, 0)
	first := f.joinGroup(t, group)
	second := f.joinGroup(t, group)

	if first.Cursor() != second.Cursor() {
		t.Fatalf("members report %s and %s; a group has one cursor (CG-2)", first.Cursor(), second.Cursor())
	}
	item := f.pull(t, first)
	if err := item.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if first.Cursor() != second.Cursor() {
		t.Fatalf("after an ack the members report %s and %s (CG-2)", first.Cursor(), second.Cursor())
	}
	if first.Cursor() != item.Cursor {
		t.Fatalf("group cursor = %s, want the acknowledged %s (§8.3)", first.Cursor(), item.Cursor)
	}
	view, err := f.layer.Group(group.ID)
	if err != nil {
		t.Fatalf("group view: %v", err)
	}
	if view.Cursor != item.Cursor {
		t.Fatalf("group.view cursor = %s, want %s (§8.3)", view.Cursor, item.Cursor)
	}
	if view.MemberCount != 2 {
		t.Fatalf("memberCount = %d, want 2", view.MemberCount)
	}
}

func TestCG3OneMessageIsNotHeldByTwoMembersAtOnce(t *testing.T) {
	f, group, _ := groupFixture(t, 4, 0)
	first := f.joinGroup(t, group)
	second := f.joinGroup(t, group)

	seen := make(map[Cursor]bool)
	for i := 0; i < 4; i++ {
		member := first
		if i%2 == 1 {
			member = second
		}
		item := f.pull(t, member)
		if seen[item.Cursor] {
			t.Fatalf("cursor %s was handed to two members at once (CG-3, L-2)", item.Cursor)
		}
		seen[item.Cursor] = true
	}
	if len(seen) != 4 {
		t.Fatalf("handed out %d distinct positions, want 4 (CG-3)", len(seen))
	}
}

func TestCG4DifferentGroupsDoNotAffectEachOther(t *testing.T) {
	f, groupA, _ := groupFixture(t, 3, 0)
	groupB, err := f.layer.OpenGroup(f.channel.ID, "auditors", 0)
	if err != nil {
		t.Fatalf("open second group: %v", err)
	}
	memberA := f.joinGroup(t, groupA)
	memberB := f.joinGroup(t, groupB)

	// A consumes and acknowledges everything.
	for i := 0; i < 3; i++ {
		item := f.pull(t, memberA)
		if err := item.Ack(); err != nil {
			t.Fatalf("ack: %v", err)
		}
	}
	if memberB.Cursor() != ZeroCursor {
		t.Fatalf("group B's cursor moved to %s because of group A (CG-4)", memberB.Cursor())
	}
	// B still receives every message — §8.1: "组之间：每个组都收到全部消息".
	for i := 0; i < 3; i++ {
		f.pull(t, memberB)
	}
}

func TestCG5AMemberLeavingMustNotStallTheGroup(t *testing.T) {
	f, group, _ := groupFixture(t, 2, time.Hour)
	first := f.joinGroup(t, group)
	second := f.joinGroup(t, group)

	held := f.pull(t, first)
	if err := first.Close(); err != nil {
		t.Fatalf("close member: %v", err)
	}
	// The position the departing member was holding MUST come back to the group
	// immediately rather than at its claim's expiry (CG-5).
	reclaimed := f.pull(t, second)
	if reclaimed.Cursor != held.Cursor {
		t.Fatalf("reclaimed %s, want the abandoned %s (CG-5)", reclaimed.Cursor, held.Cursor)
	}
	view, err := f.layer.Group(group.ID)
	if err != nil {
		t.Fatalf("group view: %v", err)
	}
	if view.MemberCount != 1 {
		t.Fatalf("memberCount = %d, want 1 after a member left", view.MemberCount)
	}
}

func TestCG6ANackedPositionReturnsToTheGroup(t *testing.T) {
	f, group, _ := groupFixture(t, 1, time.Hour)
	first := f.joinGroup(t, group)
	second := f.joinGroup(t, group)

	item := f.pull(t, first)
	if err := item.Nack(); err != nil {
		t.Fatalf("nack: %v", err)
	}
	redelivered := f.pull(t, second)
	if redelivered.Cursor != item.Cursor {
		t.Fatalf("redelivered %s, want the nacked %s (CG-6)", redelivered.Cursor, item.Cursor)
	}
}

func TestCG6ATimedOutClaimReturnsToTheGroup(t *testing.T) {
	f, group, _ := groupFixture(t, 1, 20*time.Millisecond)
	first := f.joinGroup(t, group)
	second := f.joinGroup(t, group)

	expired := f.pull(t, first)
	time.Sleep(60 * time.Millisecond)

	reclaimed := f.pull(t, second)
	if reclaimed.Cursor != expired.Cursor {
		t.Fatalf("reclaimed %s, want the timed-out %s (CG-6, L-6)", reclaimed.Cursor, expired.Cursor)
	}
	if reclaimed.Delivery() == expired.Delivery() {
		t.Fatal("the reclaimed position MUST carry a new claim, not the lapsed one (L-7)")
	}
	// L-7: the lapsed lease MUST NOT affect the new one.
	wantCode(t, expired.Ack(), CodeLeaseExpired)
	if err := reclaimed.Ack(); err != nil {
		t.Fatalf("the new claim MUST be settlable: %v", err)
	}
}

func TestCG7AGroupMustNotExistWithoutItsChannel(t *testing.T) {
	f, group, _ := groupFixture(t, 1, 0)
	member := f.joinGroup(t, group)

	if err := f.layer.CloseChannel(f.channel.ID); err != nil {
		t.Fatalf("close channel: %v", err)
	}
	if _, err := f.layer.Group(group.ID); err == nil {
		t.Fatal("a group MUST NOT outlive its Channel (CG-7)")
	} else {
		wantCode(t, err, CodeChannelClosed)
	}
	if _, done, _ := member.Next(); !done {
		t.Fatal("a member of a group whose channel closed MUST be terminated (CG-7)")
	}
}

func TestCG8GroupModeMustNameAnExistingGroup(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	_, err := f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{
		Mode:  SubscriptionGroup,
		Group: "nobody",
	})
	wantCode(t, err, CodeSubscriptionInvalid)

	group, err := f.layer.OpenGroup(f.channel.ID, "workers", 0)
	if err != nil {
		t.Fatalf("open group: %v", err)
	}
	if _, err := f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{
		Mode:  SubscriptionGroup,
		Group: group.Name,
	}); err != nil {
		t.Fatalf("joining an existing group MUST succeed: %v", err)
	}
	if err := f.layer.CloseGroup(group.ID); err != nil {
		t.Fatalf("close group: %v", err)
	}
	// A closed group no longer exists to be joined.
	_, err = f.layer.OpenSubscription(f.channel.ID, SubscriptionOptions{
		Mode:  SubscriptionGroup,
		Group: group.Name,
	})
	wantCode(t, err, CodeSubscriptionInvalid)
}

// ---------------------------------------------------------------------------
// Transport — §10, TR-5 … TR-9
// ---------------------------------------------------------------------------

func TestTR5ReadAfterReturnsStrictlyLaterMessages(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	first := f.send(t, "one")
	f.send(t, "two")
	f.send(t, "three")

	after := first
	messages, err := f.layer.ReadAfter(f.channel.ID, &after, PatternAll)
	if err != nil {
		t.Fatalf("readAfter: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("readAfter returned %d messages, want 2 (TR-5)", len(messages))
	}
	if messages[0].Payload != "two" || messages[1].Payload != "three" {
		t.Fatalf("readAfter returned %v, want two then three (TR-5)", messages)
	}
}

func TestTR6AnUndefinedCursorMeansFromTheEarliestRetainedPosition(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")

	messages, err := f.layer.ReadAfter(f.channel.ID, nil, PatternAll)
	if err != nil {
		t.Fatalf("readAfter: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("readAfter(nil) returned %d messages, want 2 (TR-6)", len(messages))
	}
}

func TestTR7NoMatchIsAnEmptyResultNotABlock(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	head := f.send(t, "one")

	after := head
	messages, err := f.layer.ReadAfter(f.channel.ID, &after, PatternAll)
	if err != nil {
		t.Fatalf("readAfter: %v", err)
	}
	if messages == nil {
		t.Fatal("readAfter MUST return an empty slice, not nil (TR-7)")
	}
	if len(messages) != 0 {
		t.Fatalf("readAfter past the head returned %d messages (TR-7)", len(messages))
	}
	// A pattern that matches nothing is the same case.
	messages, err = f.layer.ReadAfter(f.channel.ID, nil, Pattern{Type: "nothing"})
	if err != nil {
		t.Fatalf("readAfter with a type pattern: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("a non-matching pattern returned %d messages (TR-7)", len(messages))
	}
	// And a matching one selects by type.
	if _, err := f.layer.Send(f.channel.ID, map[string]any{"type": "casing.applied"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	messages, err = f.layer.ReadAfter(f.channel.ID, nil, Pattern{Type: "casing.applied"})
	if err != nil {
		t.Fatalf("readAfter: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("a matching type pattern returned %d messages, want 1", len(messages))
	}
}

func TestTR8SendReturnsAStrictlyGreaterCursor(t *testing.T) {
	f := newInteractionFixture(t, ModeEvent)
	previous := f.send(t, 0)
	for i := 1; i < 20; i++ {
		next := f.send(t, i)
		order, err := CompareCursor(previous, next)
		if err != nil {
			t.Fatalf("compare: %v", err)
		}
		if order >= 0 {
			t.Fatalf("send returned %s after %s (TR-8)", next, previous)
		}
		previous = next
	}
}

func TestTR9AnUnsupportedPatternIsRefusedWithItsOwnCode(t *testing.T) {
	var pattern Pattern
	err := json.Unmarshal([]byte(`{"key":"value"}`), &pattern)
	wantCode(t, err, CodeUnsupported)

	err = json.Unmarshal([]byte(`{"all":false}`), &pattern)
	wantCode(t, err, CodeUnsupported)

	if err := json.Unmarshal([]byte(`{"all":true}`), &pattern); err != nil {
		t.Fatalf("{all:true} MUST be a supported pattern: %v", err)
	}
	if !pattern.All {
		t.Fatalf("pattern = %+v, want all", pattern)
	}
}

func TestTransportCapabilitiesDeclareTheMemoryRow(t *testing.T) {
	capabilities := NewMemoryTransport().Capabilities()
	if capabilities.Persistent {
		t.Fatal("the memory transport is not persistent (§10.3)")
	}
	if capabilities.Ordering != "global" {
		t.Fatalf("ordering = %q, want global (§10.3)", capabilities.Ordering)
	}
	if !capabilities.Delivery.AtLeastOnce || capabilities.Delivery.Replay {
		t.Fatalf("delivery = %+v, want at-least-once without replay (§10.3)", capabilities.Delivery)
	}
	if !capabilities.SupportsCursor || !capabilities.SupportsLease {
		t.Fatalf("capabilities = %+v, want cursor and lease support (§10.3)", capabilities)
	}
	if capabilities.DurabilityBoundary != "process" {
		t.Fatalf("durabilityBoundary = %q, want process (§10.3)", capabilities.DurabilityBoundary)
	}
}

// ---------------------------------------------------------------------------
// Lease — §5, L-1 … L-7
// ---------------------------------------------------------------------------

func TestL1AndL2LeasesAreUniqueAndExclusive(t *testing.T) {
	f, group, _ := groupFixture(t, 4, time.Hour)
	first := f.joinGroup(t, group)
	second := f.joinGroup(t, group)

	held := make(map[string]bool)
	positions := make(map[Cursor]bool)
	for i := 0; i < 4; i++ {
		member := first
		if i%2 == 1 {
			member = second
		}
		item := f.pull(t, member)
		lease := item.Lease()
		if lease == nil {
			t.Fatal("a group claim IS a Lease (§8.3): the item MUST carry one")
		}
		if held[lease.ID] {
			t.Fatalf("lease id %s was handed out twice (L-1)", lease.ID)
		}
		held[lease.ID] = true
		if positions[item.Cursor] {
			t.Fatalf("cursor %s is held by two leases (L-2)", item.Cursor)
		}
		positions[item.Cursor] = true
		if !lease.Active(time.Now()) {
			t.Fatalf("a fresh lease MUST be active: %+v", lease)
		}
	}
}

func TestL5RenewAppliesOnlyToAnActiveLease(t *testing.T) {
	f, group, _ := groupFixture(t, 1, 50*time.Millisecond)
	member := f.joinGroup(t, group)

	item := f.pull(t, member)
	lease := item.Lease()
	time.Sleep(60 * time.Millisecond)
	// The claim has lapsed even though nobody has taken it: renew MUST refuse
	// (L-5), because the ownership it would extend no longer exists.
	wantCode(t, lease.Renew(time.Minute), CodeLeaseExpired)
	if err := item.Ack(); err != nil {
		t.Fatalf("a lapsed claim nobody else wanted may still be settled (L-7): %v", err)
	}
	wantCode(t, lease.Renew(time.Minute), CodeLeaseClosed)
}

// ---------------------------------------------------------------------------
// Modes and delivery — §3, §4
// ---------------------------------------------------------------------------

func TestST1AndST3StreamCursorsAreMonotonicAndAckedItemsAreNotRedelivered(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	f.send(t, "two")
	f.send(t, "three")

	subscription := f.open(t, AnchorEarliest)
	previous := ZeroCursor
	acked := make(map[string]bool)
	for i := 0; i < 3; i++ {
		item := f.pull(t, subscription)
		order, err := CompareCursor(previous, item.Cursor)
		if err != nil {
			t.Fatalf("compare: %v", err)
		}
		if order >= 0 {
			t.Fatalf("cursor %s is not after %s (ST-1)", item.Cursor, previous)
		}
		previous = item.Cursor
		if acked[string(item.Cursor)] {
			t.Fatalf("cursor %s was delivered twice despite being acknowledged (ST-3)", item.Cursor)
		}
		if err := item.Ack(); err != nil {
			t.Fatalf("ack: %v", err)
		}
		acked[string(item.Cursor)] = true
	}
	if item, done, _ := subscription.Next(); item != nil || done {
		t.Fatalf("something was delivered after every position was acknowledged: %v", item)
	}
}

func TestEV1AnEventExpectsNoResponse(t *testing.T) {
	f := newInteractionFixture(t, ModeEvent)
	f.send(t, map[string]any{"topic": "casing.applied", "payload": 1})

	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)
	if item.Cursor == "" {
		t.Fatal("an event MUST still carry a position")
	}
	// EV-1: nothing about the consumption pairs it with an answer. The item is
	// the whole interaction, and settling it is optional.
	if err := item.Ack(); err != nil {
		t.Fatalf("ack on an event channel: %v", err)
	}
}

func TestPayloadsArePassedThroughUnchanged(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	raw := json.RawMessage(`{"big":9007199254740993,"nested":{"list":[1,2,3]},"text":"<&>"}`)
	f.send(t, raw)

	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)
	// Re-encoded the way a protocol adapter would (no HTML escaping), because the
	// point is byte identity: a payload that round-trips through float64 loses
	// 9007199254740993 and one that is re-escaped changes bytes no invariant
	// would complain about.
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(item.Payload); err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	if got := strings.TrimSpace(buffer.String()); got != string(raw) {
		t.Fatalf("payload round-tripped as %s, want %s", got, raw)
	}
}

func TestMessageShapesAreNotReinventedByThisLayer(t *testing.T) {
	// §3.1 freezes the three delivery envelopes, and §3.1's last sentence says
	// upper layers MUST use them. They are therefore NOT this layer's shapes: the
	// layer carries an opaque payload, and an implementation that wrapped it would
	// be inventing a shape as surely as one that renamed a field of §3.1's.
	f := newInteractionFixture(t, ModeRequest)
	envelope := map[string]any{
		"correlationId": "c-1",
		"operation":     "casing.apply",
		"payload":       map[string]any{"text": "hello"},
	}
	f.send(t, envelope)

	subscription := f.open(t, AnchorEarliest)
	item := f.pull(t, subscription)
	got, ok := item.Payload.(map[string]any)
	if !ok {
		t.Fatalf("payload = %T, want the map that was sent", item.Payload)
	}
	if got["correlationId"] != "c-1" || got["operation"] != "casing.apply" {
		t.Fatalf("payload = %v, want it unchanged", got)
	}
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

func TestInteractionResetClearsEverything(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	f.send(t, "one")
	group, err := f.layer.OpenGroup(f.channel.ID, "workers", 0)
	if err != nil {
		t.Fatalf("open group: %v", err)
	}
	f.joinGroup(t, group)
	subscription := f.open(t, AnchorEarliest)

	f.layer.Reset()
	if _, err := f.layer.Channel(f.channel.ID); err == nil {
		t.Fatal("reset MUST drop every channel")
	}
	if _, err := f.layer.Group(group.ID); err == nil {
		t.Fatal("reset MUST drop every group")
	}
	if _, err := f.layer.Subscription(subscription.ID()); err == nil {
		t.Fatal("reset MUST drop every subscription")
	}
}

// ---------------------------------------------------------------------------
// §11: the Composition ↔ Interaction boundary
// ---------------------------------------------------------------------------

func TestCompositionToInteractionReportsBindingTransitions(t *testing.T) {
	f := newInteractionFixture(t, ModeStream)
	binding, err := f.core.Binding(f.binding)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	ref := f.layer.OnBindingCreated(binding)
	if ref.ID != f.channel.ID {
		t.Fatalf("onBindingCreated returned %+v, want channel %s", ref, f.channel.ID)
	}
	f.layer.OnBindingActive(binding)
	f.layer.OnBindingDormant(binding)
	if got := f.state(t); got != ChannelActive {
		t.Fatalf("a notification must not change the derived state: %s", got)
	}
	f.layer.OnBindingClosed(binding)
	if got := f.state(t); got != ChannelClosed {
		t.Fatalf("state after onBindingClosed = %s, want CLOSED (CC-2)", got)
	}
	var _ InteractionToComposition = f.layer
}

// ---------------------------------------------------------------------------
// Transport capability gate — §10.2, §10.4, TR-3, TR-4, TR-9
// ---------------------------------------------------------------------------

func TestTR4AChannelMustNotUseBeyondTheTransportsCapabilities(t *testing.T) {
	core := NewCore()
	capability := capabilityOf("casing.apply", "1.0.0")
	provider, consumer := activePair(t, core, capability)
	binding, err := core.Bind(BindRequest{
		From:       provider.Identity,
		To:         consumer.Identity,
		Capability: CapabilityRef{Name: capability.Name, Version: capability.Version},
	})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}

	// A transport that declares no at-least-once delivery cannot carry a stream
	// or state Channel, which §4.4 makes at-least-once only.
	noDelivery := newInteractionWithCapabilities(core, TransportCapabilities{
		SupportsCursor:     true,
		Ordering:           "global",
		DurabilityBoundary: "process",
	})
	_, err = noDelivery.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeStream})
	wantCode(t, err, CodeUnsupported) // TR-4, TR-9
	// An event Channel on the same transport is fine: at-most-once is declared
	// by default in this test's zero capabilities... which it is not, so the
	// refusal applies there too.
	if _, err := noDelivery.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeEvent}); err == nil {
		t.Fatal("a transport declaring neither guarantee MUST refuse both (TR-4)")
	}

	// A transport that carries messages but has no cursors cannot carry a stream
	// Channel, and CR-5 names the missing feature in the code.
	noCursor := newInteractionWithCapabilities(core, TransportCapabilities{
		Delivery:           TransportDeliveryCapabilities{AtMostOnce: true, AtLeastOnce: true},
		Ordering:           "per-source",
		SupportsLease:      false,
		DurabilityBoundary: "machine",
	})
	_, err = noCursor.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeStream})
	wantCode(t, err, CodeCursorUnsupported)
	if _, err := noCursor.CreateChannel(CreateChannelRequest{Binding: binding.ID, Mode: ModeEvent}); err != nil {
		t.Fatalf("an event channel needs no cursor: %v", err)
	}
}

// newInteractionWithCapabilities builds a layer over a transport that declares
// exactly the given capabilities.
func newInteractionWithCapabilities(core *Core, capabilities TransportCapabilities) *Interaction {
	return NewInteractionWithTransport(core, capabilityTransport{
		inner:        NewMemoryTransport(),
		capabilities: capabilities,
	})
}

// ---------------------------------------------------------------------------
// test transports
// ---------------------------------------------------------------------------

// noPositionTransport is a Transport without §6.2's CursorPositions, i.e. one
// that carries messages but cannot answer "where does history start" or "where is
// the head". CR-5 says what must happen when a caller asks for an anchor anyway.
type noPositionTransport struct {
	inner *MemoryTransport
}

func (n noPositionTransport) ID() string { return "no-positions" }

func (n noPositionTransport) Capabilities() TransportCapabilities {
	return n.inner.Capabilities()
}

func (n noPositionTransport) Send(channel string, message any) (Cursor, error) {
	return n.inner.Send(channel, message)
}

func (n noPositionTransport) ReadAfter(channel string, after *Cursor, pattern Pattern) ([]TransportMessage, error) {
	return n.inner.ReadAfter(channel, after, pattern)
}

func (n noPositionTransport) Close() error { return n.inner.Close() }

// compactingTransport is a Transport whose log has a retention floor: positions
// below `floor` were discarded. §6.2's rules 6 and 7 are about exactly this.
type compactingTransport struct {
	inner *MemoryTransport
	floor Cursor
}

func (c compactingTransport) ID() string { return "compacting" }

func (c compactingTransport) Capabilities() TransportCapabilities {
	capabilities := c.inner.Capabilities()
	capabilities.Persistent = true
	return capabilities
}

func (c compactingTransport) Send(channel string, message any) (Cursor, error) {
	return c.inner.Send(channel, message)
}

func (c compactingTransport) ReadAfter(channel string, after *Cursor, pattern Pattern) ([]TransportMessage, error) {
	return c.inner.ReadAfter(channel, after, pattern)
}

func (c compactingTransport) Close() error { return c.inner.Close() }

func (c compactingTransport) Floor(channel string) (Cursor, error) { return c.floor, nil }

func (c compactingTransport) Head(channel string) (Cursor, error) { return c.inner.Head(channel) }

// capabilityTransport is a Transport that declares exactly what it is told to,
// so that TR-3's "MUST NOT pretend" can be tested from the other side: a Channel
// is only allowed to use what was declared (TR-4).
type capabilityTransport struct {
	inner        *MemoryTransport
	capabilities TransportCapabilities
}

func (c capabilityTransport) ID() string { return "declared" }

func (c capabilityTransport) Capabilities() TransportCapabilities { return c.capabilities }

func (c capabilityTransport) Send(channel string, message any) (Cursor, error) {
	return c.inner.Send(channel, message)
}

func (c capabilityTransport) ReadAfter(channel string, after *Cursor, pattern Pattern) ([]TransportMessage, error) {
	return c.inner.ReadAfter(channel, after, pattern)
}

func (c capabilityTransport) Close() error { return c.inner.Close() }
