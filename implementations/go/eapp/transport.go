package eapp

import (
	"encoding/json"
	"sync"
)

// Transport is the mechanism layer of v3.1 §10.1: it carries messages and
// assigns cursors, and it MUST define no interaction semantics of its own
// (TR-1). Everything a Channel, Subscription or ConsumerGroup decides is decided
// above this interface; what a Transport decides is *where* a message lands.
//
// The interface is deliberately small, and in particular it has no notion of
// acknowledgement, delivery guarantee or consumer identity. Those are §4, §5 and
// §8 — if they lived here, a Transport would be free to interpret them, which is
// precisely what TR-1 forbids.
type Transport interface {
	// ID names the transport instance.
	ID() string
	// Capabilities declares what the transport can do (§10.2). TR-2 makes the
	// declaration mandatory, and TR-3 forbids overstating it: a Channel is only
	// allowed to use what is declared here (TR-4).
	Capabilities() TransportCapabilities
	// Send appends one message and returns the cursor the transport assigned to
	// it. The cursor is the transport's business: §10.1 says so in the comment
	// on the method, which is the whole reason `send` returns one.
	Send(channel string, message any) (Cursor, error)
	// ReadAfter returns the messages with a cursor strictly greater than
	// `after`, matching `pattern`, in ascending cursor order (TR-5). A nil
	// `after` means "from the earliest retained position" (TR-6). No match is an
	// empty slice, never an error and never a block (TR-7).
	ReadAfter(channel string, after *Cursor, pattern Pattern) ([]TransportMessage, error)
	// Close releases the transport.
	Close() error
}

// CursorPositions is the optional part of a Transport that §6.2's anchors need.
//
// §6.2 requires 'earliest' and 'latest' to be resolved *eagerly*, at subscription
// creation, and to concrete cursors. A transport that can only be read
// forwards (ReadAfter) cannot answer either question: "the earliest position
// still serviceable" and "the current head" are properties of the log, not of the
// messages. Exposing them here keeps the alternative honest — a transport that
// does not implement this interface makes anchor resolution fail with
// EAPP_CURSOR_UNSUPPORTED (CR-5) instead of silently picking a wrong position.
type CursorPositions interface {
	// Floor is the most recently discarded position; positions at or after it
	// are still readable (§6.2's retention table).
	Floor(channel string) (Cursor, error)
	// Head is the Channel's current head: the position of its last message, or
	// the floor when it has carried none.
	Head(channel string) (Cursor, error)
}

// Resettable is implemented by a transport whose retained log can be cleared.
// The conformance driver's `reset` operation is the only caller.
type Resettable interface {
	Reset()
}

// TransportCapabilities is §10.2's declaration. Every field is a fact about the
// transport, and TR-3 makes an overstated field a conformance failure rather
// than a harmless optimism — a Channel that believes it has replay will serve
// history it does not have.
type TransportCapabilities struct {
	// Persistent reports whether messages survive the process that received
	// them.
	Persistent bool `json:"persistent"`
	// Ordering is 'none', 'per-source' or 'global'. For a cursor-ordered log the
	// answer is 'global': CR-1 requires one order within the Channel, and
	// 'per-source' would only order each sender's messages among themselves.
	Ordering string `json:"ordering"`
	// Delivery declares which guarantees the transport can actually honour.
	Delivery TransportDeliveryCapabilities `json:"delivery"`
	// SupportsCursor reports whether the transport assigns and accepts cursors.
	// Without it, CR-5 requires EAPP_CURSOR_UNSUPPORTED from every operation
	// that needs one.
	SupportsCursor bool `json:"supportsCursor"`
	// SupportsLease reports whether a position can be held temporarily (§5).
	SupportsLease bool `json:"supportsLease"`
	// DurabilityBoundary is the visibility of the persistence boundary:
	// 'process', 'machine', 'cluster' or 'global'.
	DurabilityBoundary string `json:"durabilityBoundary"`
}

// TransportDeliveryCapabilities is the `delivery` member of §10.2.
type TransportDeliveryCapabilities struct {
	AtMostOnce  bool `json:"atMostOnce"`
	AtLeastOnce bool `json:"atLeastOnce"`
	Replay      bool `json:"replay"`
}

// TransportMessage is §10.1's message: a cursor and an opaque payload.
//
// The payload is `any` and this layer never inspects it beyond pattern matching
// — a Transport that understood payloads would be defining interaction semantics
// (TR-1).
type TransportMessage struct {
	Cursor  Cursor `json:"cursor"`
	Payload any    `json:"payload"`
}

// Pattern is §10.1's selection union: everything, or one message type.
type Pattern struct {
	// All selects every message.
	All bool
	// Type selects messages whose type is Type. It is only meaningful when All
	// is false.
	Type string
}

// PatternAll is the pattern that matches everything — §10.1's `{all: true}`.
var PatternAll = Pattern{All: true}

// Match reports whether a message payload satisfies the pattern.
//
// §10.1 defines the two shapes but not how a message's *type* is carried, and a
// transport-level message has no envelope of its own: v3.1 §3.1's EventMessage
// names its type `topic`, while a message that carries a discriminator at all
// most often calls it `type`. Both are accepted. Guessing is confined to this
// function; a payload that names neither matches no type pattern, which is the
// conservative answer (TR-7: no match is an empty result, not an error).
func (p Pattern) Match(payload any) bool {
	if p.All {
		return true
	}
	named := messageType(payload)
	return named != "" && named == p.Type
}

// messageType extracts the type name a payload carries, if any.
func messageType(payload any) string {
	switch value := payload.(type) {
	case string:
		return value
	case map[string]any:
		return typeMember(value)
	case json.RawMessage:
		return typeOfJSON(value)
	case []byte:
		return typeOfJSON(value)
	default:
		return ""
	}
}

// typeMember reads `type` (preferred) or `topic` from a decoded object.
func typeMember(object map[string]any) string {
	for _, key := range []string{"type", "topic"} {
		if text, ok := object[key].(string); ok {
			return text
		}
	}
	return ""
}

// typeOfJSON is typeMember for a payload whose bytes have not been decoded yet.
//
// The driver hands payloads to this layer as json.RawMessage precisely so that
// they are re-emitted byte for byte, and matching a type pattern must not
// destroy that: the payload is decoded into a throwaway map here and the raw
// bytes stay untouched.
func typeOfJSON(raw json.RawMessage) string {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return ""
	}
	return typeMember(object)
}

// UnmarshalJSON decodes §10.1's pattern union.
//
// The shapes are exhaustive: `{all: true}` and `{type: "..."}`. Everything else
// — including `{all: false}`, which names nothing and therefore cannot be
// honoured as a selection — is refused with EAPP_UNSUPPORTED, the code TR-9
// names for "this transport does not support that feature". Accepting an
// uninterpretable pattern as "match nothing" would turn a caller's typo into an
// empty stream.
func (p *Pattern) UnmarshalJSON(data []byte) error {
	var raw struct {
		All  *bool   `json:"all"`
		Type *string `json:"type"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return errPatternUnsupported("%v", err)
	}
	switch {
	case raw.All != nil && *raw.All && raw.Type == nil:
		*p = PatternAll
		return nil
	case raw.Type != nil && *raw.Type != "" && raw.All == nil:
		*p = Pattern{Type: *raw.Type}
		return nil
	default:
		return errPatternUnsupported(
			"pattern MUST be {all: true} or {type: \"…\"} (§10.1); got %s", data)
	}
}

// errPatternUnsupported is EAPP_UNSUPPORTED for a pattern shape this transport
// has no way to honour (TR-9).
func errPatternUnsupported(format string, args ...any) *Error {
	return newError(CodeUnsupported, format, args...)
}

// MemoryTransport is the process-local transport of §10.3's Memory row:
// not persistent, globally ordered, at-least-once capable, no replay, cursor and
// lease capable, durability boundary 'process'.
//
// It is the transport every Channel in this package runs on unless a caller
// installs another, and it is the one the conformance driver exposes. It is
// honest about the row it claims: `persistent: false` and `replay: false` are
// the two fields that say "a restart loses the log", which is true here.
type MemoryTransport struct {
	mu sync.Mutex
	// streams holds one append-only log per channel, keyed by the channel's id.
	// The memory transport keys on the *channel* rather than on a free-form
	// name, because §10.1's `send(channel, msg)` is called by this layer with a
	// ChannelRef id (CH-1).
	streams map[string]*memoryStream
}

// memoryStream is one channel's log.
//
// Nothing is ever discarded, so `floor` is always ZeroCursor and `next` is the
// position the next message will occupy. The two fields exist anyway: they are
// what an implementation with retention would have to maintain, and §6.2's
// EAPP_CURSOR_TOO_OLD rule is written against them rather than against the
// assumption that history is complete.
type memoryStream struct {
	messages []TransportMessage
	// next is the cursor position the next Send will occupy. It is the transport
	// that mints cursors (§10.1), so this counter — not the slice length — is
	// the source of positions: a future retention policy must not renumber them.
	next uint64
}

// NewMemoryTransport creates an empty process-local transport.
func NewMemoryTransport() *MemoryTransport {
	return &MemoryTransport{streams: make(map[string]*memoryStream)}
}

// ID names this transport.
func (m *MemoryTransport) ID() string { return "memory" }

// Capabilities reports §10.3's Memory row.
func (m *MemoryTransport) Capabilities() TransportCapabilities {
	return TransportCapabilities{
		Persistent: false,
		Ordering:   "global",
		Delivery: TransportDeliveryCapabilities{
			AtMostOnce:  true,
			AtLeastOnce: true,
			// No replay: the log lives in this process, so there is no history
			// to replay after it ends. Claiming it would be exactly the
			// overstatement TR-3 forbids.
			Replay: false,
		},
		SupportsCursor:     true,
		SupportsLease:      true,
		DurabilityBoundary: "process",
	}
}

// Send appends a message and returns its cursor (TR-8).
//
// TR-8 requires the returned cursor to be strictly greater than every cursor
// this Channel issued before. Minting from a counter inside the same critical
// section as the append is what makes that true, and it is why a caller cannot
// supply a cursor: positions belong to the transport.
func (m *MemoryTransport) Send(channel string, message any) (Cursor, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, present := m.streams[channel]
	if !present {
		stream = &memoryStream{}
		m.streams[channel] = stream
	}
	stream.next++
	cursor := formatCursor(stream.next)
	stream.messages = append(stream.messages, TransportMessage{Cursor: cursor, Payload: message})
	return cursor, nil
}

// ReadAfter implements §10.1's read, honouring TR-5 … TR-7.
func (m *MemoryTransport) ReadAfter(channel string, after *Cursor, pattern Pattern) ([]TransportMessage, error) {
	from := uint64(0)
	if after != nil {
		position, err := positionOf(*after)
		if err != nil {
			return nil, err
		}
		// TR-5: strictly greater than the argument. One is added here rather
		// than filtering afterwards, so the "greater" relation is stated once.
		from = position + 1
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	stream, present := m.streams[channel]
	if !present {
		// TR-7: a channel with no messages has no matches, and that is an empty
		// answer, never an error.
		return []TransportMessage{}, nil
	}

	out := make([]TransportMessage, 0, len(stream.messages))
	for _, message := range stream.messages {
		position, err := positionOf(message.Cursor)
		if err != nil {
			return nil, err
		}
		if position < from {
			continue
		}
		if !pattern.Match(message.Payload) {
			continue
		}
		out = append(out, message)
	}
	return out, nil
}

// Floor reports the most recently discarded position (§6.2).
//
// Nothing is discarded here, so it is always ZeroCursor — which is not a
// placeholder: ZeroCursor *is* the position before the first message, and §6.2
// makes the floor itself readable.
func (m *MemoryTransport) Floor(channel string) (Cursor, error) {
	return ZeroCursor, nil
}

// Head reports the Channel's current head (§6.2 rule 4): the position of the
// last message, or the floor when there are none.
//
// A Channel that has never carried a message has a head of ZeroCursor rather
// than no head at all. That keeps 'latest' resolvable to a concrete cursor on an
// empty Channel, which SUB-9 requires ("cursor MUST 在 Subscription 创建返回前被
// 解析为非 undefined 值") and which an undefined answer could not satisfy.
func (m *MemoryTransport) Head(channel string) (Cursor, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, present := m.streams[channel]
	if !present || len(stream.messages) == 0 {
		return ZeroCursor, nil
	}
	return stream.messages[len(stream.messages)-1].Cursor, nil
}

// Close releases the transport. The log is in memory, so there is nothing to
// release beyond dropping the reference to it.
func (m *MemoryTransport) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.streams = make(map[string]*memoryStream)
	return nil
}

// Reset clears every retained message. It exists for the conformance driver's
// `reset`, which has to make a long-lived process look like a fresh one.
func (m *MemoryTransport) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.streams = make(map[string]*memoryStream)
}
