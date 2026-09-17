package main

// Driver-level tests.
//
// The Core has its own invariant tests in package eapp; these tests cover the
// adapter's own contract, which is a different thing: the hello line, echo of
// `id`, one response per request, the error envelope, the unknown-op rule, and
// the JSON shapes that conformance/driver.md fixes. Every one of them is a way
// a driver can be wrong while the library underneath is right.

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// harness feeds lines to a driver and records the framed output in order.
type harness struct {
	mu    sync.Mutex
	lines []map[string]any
}

// recorder is an io.Writer that splits the driver's output into JSON lines.
type recorder struct {
	harness *harness
	buffer  bytes.Buffer
}

func (r *recorder) Write(p []byte) (int, error) {
	r.buffer.Write(p)
	for {
		line, err := r.buffer.ReadString('\n')
		if err != nil {
			// No complete line yet: put the partial back.
			r.buffer.WriteString(line)
			return len(p), nil
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var object map[string]any
		if err := json.Unmarshal([]byte(line), &object); err != nil {
			return 0, err
		}
		r.harness.mu.Lock()
		r.harness.lines = append(r.harness.lines, object)
		r.harness.mu.Unlock()
	}
}

// run drives the driver with the given request lines and returns the harness.
func run(t *testing.T, requests ...string) *harness {
	t.Helper()
	h := &harness{}
	d := newDriver(&recorder{harness: h})
	done := make(chan error, 1)
	go func() { done <- d.run(strings.NewReader(strings.Join(requests, "\n") + "\n")) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("driver run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("driver did not finish")
	}
	return h
}

// responses returns only the response objects (those carrying an `id`).
func (h *harness) responses() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]map[string]any, 0, len(h.lines))
	for _, line := range h.lines {
		if _, isResponse := line["id"]; isResponse {
			out = append(out, line)
		}
	}
	return out
}

// events returns only the event objects (those carrying an `event`).
func (h *harness) events() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]map[string]any, 0, len(h.lines))
	for _, line := range h.lines {
		if _, isEvent := line["event"]; isEvent {
			out = append(out, line)
		}
	}
	return out
}

// hello returns the first output line.
func (h *harness) hello() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.lines) == 0 {
		return nil
	}
	return h.lines[0]
}

// result returns responses[i]["result"], failing if the response was an error.
func (h *harness) result(t *testing.T, index int) map[string]any {
	t.Helper()
	responses := h.responses()
	if index >= len(responses) {
		t.Fatalf("expected at least %d responses, got %d", index+1, len(responses))
	}
	found := responses[index]
	if ok, _ := found["ok"].(bool); !ok {
		t.Fatalf("response %d is an error: %v", index, found)
	}
	result, _ := found["result"].(map[string]any)
	if result == nil {
		t.Fatalf("response %d has no object result: %v", index, found)
	}
	return result
}

// errorCode returns responses[index]["error"]["code"].
func (h *harness) errorCode(t *testing.T, index int) string {
	t.Helper()
	responses := h.responses()
	if index >= len(responses) {
		t.Fatalf("expected at least %d responses, got %d", index+1, len(responses))
	}
	found := responses[index]
	if ok, _ := found["ok"].(bool); ok {
		t.Fatalf("response %d unexpectedly succeeded: %v", index, found)
	}
	envelope, _ := found["error"].(map[string]any)
	if envelope == nil {
		t.Fatalf("response %d has no error object: %v", index, found)
	}
	code, _ := envelope["code"].(string)
	if code == "" {
		t.Fatalf("response %d has an empty error code: %v", index, found)
	}
	if message, ok := envelope["message"].(string); !ok || message == "" {
		t.Fatalf("response %d has no human-readable message: %v", index, found)
	}
	return code
}

// identityOf extracts an identity object's instance field.
func identityOf(t *testing.T, object map[string]any) string {
	t.Helper()
	instance, ok := object["instance"].(string)
	if !ok {
		t.Fatalf("expected an identity object, got %v", object)
	}
	return instance
}

func TestHelloLineIsFirstAndExact(t *testing.T) {
	h := run(t)
	hello := h.hello()
	if hello == nil {
		t.Fatal("the driver MUST print a hello line")
	}
	if value, _ := hello["hello"].(bool); !value {
		t.Fatalf("hello member missing: %v", hello)
	}
	if got, _ := hello["driver"].(string); got != "eapp-go" {
		t.Fatalf("driver = %q, want eapp-go", got)
	}
	if got, _ := hello["eappVersion"].(string); got != "3.3.0" {
		t.Fatalf("eappVersion = %q, want 3.3.0", got)
	}
	layers, _ := hello["layers"].([]any)
	if len(layers) != 2 || layers[0] != "core" || layers[1] != "interaction" {
		t.Fatalf("layers = %v, want [core interaction] (this driver implements the Composition Core and the Interaction Layer, and not the State layer)", layers)
	}
	// Exactly one hello line, and it is the very first output.
	if count := strings.Count(strings.TrimSpace(renderLines(h)), "\"hello\":true"); count != 1 {
		t.Fatalf("expected exactly one hello line, found %d", count)
	}
}

// renderLines re-renders the harness output for textual assertions.
func renderLines(h *harness) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var builder strings.Builder
	for _, line := range h.lines {
		data, _ := json.Marshal(line)
		builder.Write(data)
		builder.WriteByte('\n')
	}
	return builder.String()
}

func TestEndToEndFlow(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"identity.create","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":2,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[{"name":"casing.apply","version":"1.0.0"}]}`,
		`{"id":3,"op":"plugin.register","identity":{"domain":"acme","id":"b","instance":"b-1"},"capabilities":[]}`,
		`{"id":4,"op":"lifecycle.activate","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":5,"op":"lifecycle.activate","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
		`{"id":6,"op":"composition.bind","from":{"domain":"acme","id":"a","instance":"a-1"},"to":{"domain":"acme","id":"b","instance":"b-1"},"capability":{"name":"casing.apply","version":"1.0.0"}}`,
		`{"id":7,"op":"composition.bindingState","binding":"binding-1"}`,
		`{"id":8,"op":"plugin.list"}`,
		`{"id":9,"op":"lifecycle.suspend","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
		`{"id":10,"op":"composition.bindingState","binding":"binding-1"}`,
		`{"id":11,"op":"composition.unbind","binding":"binding-1"}`,
		`{"id":12,"op":"composition.bindingState","binding":"binding-1"}`,
		`{"id":13,"op":"nonsense"}`,
	)

	// One response per request, ids echoed in order.
	responses := h.responses()
	if len(responses) != 13 {
		t.Fatalf("expected 13 responses, got %d: %v", len(responses), responses)
	}
	for i, found := range responses {
		want := float64(i + 1)
		if got, _ := found["id"].(float64); got != want {
			t.Fatalf("response %d echoes id %v, want %v", i, found["id"], want)
		}
	}

	if instance := identityOf(t, h.result(t, 0)); instance != "a-1" {
		t.Fatalf("identity.create returned instance %q", instance)
	}
	// plugin.register answers with the minted, authoritative identity.
	if instance := identityOf(t, h.result(t, 1)); instance != "a-1" {
		t.Fatalf("plugin.register returned instance %q", instance)
	}
	if lifecycle, _ := h.result(t, 3)["lifecycle"].(string); lifecycle != "ACTIVE" {
		t.Fatalf("activate answered %v", h.result(t, 3))
	}
	// The binding carries the wire shape of §conformance/driver.md.
	binding := h.result(t, 5)
	for _, key := range []string{"id", "from", "to", "capability"} {
		if _, present := binding[key]; !present {
			t.Fatalf("binding is missing %q: %v", key, binding)
		}
	}
	capability, _ := binding["capability"].(map[string]any)
	if capability["name"] != "casing.apply" || capability["version"] != "1.0.0" {
		t.Fatalf("capability = %v", capability)
	}
	if _, leaked := capability["plugin"]; leaked {
		t.Fatalf("the wire CapabilityRef MUST NOT carry `plugin`: %v", capability)
	}
	if state, _ := h.result(t, 6)["state"].(string); state != "ACTIVE" {
		t.Fatalf("bindingState = %v, want ACTIVE", h.result(t, 6))
	}
	// Suspend makes the binding DORMANT without unbinding it (O-7, L-5).
	if state, _ := h.result(t, 9)["state"].(string); state != "DORMANT" {
		t.Fatalf("bindingState after suspend = %v, want DORMANT", h.result(t, 9))
	}
	// Unbind closes it, and unbind is idempotent (O-3, O-4).
	if state, _ := h.result(t, 11)["state"].(string); state != "CLOSED" {
		t.Fatalf("bindingState after unbind = %v, want CLOSED", h.result(t, 11))
	}
	// The unknown op.
	if code := h.errorCode(t, 12); code != "EAPP_UNSUPPORTED" {
		t.Fatalf("unknown op returned %s, want EAPP_UNSUPPORTED", code)
	}
}

func TestDuplicateIdentityIsRejectedWithTheFrozenCode(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[]}`,
		`{"id":2,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[]}`,
		`{"id":3,"op":"identity.create","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
	)
	if code := h.errorCode(t, 1); code != "EAPP_IDENTITY_DUPLICATE" {
		t.Fatalf("duplicate registration returned %s (P-1, ID-3)", code)
	}
	if code := h.errorCode(t, 2); code != "EAPP_IDENTITY_DUPLICATE" {
		t.Fatalf("duplicate identity.create returned %s (ID-3)", code)
	}
}

func TestIdentityCreateMintsAnOmittedInstance(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"identity.create","identity":{"domain":"acme","id":"a"}}`,
		`{"id":2,"op":"identity.create","identity":{"domain":"acme","id":"a"}}`,
	)
	first := h.result(t, 0)
	second := h.result(t, 1)
	firstInstance := identityOf(t, first)
	secondInstance := identityOf(t, second)
	if firstInstance == "" || secondInstance == "" {
		t.Fatalf("an omitted instance MUST be minted (ID-3, ID-5): %v / %v", first, second)
	}
	if firstInstance == secondInstance {
		t.Fatalf("two mints produced one instance %q (ID-3)", firstInstance)
	}
}

func TestIdentityWithAnUnknownMemberIsRejected(t *testing.T) {
	// ID-6: the identity is exactly {domain, id, instance}. An extra member MUST
	// be refused, not stripped — stripping would let a caller believe a version
	// participated in identity.
	h := run(t,
		`{"id":1,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1","version":"1.0.0"},"capabilities":[]}`,
		`{"id":2,"op":"identity.create","identity":{"domain":"acme","id":"a","instance":"a-1","namespace":"x"}}`,
		`{"id":3,"op":"composition.bind","from":{"domain":"acme","id":"a","instance":"a-1","v":1},"to":{"domain":"acme","id":"b","instance":"b-1"},"capability":{"name":"c","version":"1.0.0"}}`,
	)
	for i := 0; i < 3; i++ {
		if code := h.errorCode(t, i); code != "EAPP_IDENTITY_INVALID" {
			t.Fatalf("request %d returned %s, want EAPP_IDENTITY_INVALID (ID-6)", i+1, code)
		}
	}
}

func TestUnknownOpDoesNotCrashAndDoesNotSucceed(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"nonsense"}`,
		`{"id":2,"op":""}`,
		`{"id":3,"op":"interaction.request"}`,
		`{"id":4,"op":"state.get"}`,
		// The driver survives the unknown ops and keeps answering.
		`{"id":5,"op":"plugin.list"}`,
	)
	for i := 0; i < 4; i++ {
		if code := h.errorCode(t, i); code != "EAPP_UNSUPPORTED" {
			t.Fatalf("request %d returned %s, want EAPP_UNSUPPORTED", i+1, code)
		}
	}
	if ok, _ := h.responses()[4]["ok"].(bool); !ok {
		t.Fatalf("the driver MUST keep serving after unknown ops: %v", h.responses()[4])
	}
}

func TestUnparseableLineIsNotAnsweredWithAnUnpairedFrame(t *testing.T) {
	// A line the driver cannot parse has no id to echo, and the harness pairs
	// replies by id — so an unpaired frame would be a protocol violation that
	// aborts the whole run. The driver stops instead, with a diagnostic on
	// stderr, which is the honest answer: it cannot reply to something it cannot
	// identify.
	h := &harness{}
	d := newDriver(&recorder{harness: h})
	err := d.run(strings.NewReader("this is not json\n{\"id\":1,\"op\":\"plugin.list\"}\n"))
	if err == nil {
		t.Fatal("an unidentifiable request MUST stop the driver rather than produce an unpaired frame")
	}
	if len(h.responses()) != 0 {
		t.Fatalf("the driver answered a request it could not identify: %v", h.responses())
	}
}

func TestFailedArgumentStillEchoesTheRequestID(t *testing.T) {
	// The interesting failure path: the request is well formed as a whole, but an
	// operation argument inside it is not. The id is known, so the response MUST
	// carry it — a null id here would abort the harness on a request it could
	// perfectly well act on.
	h := run(t,
		`{"id":7,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1","version":"1.0.0"},"capabilities":[]}`,
		`{"id":8,"op":"plugin.list"}`,
	)
	responses := h.responses()
	if len(responses) != 2 {
		t.Fatalf("expected 2 responses, got %d: %v", len(responses), responses)
	}
	if got, _ := responses[0]["id"].(float64); got != 7 {
		t.Fatalf("the error response echoes id %v, want 7", responses[0]["id"])
	}
	if code := h.errorCode(t, 0); code != "EAPP_IDENTITY_INVALID" {
		t.Fatalf("a malformed identity inside a request returned %s (ID-6)", code)
	}
	if ok, _ := responses[1]["ok"].(bool); !ok {
		t.Fatal("the driver MUST keep serving after a rejected argument")
	}
}

func TestDiscoveryEventsCarryNoID(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"discovery.watch","criteria":{},"scope":{}}`,
		`{"id":2,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[]}`,
		`{"id":3,"op":"discovery.unwatch","watch":1}`,
	)
	// Give the forwarding goroutine a chance to flush before asserting.
	deadline := time.Now().Add(3 * time.Second)
	for len(h.events()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	events := h.events()
	if len(events) != 1 {
		t.Fatalf("expected one discovery event, got %d: %v", len(events), events)
	}
	event := events[0]
	if _, hasID := event["id"]; hasID {
		t.Fatalf("an event MUST NOT carry `id`: %v", event)
	}
	if event["event"] != "discovery" {
		t.Fatalf("event = %v", event["event"])
	}
	if event["type"] != "added" {
		t.Fatalf("type = %v, want added (D-6)", event["type"])
	}
	if got, _ := event["watch"].(float64); got != 1 {
		t.Fatalf("watch = %v, want 1", event["watch"])
	}
	if instance := identityOf(t, event["plugin"].(map[string]any)); instance != "a-1" {
		t.Fatalf("event plugin = %v", event["plugin"])
	}
	// And it did not consume a response slot.
	if len(h.responses()) != 3 {
		t.Fatalf("expected 3 responses, got %d: %v", len(h.responses()), h.responses())
	}
}

func TestResetReturnsToTheInitialState(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[]}`,
		`{"id":2,"op":"identity.has","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":3,"op":"reset"}`,
		`{"id":4,"op":"identity.has","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":5,"op":"plugin.list"}`,
	)
	if has, _ := h.result(t, 1)["has"].(bool); !has {
		t.Fatalf("identity registered in request 1 MUST be known: %v", h.result(t, 1))
	}
	if has, _ := h.result(t, 3)["has"].(bool); has {
		t.Fatal("reset MUST clear the identity space")
	}
	list, ok := h.responses()[4]["result"].([]any)
	if !ok {
		t.Fatalf("plugin.list result = %v", h.responses()[4]["result"])
	}
	if len(list) != 0 {
		t.Fatalf("reset MUST clear plugins, got %v", list)
	}
}

func TestEmptyResultsAreListsNotNull(t *testing.T) {
	// `[]` and `null` are different answers to a harness.
	h := run(t,
		`{"id":1,"op":"plugin.list"}`,
		`{"id":2,"op":"discovery.find"}`,
		`{"id":3,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":4,"op":"plugin.get","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
	)
	lines := renderLines(h)
	if !strings.Contains(lines, `"result":[]`) {
		t.Fatalf("empty results MUST be rendered as []: %s", lines)
	}
	// P-2: a plugin with an empty capability set renders `[]`.
	plugin := h.result(t, 3)
	if plugin["capabilities"] == nil {
		t.Fatalf("an empty capability set MUST be []: %v", plugin)
	}
}

func TestPluginListHasStableOrder(t *testing.T) {
	requests := []string{
		`{"id":1,"op":"plugin.register","identity":{"domain":"acme","id":"c","instance":"c-1"}}`,
		`{"id":2,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":3,"op":"plugin.register","identity":{"domain":"acme","id":"b","instance":"b-1"}}`,
		`{"id":4,"op":"plugin.list"}`,
	}
	first := run(t, requests...)
	second := run(t, requests...)
	if renderLines(first) != renderLines(second) {
		t.Fatal("plugin.list MUST be deterministically ordered (Go randomises map iteration)")
	}
	list, _ := first.responses()[3]["result"].([]any)
	if len(list) != 3 {
		t.Fatalf("plugin.list returned %v", list)
	}
	for i, want := range []string{"a-1", "b-1", "c-1"} {
		entry, _ := list[i].(map[string]any)
		identity, _ := entry["identity"].(map[string]any)
		if identity["instance"] != want {
			t.Fatalf("plugin.list[%d] = %v, want instance %s", i, entry, want)
		}
	}
}

func TestBootstrapOperations(t *testing.T) {
	h := run(t,
		`{"id":1,"op":"bootstrap.initialDiscovery"}`,
		`{"id":2,"op":"bootstrap.createIdentity","seed":"root"}`,
		`{"id":3,"op":"bootstrap.loadFirstPlugin","identity":{"domain":"acme","id":"root","instance":"root-1"}}`,
		`{"id":4,"op":"discovery.find"}`,
	)
	if ok, _ := h.result(t, 0)["ok"].(bool); !ok {
		t.Fatalf("initialDiscovery = %v", h.result(t, 0))
	}
	seedIdentity := h.result(t, 1)
	if identityOf(t, seedIdentity) == "" {
		t.Fatalf("bootstrap.createIdentity returned %v", seedIdentity)
	}
	loaded := h.result(t, 2)
	if lifecycle, _ := loaded["lifecycle"].(string); lifecycle != "INACTIVE" {
		t.Fatalf("a loaded plugin MUST start INACTIVE (§7.1): %v", loaded)
	}
	found, _ := h.responses()[3]["result"].([]any)
	if len(found) != 1 {
		t.Fatalf("the loaded plugin MUST be discoverable: %v", found)
	}
}

func TestErrorsUseOnlyFrozenCodes(t *testing.T) {
	// Every failure the protocol can produce is one of §16's thirteen codes.
	// This pins the driver's own two (EAPP_UNSUPPORTED, EAPP_INTERNAL) and a
	// sample of the Core's, and rejects anything else.
	allowed := map[string]bool{
		"EAPP_IDENTITY_INVALID": true, "EAPP_IDENTITY_DUPLICATE": true,
		"EAPP_CAPABILITY_NOT_FOUND": true, "EAPP_CAPABILITY_NOT_EXPOSED": true,
		"EAPP_PLUGIN_NOT_FOUND": true, "EAPP_PLUGIN_INACTIVE": true,
		"EAPP_BINDING_INVALID": true, "EAPP_BINDING_DUPLICATE": true,
		"EAPP_BINDING_CLOSED": true, "EAPP_LIFECYCLE_INVALID": true,
		"EAPP_DISCOVERY_SCOPE_INVALID": true, "EAPP_UNSUPPORTED": true,
		"EAPP_INTERNAL": true,
	}
	h := run(t,
		`{"id":1,"op":"nonsense"}`,
		`{"id":2,"op":"plugin.get","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":3,"op":"lifecycle.activate","identity":{"domain":"acme","id":"a","instance":"a-1"}}`,
		`{"id":4,"op":"composition.bind","from":{"domain":"acme","id":"a","instance":"a-1"},"to":{"domain":"acme","id":"b","instance":"b-1"},"capability":{"name":"c","version":"1.0.0"}}`,
		`{"id":5,"op":"discovery.find","scope":{"trustLevel":"L9"}}`,
		`{"id":6,"op":"composition.bindingState","binding":"nope"}`,
		`{"id":7,"op":"identity.create","identity":{"domain":"","id":"a","instance":"a-1"}}`,
		`{"id":8,"op":"plugin.register","identity":{"domain":"acme","id":"a","instance":"a-1"},"capabilities":[{"name":"x","version":"nope"}]}`,
	)
	for i := 0; i < 8; i++ {
		code := h.errorCode(t, i)
		if !allowed[code] {
			t.Fatalf("response %d used code %s, which §16 does not define", i+1, code)
		}
	}
}

func TestLegacyFlatIdentityCreateIsNotSilentlyAccepted(t *testing.T) {
	// The protocol moved `identity.create` from flat domain/id/instance fields to
	// an `identity` object. The old form MUST fail loudly rather than quietly
	// minting something: a harness that used the old shape has to see it break.
	h := run(t, `{"id":1,"op":"identity.create","domain":"acme","id2":"a","instance":"a-1"}`)
	if code := h.errorCode(t, 0); code != "EAPP_IDENTITY_INVALID" {
		t.Fatalf("flat fields returned %s, want EAPP_IDENTITY_INVALID", code)
	}
}
