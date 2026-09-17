package main

// Driver-level tests for the interaction operations.
//
// These cover the adapter's contract for the v3.1 operations — the JSON shapes
// conformance/driver.md fixes, the two-step `create`/`connect` path, one response
// per request, and the codes that name a refusal — not the layer's invariants,
// which have their own tests in package eapp.

import (
	"encoding/json"
	"testing"
)

// interactionSetup is the request prefix every test below starts from: two
// ACTIVE plugins, one exposing a capability, bound. Ids 1 … 7.
var interactionSetup = []string{
	`{"id":1,"op":"identity.create","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
	`{"id":2,"op":"identity.create","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
	`{"id":3,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[{"name":"casing.apply","version":"1.0.0"}]}`,
	`{"id":4,"op":"plugin.register","identity":{"domain":"acme","id":"b","instance":"b-1"},"capabilities":[]}`,
	`{"id":5,"op":"lifecycle.activate","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
	`{"id":6,"op":"lifecycle.activate","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
	`{"id":7,"op":"composition.bind","from":{"domain":"acme","id":"a","instance":"a-1"},"to":{"domain":"acme","id":"b","instance":"b-1"},"capability":{"name":"casing.apply","version":"1.0.0"}}`,
}

// runInteraction runs the setup followed by extra requests.
func runInteraction(t *testing.T, extra ...string) *harness {
	t.Helper()
	return run(t, append(append([]string{}, interactionSetup...), extra...)...)
}

func TestInteractionChannelLifecycleThroughTheDriver(t *testing.T) {
	h := runInteraction(t,
		`{"id":8,"op":"channel.create","binding":"binding-1","mode":"stream"}`,
		`{"id":9,"op":"channel.connect","channel":"channel-1"}`,
		`{"id":10,"op":"channel.get","channel":"channel-1"}`,
		`{"id":11,"op":"channel.channels"}`,
		// §2.4: suspending the consumer's plugin makes the Binding DORMANT, and
		// the Channel MUST follow it into DRAINING.
		`{"id":12,"op":"lifecycle.suspend","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
		`{"id":13,"op":"channel.get","channel":"channel-1"}`,
		`{"id":14,"op":"channel.send","channel":"channel-1","payload":"while-draining"}`,
		`{"id":15,"op":"lifecycle.resume","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
		`{"id":16,"op":"channel.get","channel":"channel-1"}`,
		// CC-2's third row: unbinding closes the Channel.
		`{"id":17,"op":"composition.unbind","binding":"binding-1"}`,
		`{"id":18,"op":"channel.get","channel":"channel-1"}`,
		`{"id":19,"op":"channel.close","channel":"channel-1"}`,
	)

	created := h.result(t, 7)
	if created["state"] != "OPEN" {
		t.Fatalf("state at creation = %v, want OPEN (CC-8)", created["state"])
	}
	if created["mode"] != "stream" || created["delivery"] != "at-least-once" {
		t.Fatalf("channel = %v, want stream with at-least-once (CC-4)", created)
	}
	if created["binding"] != "binding-1" {
		t.Fatalf("channel.binding = %v, want binding-1 (CH-1)", created["binding"])
	}
	if connected := h.result(t, 8); connected["state"] != "ACTIVE" {
		t.Fatalf("state after connect = %v, want ACTIVE (CC-8)", connected["state"])
	}
	if listed, _ := h.responses()[10]["result"].([]any); len(listed) != 1 {
		t.Fatalf("channel.channels = %v, want one channel", h.responses()[10]["result"])
	}
	h.result(t, 9) // channel.get succeeds
	if state := h.result(t, 12)["state"]; state != "DRAINING" {
		t.Fatalf("state while the binding is DORMANT = %v, want DRAINING (CC-2)", state)
	}
	if code := h.errorCode(t, 13); code != "EAPP_CHANNEL_DRAINING" {
		t.Fatalf("sending while DRAINING = %s, want EAPP_CHANNEL_DRAINING (§2.4)", code)
	}
	if state := h.result(t, 15)["state"]; state != "ACTIVE" {
		t.Fatalf("state after the binding recovered = %v, want ACTIVE (CC-2)", state)
	}
	if state := h.result(t, 17)["state"]; state != "CLOSED" {
		t.Fatalf("state after unbind = %v, want CLOSED (CH-2)", state)
	}
	// CH-4: the close that follows an already-closed Channel succeeds.
	h.result(t, 18)
}

func TestInteractionDeliveryIsCheckedAgainstTheMode(t *testing.T) {
	h := runInteraction(t,
		`{"id":8,"op":"channel.create","binding":"binding-1","mode":"stream"}`,
		`{"id":9,"op":"channel.create","binding":"binding-1","mode":"stream","delivery":"at-most-once"}`,
		`{"id":10,"op":"channel.create","binding":"binding-1"}`,
		`{"id":11,"op":"channel.create","binding":"binding-1","mode":"bogus"}`,
		`{"id":12,"op":"channel.create","binding":"no-such-binding","mode":"event"}`,
		`{"id":13,"op":"channel.create","binding":"binding-1","mode":"state"}`,
	)
	if code := h.errorCode(t, 8); code != "EAPP_DELIVERY_UNSUPPORTED" {
		t.Fatalf("stream + at-most-once = %s, want EAPP_DELIVERY_UNSUPPORTED (CC-5, DL-6)", code)
	}
	if code := h.errorCode(t, 9); code != "EAPP_MODE_INVALID" {
		t.Fatalf("channel.create with no mode = %s, want EAPP_MODE_INVALID (CC-3)", code)
	}
	if code := h.errorCode(t, 10); code != "EAPP_MODE_INVALID" {
		t.Fatalf("channel.create with an unknown mode = %s, want EAPP_MODE_INVALID (CC-3)", code)
	}
	if code := h.errorCode(t, 11); code != "EAPP_BINDING_INVALID" {
		t.Fatalf("channel.create on a nonexistent binding = %s, want EAPP_BINDING_INVALID (CC-6)", code)
	}
	// A state Channel is creatable at this layer (it is one of §3's four modes);
	// v3.2's StateChannel is a further configuration step this driver does not
	// implement, and it declares no `state` layer.
	state := h.result(t, 12)
	if state["mode"] != "state" || state["delivery"] != "at-least-once" {
		t.Fatalf("state channel = %v, want state with at-least-once (CC-4)", state)
	}
}

func TestInteractionSubscriptionFlowThroughTheDriver(t *testing.T) {
	h := runInteraction(t,
		`{"id":8,"op":"channel.create","binding":"binding-1","mode":"stream"}`,
		`{"id":9,"op":"channel.connect","channel":"channel-1"}`,
		`{"id":10,"op":"channel.send","channel":"channel-1","payload":{"n":1}}`,
		`{"id":11,"op":"channel.send","channel":"channel-1","payload":{"n":2}}`,
		`{"id":12,"op":"subscription.open","channel":"channel-1","options":{"cursor":"earliest"}}`,
		`{"id":13,"op":"subscription.pull","subscription":"subscription-1"}`,
		`{"id":14,"op":"subscription.ack","subscription":"subscription-1","delivery":"delivery-1"}`,
		`{"id":15,"op":"subscription.state","subscription":"subscription-1"}`,
		`{"id":16,"op":"subscription.pull","subscription":"subscription-1","timeoutMs":25}`,
		`{"id":17,"op":"subscription.nack","subscription":"subscription-1","delivery":"delivery-2"}`,
		`{"id":18,"op":"subscription.ack","subscription":"subscription-1","delivery":"delivery-2"}`,
		`{"id":19,"op":"subscription.pull","subscription":"subscription-1"}`,
		`{"id":20,"op":"subscription.ack","subscription":"subscription-1","delivery":"delivery-3"}`,
		`{"id":21,"op":"subscription.pull","subscription":"subscription-1"}`,
		`{"id":22,"op":"subscription.suspend","subscription":"subscription-1"}`,
		`{"id":23,"op":"subscription.state","subscription":"subscription-1"}`,
		`{"id":24,"op":"channel.send","channel":"channel-1","payload":{"n":3}}`,
		`{"id":25,"op":"subscription.pull","subscription":"subscription-1"}`,
		`{"id":26,"op":"subscription.resume","subscription":"subscription-1"}`,
		`{"id":27,"op":"subscription.pull","subscription":"subscription-1"}`,
		`{"id":28,"op":"subscription.close","subscription":"subscription-1"}`,
		`{"id":29,"op":"subscription.close","subscription":"subscription-1"}`,
		`{"id":30,"op":"subscription.pull","subscription":"subscription-1"}`,
	)

	opened := h.result(t, 11)
	if opened["cursor"] == "" || opened["cursor"] == nil {
		t.Fatalf("subscription.open returned no cursor: %v (SUB-9)", opened)
	}
	if opened["mode"] != "exclusive" || opened["state"] != "ACTIVE" {
		t.Fatalf("subscription = %v, want exclusive/ACTIVE", opened)
	}

	first := h.result(t, 12)
	item, _ := first["item"].(map[string]any)
	if item == nil {
		t.Fatalf("pull returned no item: %v", first)
	}
	if item["delivery"] == "" || item["cursor"] == "" {
		t.Fatalf("item = %v, want a delivery token and a cursor", item)
	}
	payload, _ := json.Marshal(item["payload"])
	if string(payload) != `{"n":1}` {
		t.Fatalf("payload = %s, want the bytes that were sent", payload)
	}
	// The confirmed cursor is the acknowledged position (CR-3, §6.4).
	state := h.result(t, 14)
	if state["cursor"] != item["cursor"] {
		t.Fatalf("state.cursor = %v, want the acknowledged %v", state["cursor"], item["cursor"])
	}

	// The second message, delivered on the next pull.
	second, _ := h.result(t, 15)["item"].(map[string]any)
	if second == nil {
		t.Fatalf("pull returned no item: %v", h.result(t, 15))
	}
	// §6.4: the nacked item returns to the available set and is delivered again,
	// which means the ack that follows acts on a *fresh* delivery of the same
	// position rather than on the rejected one.
	if code := h.errorCode(t, 17); code != "EAPP_LEASE_CLOSED" {
		t.Fatalf("ack after nack MUST be refused (AK-4), got %s", code)
	}
	redelivered, _ := h.result(t, 18)["item"].(map[string]any)
	if redelivered == nil || redelivered["cursor"] != second["cursor"] {
		t.Fatalf("redelivered item = %v, want the nacked position %v (§6.4)", h.result(t, 18), second["cursor"])
	}
	h.result(t, 19) // ack the redelivery

	// Nothing is available once every position is acknowledged, and that is not
	// an error (TR-7's rule, applied to a subscription).
	if empty := h.result(t, 20); empty["item"] != nil || empty["done"] != false {
		t.Fatalf("pull with nothing available = %v, want {item: null, done: false}", empty)
	}

	h.result(t, 21) // suspend
	if state := h.result(t, 22)["state"]; state != "SUSPENDED" {
		t.Fatalf("state after suspend = %v, want SUSPENDED (SUB-5)", state)
	}
	h.result(t, 23) // send while suspended
	if pending := h.result(t, 24); pending["item"] != nil || pending["done"] != false {
		t.Fatalf("pull while suspended = %v, want {item: null, done: false} (SUB-5)", pending)
	}
	h.result(t, 25) // resume
	if resumed := h.result(t, 26); resumed["item"] == nil {
		t.Fatalf("delivery MUST continue after resume (SUB-5): %v", resumed)
	}
	h.result(t, 27) // close
	h.result(t, 28) // close is idempotent (SUB-6)
	terminated := h.result(t, 29)
	if terminated["done"] != true || terminated["item"] != nil {
		t.Fatalf("pull after close = %v, want {item: null, done: true} (SUB-7)", terminated)
	}
}

func TestInteractionTransportOperationsThroughTheDriver(t *testing.T) {
	h := runInteraction(t,
		`{"id":8,"op":"transport.capabilities"}`,
		`{"id":9,"op":"channel.create","binding":"binding-1","mode":"event"}`,
		`{"id":10,"op":"transport.send","channel":"channel-1","payload":"one"}`,
		`{"id":11,"op":"transport.send","channel":"channel-1","payload":"two"}`,
		`{"id":12,"op":"transport.readAfter","channel":"channel-1","pattern":{"all":true}}`,
		`{"id":13,"op":"transport.readAfter","channel":"channel-1","cursor":"0000000000000001","pattern":{"all":true}}`,
		`{"id":14,"op":"transport.readAfter","channel":"channel-1","cursor":"0000000000000002","pattern":{"all":true}}`,
		`{"id":15,"op":"transport.readAfter","channel":"channel-1","cursor":"0000000000000002","pattern":{"key":"nope"}}`,
	)

	capabilities := h.result(t, 7)
	if capabilities["persistent"] != false || capabilities["durabilityBoundary"] != "process" {
		t.Fatalf("capabilities = %v, want §10.3's Memory row", capabilities)
	}
	delivery, _ := capabilities["delivery"].(map[string]any)
	if delivery == nil || delivery["atLeastOnce"] != true || delivery["replay"] != false {
		t.Fatalf("capabilities.delivery = %v, want §10.3's Memory row", capabilities["delivery"])
	}

	all, _ := h.responses()[11]["result"].([]any)
	if len(all) != 2 {
		t.Fatalf("readAfter with no cursor returned %d messages, want 2 (TR-6)", len(all))
	}
	after, _ := h.responses()[12]["result"].([]any)
	if len(after) != 1 {
		t.Fatalf("readAfter(first) returned %d messages, want 1 (TR-5)", len(after))
	}
	// TR-7: an empty result is `[]`, never `null`, and an unsupported pattern is
	// refused with the code that names it rather than silently matching nothing.
	empty, _ := h.responses()[13]["result"].([]any)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("readAfter past the head = %v, want [] (TR-7)", h.responses()[13]["result"])
	}
	if code := h.errorCode(t, 14); code != "EAPP_UNSUPPORTED" {
		t.Fatalf("an unsupported pattern = %s, want EAPP_UNSUPPORTED (TR-9)", code)
	}
}

func TestInteractionConsumerGroupThroughTheDriver(t *testing.T) {
	h := runInteraction(t,
		`{"id":8,"op":"channel.create","binding":"binding-1","mode":"stream"}`,
		`{"id":9,"op":"channel.connect","channel":"channel-1"}`,
		`{"id":10,"op":"channel.send","channel":"channel-1","payload":1}`,
		`{"id":11,"op":"channel.send","channel":"channel-1","payload":2}`,
		`{"id":12,"op":"group.open","channel":"channel-1","name":"workers"}`,
		`{"id":13,"op":"group.open","channel":"channel-1","name":"workers"}`,
		`{"id":14,"op":"group.view","group":"group-1"}`,
		`{"id":15,"op":"subscription.open","channel":"channel-1","options":{"mode":"group","group":"workers"}}`,
		`{"id":16,"op":"subscription.open","channel":"channel-1","options":{"mode":"group","group":"workers"}}`,
		`{"id":17,"op":"subscription.pull","subscription":"subscription-1"}`,
		`{"id":18,"op":"subscription.pull","subscription":"subscription-2"}`,
		`{"id":19,"op":"group.view","group":"group-1"}`,
		`{"id":20,"op":"subscription.open","channel":"channel-1","options":{"mode":"group","group":"nobody"}}`,
		`{"id":21,"op":"group.close","group":"group-1"}`,
	)

	opened := h.result(t, 11)
	if opened["name"] != "workers" || opened["channel"] != "channel-1" {
		t.Fatalf("group = %v", opened)
	}
	if code := h.errorCode(t, 12); code != "EAPP_SUBSCRIPTION_INVALID" {
		t.Fatalf("a duplicate group name = %s, want EAPP_SUBSCRIPTION_INVALID (CG-1)", code)
	}
	memberA := h.result(t, 14)
	memberB := h.result(t, 15)
	if memberA["cursor"] != memberB["cursor"] {
		t.Fatalf("two members report %v and %v; a group has one cursor (CG-2)",
			memberA["cursor"], memberB["cursor"])
	}
	first, _ := h.result(t, 16)["item"].(map[string]any)
	second, _ := h.result(t, 17)["item"].(map[string]any)
	if first == nil || second == nil {
		t.Fatalf("two members must each receive a distinct position (CG-3): %v %v", first, second)
	}
	if first["cursor"] == second["cursor"] {
		t.Fatalf("both members received %v (CG-3, L-2)", first["cursor"])
	}
	if count := h.result(t, 18)["memberCount"]; count != float64(2) {
		t.Fatalf("memberCount = %v, want 2", count)
	}
	if code := h.errorCode(t, 19); code != "EAPP_SUBSCRIPTION_INVALID" {
		t.Fatalf("joining a nonexistent group = %s, want EAPP_SUBSCRIPTION_INVALID (CG-8)", code)
	}
	h.result(t, 20) // group.close
}
