// Command eapp-driver exposes the Go implementation of the EaPP v3.1
// Composition Core and Interaction Layer over the conformance driver protocol:
// one JSON object per line on stdin, one JSON response (or event) per line on
// stdout.
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
	"time"

	"eapp/eapp"
)

// driverName, eappVersion and layers are reported in the hello line.
//
// `layers` lists `core` and `interaction`, and nothing else: this driver
// implements v3.0's Composition Core and v3.1's Interaction Layer, but not
// v3.2's State layer, and claiming a layer it does not cover would make the
// harness run checks that cannot pass. Note that a state *Channel* is creatable
// here — `state` is one of v3.1 §3's four modes, and CC-4/CC-5 name it — while
// the StateChannel runtime that v3.2 builds on top of it is not implemented.
//
// The version reported is the protocol version the driver covers (CHANGELOG's
// version index): a two-layer implementation reports 3.3.0, which is the version
// at which C-7 was added to the Core this driver implements.
const (
	driverName  = "eapp-go"
	eappVersion = "3.3.0"
)

// request is one inbound line.
//
// `id` is json.RawMessage rather than an int so that it is echoed back byte for
// byte: the harness allocates it, and a driver that parsed `1` and re-emitted it
// differently would break the pairing the harness relies on.
//
// Every operation-specific parameter travels under its own key — `identity` /
// `capability` / `criteria` / `scope` / `from` / `to` / `binding` / `watch` /
// `seed` / `capabilities`, and the interaction layer's `channel` / `mode` /
// `options` / `subscription` / `delivery` / `cursor` / `pattern` / `payload` —
// and never in the envelope's own `id`. In particular `identity.create` takes an
// `identity` OBJECT, not flat `domain`/`id`/`instance` fields, precisely because
// flat fields would collide with the correlation `id`.
//
// Two of those keys carry different types depending on the operation, and neither
// is decoded into a Go type here because of it: `delivery` is a
// DeliveryGuarantee for `channel.create` and an opaque token for
// `subscription.ack` / `subscription.nack` (conformance/driver.md models an
// AckContext as a token precisely because it cannot cross a process boundary),
// and `cursor` is a CursorAnchor for `subscription.open` and a Cursor for
// `transport.readAfter`. Both are kept as raw JSON and interpreted by the
// operation that receives them.
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

	// -- interaction ---------------------------------------------------------
	Channel      *string         `json:"channel"`
	Mode         *string         `json:"mode"`
	Delivery     json.RawMessage `json:"delivery"`
	Options      *optionsArg     `json:"options"`
	Subscription *string         `json:"subscription"`
	TimeoutMs    *float64        `json:"timeoutMs"`
	Group        *string         `json:"group"`
	Name         *string         `json:"name"`
	ClaimTtlMs   *float64        `json:"claimTtlMs"`
	Cursor       json.RawMessage `json:"cursor"`
	Pattern      json.RawMessage `json:"pattern"`
	Payload      json.RawMessage `json:"payload"`
}

// optionsArg decodes `subscription.open`'s options (§7.1).
//
// The mode is kept as a plain string and validated by the layer, so that one
// place decides what EAPP_SUBSCRIPTION_INVALID means. `cursor` stays raw for the
// reason given above, and its absence is distinguishable from a cursor: an empty
// anchor means the caller named none, which for a group member is not the same as
// naming 'latest'.
type optionsArg struct {
	Mode   string          `json:"mode"`
	Group  string          `json:"group"`
	Cursor json.RawMessage `json:"cursor"`
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

// driver holds the wiring state: the Core, the Interaction Layer, the bootstrap,
// and the live watchers and subscriptions whose handles the harness holds.
type driver struct {
	core        *eapp.Core
	interaction *eapp.Interaction
	bootstrap   *eapp.Bootstrapper
	encoder     *encoder

	mu            sync.Mutex
	watchers      map[int64]<-chan eapp.DiscoveryEvent
	subscriptions map[string]*eapp.Subscription
}

func newDriver(out io.Writer) *driver {
	core := eapp.NewCore()
	return &driver{
		core:          core,
		interaction:   eapp.NewInteraction(core),
		bootstrap:     eapp.NewBootstrapper(core),
		encoder:       newEncoder(out),
		watchers:      make(map[int64]<-chan eapp.DiscoveryEvent),
		subscriptions: make(map[string]*eapp.Subscription),
	}
}

// run reads requests until stdin ends, answering each one.
func (d *driver) run(in io.Reader) error {
	// The hello line comes first, unconditionally: the harness waits for it and
	// sends nothing before it arrives.
	if err := d.encoder.write(map[string]any{
		"hello":       true,
		"driver":      driverName,
		"layers":      []string{"core", "interaction"},
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
		// §11's downward edge is wired here, at the one place in this driver
		// where a Binding reaches CLOSED. The Interaction Layer derives the same
		// answer on its own (CC-2 is satisfied by the derivation), so this is not
		// what makes the state correct — it is what makes the *teardown* happen
		// at the instant the Binding closed rather than at the next read: the
		// Subscriptions and ConsumerGroups of the derived Channels are
		// terminated here.
		closed, err := d.core.Binding(*envelope.Binding)
		if err != nil {
			return nil, err
		}
		// O-4 makes this idempotent, so a second unbind of the same handle is a
		// success. The driver adds nothing on top of that.
		if err := d.core.Unbind(*envelope.Binding); err != nil {
			return nil, err
		}
		d.interaction.OnBindingClosed(closed)
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

	// -- interaction: channel and messages (v3.1 §2, §10, §12) ----------------
	case "channel.create":
		if envelope.Binding == nil {
			return nil, eapp.InvalidBinding(
				"channel.create requires a `binding` id (CC-6, CC-7)")
		}
		// The mode travels as text and is validated in the layer, so CC-3's
		// EAPP_MODE_INVALID comes from one place. An absent mode is the empty
		// string, which is not one of §3's four and is refused there.
		mode := eapp.ChannelMode("")
		if envelope.Mode != nil {
			mode = eapp.ChannelMode(*envelope.Mode)
		}
		// An omitted delivery means "derive it" (CC-4), so the empty guarantee is
		// passed through rather than defaulted here.
		delivery, err := envelope.deliveryGuarantee()
		if err != nil {
			return nil, err
		}
		return d.interaction.CreateChannel(eapp.CreateChannelRequest{
			Binding:  *envelope.Binding,
			Mode:     mode,
			Delivery: delivery,
		})

	case "channel.connect":
		channelID, err := requireChannelArg(envelope, "channel.connect")
		if err != nil {
			return nil, err
		}
		return d.interaction.ConnectChannel(channelID)

	case "channel.get":
		channelID, err := requireChannelArg(envelope, "channel.get")
		if err != nil {
			return nil, err
		}
		return d.interaction.Channel(channelID)

	case "channel.channels":
		return d.interaction.Channels(), nil

	case "channel.send":
		channelID, err := requireChannelArg(envelope, "channel.send")
		if err != nil {
			return nil, err
		}
		cursor, err := d.interaction.Send(channelID, envelope.payload())
		if err != nil {
			return nil, err
		}
		return map[string]any{"cursor": cursor}, nil

	case "channel.close":
		channelID, err := requireChannelArg(envelope, "channel.close")
		if err != nil {
			return nil, err
		}
		if err := d.interaction.CloseChannel(channelID); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	// -- interaction: subscriptions (v3.1 §7, §9) ----------------------------
	case "subscription.open":
		channelID, err := requireChannelArg(envelope, "subscription.open")
		if err != nil {
			return nil, err
		}
		subscription, err := d.interaction.OpenSubscription(channelID, envelope.subscriptionOptions())
		if err != nil {
			return nil, err
		}
		d.rememberSubscription(subscription)
		return map[string]any{
			"subscription": subscription.ID(),
			"cursor":       subscription.Cursor(),
			"mode":         string(subscription.Mode()),
			"state":        string(subscription.State()),
		}, nil

	case "subscription.pull":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		// `timeoutMs` is accepted and not waited on. The driver answers one
		// request at a time over stdio, so nothing can arrive while a pull waits:
		// blocking for the timeout would change nothing observable and would make
		// every empty poll cost its full timeout. The two outcomes the protocol
		// distinguishes are still distinguished — nothing available is
		// `item: null` with `done: false`, termination is `done: true` — and
		// TR-7's rule holds one layer down ("无匹配 MUST NOT 阻塞").
		item, done, err := subscription.Next()
		if err != nil {
			return nil, err
		}
		if done || item == nil {
			return map[string]any{"item": nil, "done": done}, nil
		}
		return map[string]any{
			"item": map[string]any{
				"delivery": item.Delivery(),
				"cursor":   item.Cursor,
				"payload":  item.Payload,
			},
			"done": false,
		}, nil

	case "subscription.ack":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		token, err := envelope.deliveryToken()
		if err != nil {
			return nil, err
		}
		if err := subscription.Ack(token); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "subscription.nack":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		token, err := envelope.deliveryToken()
		if err != nil {
			return nil, err
		}
		if err := subscription.Nack(token); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "subscription.state":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"state":  string(subscription.State()),
			"cursor": subscription.Cursor(),
		}, nil

	case "subscription.suspend":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		if err := subscription.Suspend(); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "subscription.resume":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		if err := subscription.Resume(); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "subscription.close":
		subscription, err := d.lookupSubscription(envelope)
		if err != nil {
			return nil, err
		}
		if err := subscription.Close(); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	// -- interaction: consumer groups (v3.1 §8) ------------------------------
	case "group.open":
		channelID, err := requireChannelArg(envelope, "group.open")
		if err != nil {
			return nil, err
		}
		if envelope.Name == nil {
			return nil, eapp.InvalidSubscription("group.open requires a `name` (§8.2, CG-1)")
		}
		var claimTTL time.Duration
		if envelope.ClaimTtlMs != nil {
			// §8.2's claimTtlMs is in milliseconds; a negative value is refused by
			// the layer (it MUST be > 0) and an absent one takes the default.
			claimTTL = time.Duration(*envelope.ClaimTtlMs * float64(time.Millisecond))
		}
		return d.interaction.OpenGroup(channelID, *envelope.Name, claimTTL)

	case "group.view":
		if envelope.Group == nil {
			return nil, eapp.InvalidSubscription("group.view requires a `group` id")
		}
		return d.interaction.Group(*envelope.Group)

	case "group.close":
		if envelope.Group == nil {
			return nil, eapp.InvalidSubscription("group.close requires a `group` id")
		}
		if err := d.interaction.CloseGroup(*envelope.Group); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	// -- interaction: transport (v3.1 §10) -----------------------------------
	case "transport.capabilities":
		return d.interaction.Capabilities(), nil

	case "transport.send":
		channelID, err := requireChannelArg(envelope, "transport.send")
		if err != nil {
			return nil, err
		}
		// The same path as `channel.send`: §10.1's `send` is what the layer calls
		// when a Channel carries a message, so exposing it separately must not
		// create a second log.
		cursor, err := d.interaction.Send(channelID, envelope.payload())
		if err != nil {
			return nil, err
		}
		return map[string]any{"cursor": cursor}, nil

	case "transport.readAfter":
		channelID, err := requireChannelArg(envelope, "transport.readAfter")
		if err != nil {
			return nil, err
		}
		pattern, err := envelope.pattern()
		if err != nil {
			return nil, err
		}
		after, err := d.readAfterCursor(envelope, channelID)
		if err != nil {
			return nil, err
		}
		messages, err := d.interaction.ReadAfter(channelID, after, pattern)
		if err != nil {
			return nil, err
		}
		// `[]` and `null` are different answers to a harness: no match is a list
		// of zero messages (TR-7).
		if messages == nil {
			messages = []eapp.TransportMessage{}
		}
		return messages, nil

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

// ---------------------------------------------------------------------------
// Interaction arguments
// ---------------------------------------------------------------------------

// requireChannelArg reads the `channel` parameter every interaction operation but
// `channel.create` and `channel.channels` takes.
//
// A missing parameter is refused with EAPP_CHANNEL_INVALID, which is the code for
// "no such Channel": there is no Channel id to look up, and reporting a success
// would claim one exists.
func requireChannelArg(envelope *request, op string) (string, error) {
	if envelope.Channel == nil {
		return "", eapp.InvalidChannel("%s requires a `channel` id", op)
	}
	return *envelope.Channel, nil
}

// rawText reads a JSON value that may name a string, a bare number, or nothing.
//
// Both `cursor` (an opaque string that a caller may also spell as digits) and
// `delivery` (always a string, but the same parameter key also carries a
// DeliveryGuarantee for another operation) travel this way. A `null` is "absent",
// not "the empty string", because the protocol distinguishes the two for
// `options.cursor` and for `transport.readAfter`'s cursor.
func rawText(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err == nil {
		return text, true
	}
	// Not a JSON string: take the literal, so that a caller that spelled a cursor
	// as a number still named a position rather than nothing at all.
	return string(trimmed), true
}

// deliveryGuarantee reads `channel.create`'s `delivery` (§4).
//
// Omitted stays omitted: the empty guarantee means "derive it from the mode"
// (CC-4), which the layer does. A present but unknown value is passed through as
// text so the layer refuses it with EAPP_DELIVERY_UNSUPPORTED (DL-1, DL-2, DL-6).
func (r *request) deliveryGuarantee() (eapp.DeliveryGuarantee, error) {
	text, present := rawText(r.Delivery)
	if !present {
		return "", nil
	}
	return eapp.DeliveryGuarantee(text), nil
}

// deliveryToken reads `subscription.ack` / `subscription.nack`'s `delivery`.
//
// This is the AckContext's addressable stand-in (conformance/driver.md): the
// context itself is a live object and cannot be sent across a process boundary.
func (r *request) deliveryToken() (string, error) {
	text, present := rawText(r.Delivery)
	if !present {
		return "", eapp.InvalidSubscription(
			"this operation requires the `delivery` token of the item being settled (§9)")
	}
	return text, nil
}

// payload reads a message body.
//
// It is kept as json.RawMessage all the way into the transport and back out
// through `subscription.pull`, so the bytes a caller sent are the bytes it gets
// back. Decoding into `any` here would round-trip every number through a float64
// and quietly change large integers — a corruption that no invariant would catch
// because nothing in EaPP gives a payload a shape.
func (r *request) payload() any {
	trimmed := bytes.TrimSpace(r.Payload)
	if len(trimmed) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(trimmed)
}

// subscriptionOptions reads `subscription.open`'s `options` (§7.1).
//
// An absent options object and an absent `cursor` inside it are both "the caller
// named no anchor", which §7.1's default resolves for an exclusive subscription
// and which means "keep the group's position" for a group member.
func (r *request) subscriptionOptions() eapp.SubscriptionOptions {
	if r.Options == nil {
		return eapp.SubscriptionOptions{}
	}
	options := eapp.SubscriptionOptions{
		Mode:  eapp.SubscriptionMode(r.Options.Mode),
		Group: r.Options.Group,
	}
	if text, present := rawText(r.Options.Cursor); present {
		options.Cursor = eapp.ParseCursorAnchor(text)
	}
	return options
}

// pattern reads `transport.readAfter`'s `pattern` (§10.1).
//
// An absent pattern selects everything, which is the only reading that keeps
// TR-7 true ("no match MUST return an empty array"): a request with no selector
// has not asked for nothing, it has asked for anything.
func (r *request) pattern() (eapp.Pattern, error) {
	trimmed := bytes.TrimSpace(r.Pattern)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return eapp.PatternAll, nil
	}
	var pattern eapp.Pattern
	if err := json.Unmarshal(trimmed, &pattern); err != nil {
		// The layer's Pattern already refuses an unsupported shape with
		// EAPP_UNSUPPORTED (TR-9); anything else here is a malformed pattern and
		// gets the same code, because either way the transport cannot honour it.
		if _, known := eapp.CodeOf(err); known {
			return eapp.Pattern{}, err
		}
		return eapp.Pattern{}, eapp.Unsupported(
			"pattern %s is not a §10.1 pattern (TR-9)", trimmed)
	}
	return pattern, nil
}

// readAfterCursor reads `transport.readAfter`'s `cursor`.
//
// It is a concrete Cursor in the driver protocol, and a nil one means "from the
// earliest retained position" (TR-6). The two literals are also accepted here, so
// that a caller that spells an anchor instead of a position gets the anchor's
// meaning rather than EAPP_CURSOR_INVALID.
func (d *driver) readAfterCursor(envelope *request, channelID string) (*eapp.Cursor, error) {
	text, present := rawText(envelope.Cursor)
	if !present {
		return nil, nil
	}
	anchor := eapp.ParseCursorAnchor(text)
	if anchor.IsEarliest() {
		return nil, nil
	}
	resolved, err := d.interaction.ResolveAnchor(channelID, anchor)
	if err != nil {
		return nil, err
	}
	return &resolved, nil
}

// rememberSubscription records a live subscription handle.
func (d *driver) rememberSubscription(subscription *eapp.Subscription) {
	d.mu.Lock()
	d.subscriptions[subscription.ID()] = subscription
	d.mu.Unlock()
}

// lookupSubscription resolves a `subscription` parameter.
//
// An unknown handle is EAPP_SUBSCRIPTION_INVALID: §7's subscriptions are created
// by `subscription.open` and by nothing else, so a handle this driver does not
// hold names no subscription.
func (d *driver) lookupSubscription(envelope *request) (*eapp.Subscription, error) {
	if envelope.Subscription == nil {
		return nil, eapp.InvalidSubscription("this operation requires a `subscription` id")
	}
	d.mu.Lock()
	subscription, present := d.subscriptions[*envelope.Subscription]
	d.mu.Unlock()
	if !present {
		return nil, eapp.InvalidSubscription(
			"no subscription with id %q", *envelope.Subscription)
	}
	return subscription, nil
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
	d.subscriptions = make(map[string]*eapp.Subscription)
	d.mu.Unlock()
	// The interaction layer is cleared with the Core: every Channel it holds is
	// derived from a Binding the Core is about to forget, so a Channel that
	// survived the reset would be one that exists independently of its Binding
	// (CC-1) with nothing able to say what state it is in.
	d.interaction.Reset()
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
