// Command eapp-driver exposes the Go implementation of the EaPP v3.0.0
// Composition Core over the conformance driver protocol: one JSON object per
// line on stdin, one JSON response (or event) per line on stdout.
//
// The protocol is specified in conformance/driver.md, which is explicitly
// non-normative — it describes how an implementation is *inspected*, not what
// EaPP means. The rules it does impose on a driver are:
//
//   - exactly one hello line before anything else;
//   - exactly one response per request, echoing the request's `id`;
//   - an unknown op returns EAPP_UNSUPPORTED rather than crashing or succeeding
//     silently;
//   - error codes are the §16 strings and `message` is never parsed;
//   - events carry no `id`, so they may appear at any point.
//
// The driver is a thin adapter: every semantic decision lives in package eapp.
// Its only jobs are decoding, dispatch and framing.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"

	"eapp/eapp"
)

// driverName and eappVersion are reported in the hello line. `layers` lists only
// `core`: this driver implements neither the Interaction nor the State layer,
// and claiming a layer it does not cover would make the harness run checks that
// cannot pass.
const (
	driverName  = "eapp-go"
	eappVersion = "3.0.0"
)

// request is one inbound line.
//
// `id` is json.RawMessage rather than an int so that it is echoed back byte for
// byte: the harness allocates it, and a driver that parsed `1` and re-emitted it
// differently would break the pairing the harness relies on.
//
// Every operation-specific parameter travels under its own key — `identity` /
// `capability` / `criteria` / `scope` / `from` / `to` / `binding` / `watch` /
// `seed` / `capabilities` — and never in the envelope's own `id`. In particular
// `identity.create` takes an `identity` OBJECT, not flat `domain`/`id`/`instance`
// fields, precisely because flat fields would collide with the correlation `id`.
type request struct {
	// ID is excluded from ordinary decoding: it is recovered on its own (see
	// recoverID) so that a failure to decode an operation argument can still be
	// answered with the id the harness is waiting to pair it with.
	ID           json.RawMessage   `json:"-"`
	Op           string            `json:"op"`
	Identity     *eapp.Identity    `json:"identity"`
	Capability   *capabilityArg    `json:"capability"`
	Criteria     *eapp.Criteria    `json:"criteria"`
	Scope        *scopeArg         `json:"scope"`
	From         *eapp.Identity    `json:"from"`
	To           *eapp.Identity    `json:"to"`
	Binding      *string           `json:"binding"`
	Watch        *int64            `json:"watch"`
	Seed         *json.RawMessage  `json:"seed"`
	Capabilities []eapp.Capability `json:"capabilities"`
}

// capabilityArg decodes a CapabilityRef.
//
// A dedicated type (rather than eapp.CapabilityRef) is needed because the wire
// form has no `plugin` member: §4.4's CapabilityRef does carry `plugin`, but the
// driver protocol leaves it implicit in the bind request's `from`. Bind stamps it
// (B-7), so the driver must not accept one and must not invent one.
type capabilityArg struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// toRef converts the wire form into the Core type. Plugin stays zero; Bind
// stamps it from `from`.
func (c *capabilityArg) toRef() eapp.CapabilityRef {
	if c == nil {
		return eapp.CapabilityRef{}
	}
	return eapp.CapabilityRef{Name: c.Name, Version: c.Version}
}

// scopeArg decodes a DiscoveryScope.
//
// TrustLevel is kept as a plain string and validated by the Core, so that an
// unknown level produces EAPP_DISCOVERY_SCOPE_INVALID from one place instead of
// being silently dropped by a decoder-side enum.
type scopeArg struct {
	TrustLevel  string `json:"trustLevel"`
	TrustDomain string `json:"trustDomain"`
}

func (s *scopeArg) toScope() eapp.DiscoveryScope {
	if s == nil {
		return eapp.DiscoveryScope{}
	}
	return eapp.DiscoveryScope{TrustLevel: s.TrustLevel, TrustDomain: s.TrustDomain}
}

// response is one outbound line for a request.
type response struct {
	ID     json.RawMessage `json:"id"`
	OK     bool            `json:"ok"`
	Result any             `json:"result,omitempty"`
	Error  *responseError  `json:"error,omitempty"`
}

// responseError is the §16 error shape. `code` is the only member a harness may
// read; `message` is prose for a human and MUST NOT be parsed.
type responseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// eventEnvelope is one outbound discovery event. It has no `id` member, which is
// what tells the harness it is an event rather than a response.
type eventEnvelope struct {
	Event  string        `json:"event"`
	Watch  int64         `json:"watch"`
	Type   string        `json:"type"`
	Plugin eapp.Identity `json:"plugin"`
}

// pluginResult is the wire shape of Plugin, and the result of `plugin.get`.
type pluginResult struct {
	Identity     eapp.Identity       `json:"identity"`
	Capabilities []eapp.Capability   `json:"capabilities"`
	Lifecycle    eapp.LifecycleState `json:"lifecycle"`
}

// bindingResult is the wire shape of Binding (§conformance/driver.md): exactly
// {id, from, to, capability}. The Core's Binding already encodes that shape, so
// this conversion exists to state the contract and to keep the
// `capability.plugin` member (json:"-") out of the payload.
type bindingResult struct {
	ID         string             `json:"id"`
	From       eapp.Identity      `json:"from"`
	To         eapp.Identity      `json:"to"`
	Capability eapp.CapabilityRef `json:"capability"`
	Contract   *eapp.ContractRef  `json:"contract,omitempty"`
}

func toBindingResult(binding eapp.Binding) bindingResult {
	return bindingResult{
		ID:         binding.ID,
		From:       binding.From,
		To:         binding.To,
		Capability: binding.Capability,
		Contract:   binding.Contract,
	}
}

// encoder is a line-oriented, mutex-guarded JSON writer.
//
// The mutex is not decoration: discovery events are written from per-watcher
// goroutines while responses are written by the main loop. Without it two
// goroutines can interleave two JSON objects on one line and the harness loses
// the stream. Every write is also flushed immediately — the protocol is
// interactive, so a response the harness is waiting for that sits in a buffer is
// indistinguishable from a hang.
type encoder struct {
	mu      sync.Mutex
	out     *bufio.Writer
	encoder *json.Encoder
}

func newEncoder(w io.Writer) *encoder {
	buffered := bufio.NewWriter(w)
	jsonEncoder := json.NewEncoder(buffered)
	// json.Encoder appends '\n' after every value, which is exactly the framing
	// the protocol asks for. HTML escaping is disabled so that identity or
	// capability names containing <, > or & survive verbatim.
	jsonEncoder.SetEscapeHTML(false)
	return &encoder{out: buffered, encoder: jsonEncoder}
}

// write emits one JSON value followed by a newline, and flushes it.
func (e *encoder) write(value any) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.encoder.Encode(value); err != nil {
		return err
	}
	return e.out.Flush()
}

// driver holds the wiring state: the Core, the bootstrap, and the live watchers
// whose events are still being reported.
type driver struct {
	core      *eapp.Core
	bootstrap *eapp.Bootstrapper
	encoder   *encoder

	mu       sync.Mutex
	watchers map[int64]<-chan eapp.DiscoveryEvent
}

func newDriver(out io.Writer) *driver {
	core := eapp.NewCore()
	return &driver{
		core:      core,
		bootstrap: eapp.NewBootstrapper(core),
		encoder:   newEncoder(out),
		watchers:  make(map[int64]<-chan eapp.DiscoveryEvent),
	}
}

// run reads requests until stdin ends, answering each one.
func (d *driver) run(in io.Reader) error {
	// The hello line comes first, unconditionally: the harness waits for it and
	// sends nothing before it arrives.
	if err := d.encoder.write(map[string]any{
		"hello":       true,
		"driver":      driverName,
		"layers":      []string{"core"},
		"eappVersion": eappVersion,
	}); err != nil {
		return fmt.Errorf("writing hello line: %w", err)
	}

	reader := bufio.NewReader(in)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if handleErr := d.handleLine(line); handleErr != nil {
				return handleErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("reading request: %w", err)
		}
	}
}

// handleLine answers exactly one line.
//
// It returns an error only when the protocol cannot be honoured — that is, when
// the request carries no `id` the driver could echo. Emitting a response with a
// null id would be worse than stopping: the harness pairs replies by id, so an
// unpaired frame is a protocol violation that aborts the whole run, whereas a
// driver that exits with a diagnostic on stderr says exactly what went wrong.
// Every other failure, including a malformed request body and a failed
// operation, is a normal response.
func (d *driver) handleLine(line []byte) error {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		// A blank line is not a request, so it gets no response. The protocol
		// says one request produces exactly one response; it does not say every
		// input line is a request.
		return nil
	}

	// Recover the id first, in its own decode.
	//
	// A single Decode into the request struct would abort on the first bad
	// member — a malformed Identity, say — and leave the id unrecoverable, so
	// the failure could only be reported with no id at all. Because the id
	// member is decoded before the arguments that can fail, splitting the decode
	// makes the id available to the error path, which is what lets a rejected
	// argument still get a properly paired response.
	id, err := recoverID(trimmed)
	if err != nil {
		return fmt.Errorf("request carries no usable id: %w", err)
	}

	envelope, decodeErr := decodeRequest(trimmed, id)
	if decodeErr != nil {
		d.flushEvents()
		d.writeErrorFrom(id, decodeErr)
		return nil
	}

	result, opErr := d.dispatch(&envelope)

	// Discovery events are delivered here, synchronously, before the response.
	//
	// This is the whole reason there is no event goroutine. A goroutine that
	// forwarded events as they were produced would lose any event whose watcher
	// was unwatched before the scheduler ran it — and a harness that watches,
	// registers, and unwatches in three consecutive requests would see nothing
	// at all. Draining the watchers' channels at the request boundary makes
	// delivery deterministic: events produced by request N are written before
	// request N's response, so a harness that reads until it sees the response
	// has necessarily seen the events that response accounts for.
	//
	// Ordering is therefore: events first, then exactly one response. The
	// protocol permits this explicitly — events carry no `id` and may appear at
	// any point, and the harness pairs responses by `id` rather than position.
	d.flushEvents()

	if opErr != nil {
		d.writeErrorFrom(envelope.ID, opErr)
		return nil
	}
	if err := d.encoder.write(response{ID: envelope.ID, OK: true, Result: result}); err != nil {
		fmt.Fprintf(os.Stderr, "eapp-driver: writing response: %v\n", err)
	}
	return nil
}

// recoverID extracts the request's `id` member on its own.
//
// A member that is absent, or that is not a single valid JSON value, has no
// answer to pair a response with, so it is returned as an error rather than
// guessed at.
func recoverID(line []byte) (json.RawMessage, error) {
	var environment struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(line, &environment); err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(environment.ID)) == 0 {
		return nil, errors.New("no id member")
	}
	return environment.ID, nil
}

// decodeRequest decodes a request body, reporting the first member that fails to
// decode as an error while keeping the recovered id in the returned request.
//
// The returned request is usable even when the error is non-nil: its ID is the
// one recovered in phase one, so the caller can pair the error response. A
// decode error raised by a nested type is already an *eapp.Error (a malformed
// Identity carries EAPP_IDENTITY_INVALID) and keeps its code; the caller maps
// anything else to EAPP_INTERNAL.
func decodeRequest(line []byte, id json.RawMessage) (request, error) {
	var message request
	decoder := json.NewDecoder(bytes.NewReader(line))
	decodeErr := decoder.Decode(&message)
	// Assign the recovered id whether or not an argument failed, so the caller
	// can pair its error response with the request that caused it.
	message.ID = id
	return message, decodeErr
}

// writeError emits a failure response.
func (d *driver) writeError(id json.RawMessage, code, message string) {
	if err := d.encoder.write(response{ID: id, OK: false, Error: &responseError{Code: code, Message: message}}); err != nil {
		fmt.Fprintf(os.Stderr, "eapp-driver: writing error response: %v\n", err)
	}
}

// writeErrorFrom maps an error from the Core onto the §16 error shape.
//
// Only the code is carried across; the message is the Core's own prose (it may
// name the ending invariant, which is useful to a human reading a failure). An
// error that is not an *eapp.Error becomes EAPP_INTERNAL, because inventing one
// of the semantic codes for a driver bug would misattribute it.
func (d *driver) writeErrorFrom(id json.RawMessage, err error) {
	code, ok := eapp.CodeOf(err)
	if !ok {
		d.writeError(id, eapp.CodeInternal, err.Error())
		return
	}
	d.writeError(id, code, err.Error())
}

// dispatch routes one request. Every branch returns exactly one result.
func (d *driver) dispatch(envelope *request) (any, error) {
	switch envelope.Op {
	// -- lifecycle and identity ---------------------------------------------
	case "reset":
		d.reset()
		return map[string]any{}, nil

	case "identity.create":
		// The operation takes an identity OBJECT, not flat domain/id/instance
		// fields. The Core mints the instance when it is omitted (ID-3, ID-5).
		spec := identityArg(envelope)
		identity, err := d.core.CreateIdentity(spec.Domain, spec.ID, spec.Instance)
		if err != nil {
			return nil, err
		}
		return identity, nil

	case "identity.has":
		return map[string]any{"has": d.core.HasIdentity(identityArg(envelope))}, nil

	case "plugin.register":
		plugin, err := d.core.Register(identityArg(envelope), envelope.Capabilities)
		if err != nil {
			return nil, err
		}
		// The *minted* identity is authoritative (ID-5), so that is what the
		// caller gets back — not the identity it may have proposed.
		return plugin.Identity, nil

	case "plugin.get":
		plugin, err := d.core.PluginOf(identityArg(envelope))
		if err != nil {
			return nil, err
		}
		return pluginToResult(plugin), nil

	case "plugin.list":
		plugins := d.core.Plugins()
		out := make([]pluginResult, 0, len(plugins))
		for _, plugin := range plugins {
			out = append(out, pluginToResult(plugin))
		}
		return out, nil

	case "lifecycle.activate":
		return d.lifecycleResult("activate", identityArg(envelope))

	case "lifecycle.deactivate":
		return d.lifecycleResult("deactivate", identityArg(envelope))

	case "lifecycle.suspend":
		return d.lifecycleResult("suspend", identityArg(envelope))

	case "lifecycle.resume":
		return d.lifecycleResult("resume", identityArg(envelope))

	// -- discovery ----------------------------------------------------------
	case "discovery.find":
		found, err := d.core.Find(criteriaArg(envelope), envelope.Scope.toScope())
		if err != nil {
			return nil, err
		}
		// `[]` and `null` are different answers to a harness; an empty result is
		// a list of zero identities.
		if found == nil {
			found = []eapp.Identity{}
		}
		return found, nil

	case "discovery.watch":
		watchID, events, err := d.core.Watch(criteriaArg(envelope), envelope.Scope.toScope())
		if err != nil {
			return nil, err
		}
		d.remember(watchID, events)
		return map[string]any{"watch": watchID}, nil

	case "discovery.unwatch":
		if envelope.Watch == nil {
			return nil, eapp.InvalidBinding("discovery.unwatch requires a `watch` id")
		}
		// The Core closes the channel; the channel stays in the watcher list so
		// that the flush in handleLine still writes whatever was already queued
		// before it sees the close and drops the entry itself.
		d.core.Unwatch(*envelope.Watch)
		return map[string]any{}, nil

	// -- composition --------------------------------------------------------
	case "composition.bind":
		if envelope.From == nil || envelope.To == nil {
			return nil, eapp.InvalidBinding("composition.bind requires `from` and `to` identities (B-1)")
		}
		binding, err := d.core.Bind(eapp.BindRequest{
			From:       *envelope.From,
			To:         *envelope.To,
			Capability: envelope.Capability.toRef(),
		})
		if err != nil {
			return nil, err
		}
		return toBindingResult(binding), nil

	case "composition.unbind":
		if envelope.Binding == nil {
			return nil, eapp.InvalidBinding("composition.unbind requires a `binding` id")
		}
		// O-4 makes this idempotent, so a second unbind of the same handle is a
		// success. The driver adds nothing on top of that.
		if err := d.core.Unbind(*envelope.Binding); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "composition.binding":
		if envelope.Binding == nil {
			return nil, eapp.InvalidBinding("composition.binding requires a `binding` id")
		}
		binding, err := d.core.Binding(*envelope.Binding)
		if err != nil {
			return nil, err
		}
		return toBindingResult(binding), nil

	case "composition.bindingState":
		if envelope.Binding == nil {
			return nil, eapp.InvalidBinding("composition.bindingState requires a `binding` id")
		}
		state, err := d.core.BindingState(*envelope.Binding)
		if err != nil {
			return nil, err
		}
		return map[string]any{"state": string(state)}, nil

	case "composition.bindings":
		bindings := d.core.Bindings()
		out := make([]bindingResult, 0, len(bindings))
		for _, binding := range bindings {
			out = append(out, toBindingResult(binding))
		}
		return out, nil

	// -- bootstrap ----------------------------------------------------------
	case "bootstrap.createIdentity":
		var seed any
		if envelope.Seed != nil {
			if err := json.Unmarshal(*envelope.Seed, &seed); err != nil {
				return nil, eapp.InvalidIdentity("bootstrap.createIdentity: seed is not valid JSON: %v", err)
			}
		}
		identity, err := d.bootstrap.CreateIdentity(seed)
		if err != nil {
			return nil, err
		}
		return identity, nil

	case "bootstrap.loadFirstPlugin":
		plugin, err := d.bootstrap.LoadFirstPlugin(identityArg(envelope))
		if err != nil {
			return nil, err
		}
		return pluginToResult(plugin), nil

	case "bootstrap.initialDiscovery":
		// BR-3: the bootstrap provides at least one initial Discovery. The
		// driver proves it exists and answers, which is the part a harness can
		// check from outside; BR-1 and BR-2 are not observable through this
		// protocol and the driver does not pretend otherwise.
		discovery := d.bootstrap.InitialDiscovery()
		if discovery == nil {
			return nil, eapp.Internal("bootstrap MUST provide an initial Discovery (BR-3)")
		}
		if _, err := discovery.Find(eapp.Criteria{}, eapp.DiscoveryScope{}); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil

	default:
		// Required by the protocol: an unknown op is EAPP_UNSUPPORTED. It must
		// not crash and must not succeed silently, so this is the only place
		// that produces EAPP_UNSUPPORTED for a request.
		//
		// An empty op lands here too, and that is correct: "" is not an
		// operation this driver has.
		return nil, eapp.Unsupported("unsupported op %q", envelope.Op)
	}
}

// identityArg returns the request's identity argument, or a zero Identity when
// it is absent.
//
// A missing argument is not turned into an error here: the Core already rejects
// an incomplete identity with EAPP_IDENTITY_INVALID (ID-1…ID-3), which is the
// code the protocol expects, and reporting it from one place keeps the code
// consistent across operations.
func identityArg(envelope *request) eapp.Identity {
	if envelope.Identity == nil {
		return eapp.Identity{}
	}
	return *envelope.Identity
}

// criteriaArg applies §8.1's "everything is optional": an absent criteria object
// means "match all".
func criteriaArg(envelope *request) eapp.Criteria {
	if envelope.Criteria == nil {
		return eapp.Criteria{}
	}
	return *envelope.Criteria
}

// pluginToResult renders a Plugin for the wire.
//
// A nil capability slice is rendered as `[]`, never `null`: P-2 makes an empty
// set legal, and null reads as "the set was not reported".
func pluginToResult(plugin eapp.Plugin) pluginResult {
	capabilities := plugin.Capabilities
	if capabilities == nil {
		capabilities = []eapp.Capability{}
	}
	return pluginResult{
		Identity:     plugin.Identity,
		Capabilities: capabilities,
		Lifecycle:    plugin.Lifecycle,
	}
}

// lifecycleResult runs one lifecycle primitive and renders its §7.3 answer.
//
// O-5 makes `activate` idempotent, so the answer reports the state the operation
// *produced*, which for an already-ACTIVE plugin is the unchanged ACTIVE. The
// transition rules themselves live in the Core, so a SUSPENDED plugin still gets
// EAPP_LIFECYCLE_INVALID from `activate` (L-6) and the driver adds no opinion.
func (d *driver) lifecycleResult(op string, identity eapp.Identity) (any, error) {
	var err error
	switch op {
	case "activate":
		err = d.core.Activate(identity)
	case "deactivate":
		err = d.core.Deactivate(identity)
	case "suspend":
		err = d.core.Suspend(identity)
	case "resume":
		err = d.core.Resume(identity)
	default:
		return nil, eapp.Unsupported("unknown lifecycle op %q", op)
	}
	if err != nil {
		return nil, err
	}

	plugin, err := d.core.PluginOf(identity)
	if err != nil {
		return nil, err
	}
	return map[string]any{"lifecycle": string(plugin.Lifecycle)}, nil
}

// reset clears the Core and drops the watchers that no longer exist.
//
// `reset` is not a composition primitive (§9 defines eight, and it is none of
// them); it exists so a harness can get a clean slate from a long-lived driver
// process without restarting it. Dropping the watch channels is part of that:
// they belong to the graph that was just cleared.
func (d *driver) reset() {
	d.mu.Lock()
	d.watchers = make(map[int64]<-chan eapp.DiscoveryEvent)
	d.mu.Unlock()
	d.core.Reset()
}

// remember registers a live watcher's channel.
func (d *driver) remember(watchID int64, events <-chan eapp.DiscoveryEvent) {
	d.mu.Lock()
	d.watchers[watchID] = events
	d.mu.Unlock()
}

// forget drops a watcher's channel.
func (d *driver) forget(watchID int64) {
	d.mu.Lock()
	delete(d.watchers, watchID)
	d.mu.Unlock()
}

// flushEvents writes every discovery event the Core has produced since the last
// flush, oldest watcher first.
//
// Delivery is pulled at the request boundary rather than pushed from a
// goroutine, and that choice is load-bearing. A goroutine forwarding events as
// they arrived would race the request loop: a harness that watches, registers,
// and unwatches in three consecutive requests can have its watcher closed before
// the goroutine is ever scheduled, and the event would vanish with no trace.
// Draining here makes the ordering explicit — everything request N caused is
// written before request N's response — so a harness that reads until it sees
// the response cannot miss the events that response accounts for.
//
// The Core's per-watcher buffer is bounded and its own delivery is non-blocking
// (see eapp's emitLocked), so this cannot block on a stalled reader; it picks up
// whatever has queued and leaves the rest for the next boundary.
func (d *driver) flushEvents() {
	d.mu.Lock()
	pending := make([]struct {
		id     int64
		events <-chan eapp.DiscoveryEvent
	}, 0, len(d.watchers))
	for id, events := range d.watchers {
		pending = append(pending, struct {
			id     int64
			events <-chan eapp.DiscoveryEvent
		}{id: id, events: events})
	}
	d.mu.Unlock()

	// Watcher ids are minted in order, so sorting them makes the output stable
	// when several watchers match the same mutation.
	sort.Slice(pending, func(i, j int) bool { return pending[i].id < pending[j].id })

	for _, watcher := range pending {
		for {
			select {
			case event, ok := <-watcher.events:
				if !ok {
					// The Core closed the channel (unwatch or reset), which is
					// also what tells us to stop watching it here.
					d.forget(watcher.id)
					goto nextWatcher
				}
				// Write failures are dropped rather than fatal: a closed stdout
				// is the harness going away, and the main loop notices on its own.
				_ = d.encoder.write(eventEnvelope{
					Event:  "discovery",
					Watch:  watcher.id,
					Type:   string(event.Type),
					Plugin: event.Plugin,
				})
			default:
				goto nextWatcher
			}
		}
	nextWatcher:
	}
}

// main wires stdin/stdout and runs the loop.
func main() {
	d := newDriver(os.Stdout)
	// Diagnostics go to stderr, which the harness displays but does not parse:
	// stdout carries the protocol and nothing else.
	if err := d.run(os.Stdin); err != nil {
		fmt.Fprintf(os.Stderr, "eapp-driver: %v\n", err)
		os.Exit(1)
	}
}
