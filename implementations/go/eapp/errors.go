package eapp

import (
	"errors"
	"fmt"
)

// Error codes defined by EaPP v3.0.0 Composition Core §16.
//
// §16 freezes these strings: an implementation MUST NOT rename a code, and
// harnesses key off the code alone. They are exported so callers can compare
// against a constant instead of pasting the literal, but the *string values*
// are part of the protocol, not an implementation choice.
const (
	CodeIdentityInvalid       = "EAPP_IDENTITY_INVALID"
	CodeIdentityDuplicate     = "EAPP_IDENTITY_DUPLICATE"
	CodeCapabilityNotFound    = "EAPP_CAPABILITY_NOT_FOUND"
	CodeCapabilityNotExposed  = "EAPP_CAPABILITY_NOT_EXPOSED"
	CodePluginNotFound        = "EAPP_PLUGIN_NOT_FOUND"
	CodePluginInactive        = "EAPP_PLUGIN_INACTIVE"
	CodeBindingInvalid        = "EAPP_BINDING_INVALID"
	CodeBindingDuplicate      = "EAPP_BINDING_DUPLICATE"
	CodeBindingClosed         = "EAPP_BINDING_CLOSED"
	CodeLifecycleInvalid      = "EAPP_LIFECYCLE_INVALID"
	CodeDiscoveryScopeInvalid = "EAPP_DISCOVERY_SCOPE_INVALID"
	CodeUnsupported           = "EAPP_UNSUPPORTED"
	CodeInternal              = "EAPP_INTERNAL"
)

// Error codes added by EaPP v3.1.0 Interaction §13.
//
// They extend the §16 union rather than replacing it (§13: "各层的 code 联合按层
// 扩展，MUST NOT 重命名或改义既有码"), so the interaction layer reuses the Core
// codes where the condition is a Core one — a Channel created from a nonexistent
// Binding is EAPP_BINDING_INVALID, not a new code.
const (
	CodeChannelInvalid      = "EAPP_CHANNEL_INVALID"
	CodeChannelClosed       = "EAPP_CHANNEL_CLOSED"
	CodeChannelDraining     = "EAPP_CHANNEL_DRAINING"
	CodeModeInvalid         = "EAPP_MODE_INVALID"
	CodeDeliveryUnsupported = "EAPP_DELIVERY_UNSUPPORTED"
	CodeCursorInvalid       = "EAPP_CURSOR_INVALID"
	CodeCursorUnsupported   = "EAPP_CURSOR_UNSUPPORTED"
	CodeCursorTooOld        = "EAPP_CURSOR_TOO_OLD"
	CodeSubscriptionInvalid = "EAPP_SUBSCRIPTION_INVALID"
	CodeLeaseExpired        = "EAPP_LEASE_EXPIRED"
	CodeLeaseClosed         = "EAPP_LEASE_CLOSED"
	CodeLeaseConflict       = "EAPP_LEASE_CONFLICT"
	CodeTimeout             = "EAPP_TIMEOUT"
)

// Error is the single error type produced by this implementation.
//
// It mirrors the `EappError` shape of §16 (`code`, `message`, plus optional
// `details` and `retryable`). One concrete type — rather than one type per
// code — is deliberate: callers (and the conformance driver) must be able to
// report any failure uniformly, and `errors.As(err, &*Error)` finds it even
// when the error travelled through several layers of `%w` wrapping.
type Error struct {
	// Code is one of the §16 codes. It is never empty for an Error
	// constructed by this package.
	Code string
	// Message is for humans. The spec is explicit that no harness may parse
	// it (§conformance/driver.md "错误"), so it is free-form prose.
	Message string
	// Details carries optional structured context (for example the id of the
	// Binding that caused a duplicate). Never required to interpret Code.
	Details any
	// Retryable is inherently implementation-specific: the spec defines the
	// field but not which codes are retryable. It stays false for every error
	// this package returns, because none of them is a transient failure — they
	// all describe a state of the plugin graph that a caller must change.
	Retryable bool
}

// Error implements the error interface. The rendering includes the code
// because a wrapped chain read by a human is useless without it.
func (e *Error) Error() string {
	if e == nil {
		return "<nil EaPP error>"
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// newError builds an Error with a printf-style message.
func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// withDetails returns a copy of e carrying structured details. It keeps the
// construction sites one-liners without a second error type.
func (e *Error) withDetails(details any) *Error {
	clone := *e
	clone.Details = details
	return &clone
}

// CodeOf reports the §16 code of err, if err is (or wraps) an *Error.
//
// The boolean is false for foreign errors, so callers can decide what to do
// with, say, an io error: mapping it to EAPP_INTERNAL is a policy decision and
// should be visible at the call site rather than hidden here.
func CodeOf(err error) (string, bool) {
	var eappErr *Error
	if errors.As(err, &eappErr) {
		return eappErr.Code, true
	}
	return "", false
}

// The constructors below exist so that call sites never hand-write a code
// string: a typo in a code is a protocol violation that no compiler catches.

func errIdentityInvalid(format string, args ...any) *Error {
	return newError(CodeIdentityInvalid, format, args...)
}

func errIdentityDuplicate(format string, args ...any) *Error {
	return newError(CodeIdentityDuplicate, format, args...)
}

func errCapabilityNotFound(format string, args ...any) *Error {
	return newError(CodeCapabilityNotFound, format, args...)
}

func errCapabilityNotExposed(format string, args ...any) *Error {
	return newError(CodeCapabilityNotExposed, format, args...)
}

func errPluginNotFound(format string, args ...any) *Error {
	return newError(CodePluginNotFound, format, args...)
}

func errBindingInvalid(format string, args ...any) *Error {
	return newError(CodeBindingInvalid, format, args...)
}

func errBindingDuplicate(format string, args ...any) *Error {
	return newError(CodeBindingDuplicate, format, args...)
}

func errBindingClosed(format string, args ...any) *Error {
	return newError(CodeBindingClosed, format, args...)
}

func errLifecycleInvalid(format string, args ...any) *Error {
	return newError(CodeLifecycleInvalid, format, args...)
}

func errDiscoveryScopeInvalid(format string, args ...any) *Error {
	return newError(CodeDiscoveryScopeInvalid, format, args...)
}

// The interaction-layer constructors, for the same reason: a code string typed
// by hand at a call site is a protocol violation no compiler catches.

func errChannelInvalid(format string, args ...any) *Error {
	return newError(CodeChannelInvalid, format, args...)
}

func errChannelClosed(format string, args ...any) *Error {
	return newError(CodeChannelClosed, format, args...)
}

func errChannelDraining(format string, args ...any) *Error {
	return newError(CodeChannelDraining, format, args...)
}

func errModeInvalid(format string, args ...any) *Error {
	return newError(CodeModeInvalid, format, args...)
}

func errDeliveryUnsupported(format string, args ...any) *Error {
	return newError(CodeDeliveryUnsupported, format, args...)
}

func errCursorInvalid(format string, args ...any) *Error {
	return newError(CodeCursorInvalid, format, args...)
}

func errCursorUnsupported(format string, args ...any) *Error {
	return newError(CodeCursorUnsupported, format, args...)
}

func errCursorTooOld(format string, args ...any) *Error {
	return newError(CodeCursorTooOld, format, args...)
}

func errSubscriptionInvalid(format string, args ...any) *Error {
	return newError(CodeSubscriptionInvalid, format, args...)
}

func errLeaseExpired(format string, args ...any) *Error {
	return newError(CodeLeaseExpired, format, args...)
}

func errLeaseClosed(format string, args ...any) *Error {
	return newError(CodeLeaseClosed, format, args...)
}

// errUnsupported is EAPP_UNSUPPORTED: §10.4's TR-9 code for a feature the
// transport does not have. api.Unsupported exposes the same constructor to
// callers outside the package.
func errUnsupported(format string, args ...any) *Error {
	return newError(CodeUnsupported, format, args...)
}
