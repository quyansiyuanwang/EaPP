package eapp

// §3.1's three message envelopes.
//
// §3.1 says these shapes "属于本层，上层 MUST 使用它们而不得自创形状" — they belong
// to this layer, and an upper layer MUST use them rather than inventing its own.
// They are therefore declared here, verbatim, even though nothing in this
// implementation *fills* them in: this layer carries a payload opaquely (§10.1's
// TransportMessage), and building a request or an event is the runtime's job,
// which the conformance driver protocol does not expose (it has no `invoke`).
//
// Declaring them matters anyway, for the reason §3.1 gives. A reader looking for
// `correlationId`'s shape or for what an event carries should find the frozen
// answer in the layer that owns it, and an implementation that let each caller
// spell these fields for itself would have re-created the fourth ontology v3.1
// §3 exists to prevent.
//
// §3.1's last sentence is honoured literally: `RequestMessage`, `ResponseMessage`,
// `EventMessage` and `StreamMessage` keep the member names and meanings the spec
// gives them, and nothing here renames or re-scopes one of them.

// RequestMessage is §3.1's request envelope.
//
// RQ-1: every request MUST have a unique correlationId. Uniqueness is a property
// of a *set* of requests, so it cannot be established by one value; the check
// belongs to whoever issues them.
// RQ-2: a request MUST correspond to zero or one response. The second copy of a
// response, or a late reply to a request whose deadline has passed, MUST be
// discarded rather than resolving the call twice.
// RQ-4: once the deadline has passed, the receiver MUST NOT begin executing the
// request — which is why `Deadline` is part of the envelope and not a caller's
// private field.
type RequestMessage struct {
	CorrelationID string `json:"correlationId"`
	Operation     string `json:"operation"`
	Payload       any    `json:"payload"`
	Deadline      *int64 `json:"deadline,omitempty"` // Unix ms
}

// ResponseError is the `error` member of a response: §16's EappError shape.
type ResponseError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

// ResponseMessage is §3.1's response envelope.
//
// RQ-3: a response MUST carry the same correlationId as its request. That is the
// only thing that pairs the two, and it is why the field is not optional.
type ResponseMessage struct {
	CorrelationID string         `json:"correlationId"`
	OK            bool           `json:"ok"`
	Result        any            `json:"result,omitempty"`
	Error         *ResponseError `json:"error,omitempty"`
}

// EventMessage is §3.1's event envelope.
//
// EV-1: an event MUST NOT expect a response — there is no correlationId here,
// and adding one "just in case" would turn every event into a request that
// nobody answers.
// EV-2/EV-3: delivery MAY be zero times and MAY be more than once, which is what
// makes an event compatible with at-most-once *and* at-least-once delivery (§4.4).
type EventMessage struct {
	Topic   string         `json:"topic"`
	Payload any            `json:"payload"`
	Headers map[string]any `json:"headers,omitempty"`
}

// StreamMessage is §3.1's stream envelope.
//
// ST-1: the cursor MUST be globally monotonic within the Channel, which is why
// the transport assigns it (§10.1's `send` returns one) and why a caller never
// sets this field.
// ST-2: a consumer MUST be able to resume from the cursor. This envelope is what
// makes that possible: the position travels with the message rather than being
// implied by where it happened to appear in an iteration.
type StreamMessage struct {
	Cursor  Cursor `json:"cursor"`
	Payload any    `json:"payload"`
}
