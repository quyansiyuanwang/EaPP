package eapp

// Exported error constructors.
//
// The Core builds all of its own errors internally, so these exist for callers
// *outside* the package — in practice the conformance driver, which has to
// produce two codes the Core itself never emits: EAPP_UNSUPPORTED for an
// operation this implementation does not have, and EAPP_INTERNAL for a failure
// of the driver itself.
//
// They are exported rather than letting the driver paste code strings, because
// §16 freezes those strings: a typo in a driver is a protocol violation that no
// compiler would catch.

// Unsupported returns an EAPP_UNSUPPORTED error, the code §conformance/driver.md
// requires for an operation that is not implemented. An implementation MUST NOT
// crash or silently succeed instead, so this is the only correct answer for a
// request whose `op` is unknown.
func Unsupported(format string, args ...any) error {
	return newError(CodeUnsupported, format, args...)
}

// Internal returns an EAPP_INTERNAL error: a failure that is not one of §16's
// semantic conditions.
func Internal(format string, args ...any) error {
	return newError(CodeInternal, format, args...)
}

// InvalidIdentity returns an EAPP_IDENTITY_INVALID error. It is exported for
// callers that validate identity input before it reaches the Core (a decoder,
// for instance) and must report the same code the Core would.
func InvalidIdentity(format string, args ...any) error {
	return errIdentityInvalid(format, args...)
}

// InvalidBinding returns an EAPP_BINDING_INVALID error, for callers that reject
// a malformed bind request before the Core sees it.
func InvalidBinding(format string, args ...any) error {
	return errBindingInvalid(format, args...)
}

// ParseBindingState converts a wire string into a BindingState.
//
// It rejects anything outside §6.2's three states, so a caller cannot accidentally
// treat "PENDING" (B-9) or a typo as a real state.
func ParseBindingState(text string) (BindingState, error) {
	state := BindingState(text)
	if !state.Valid() {
		return "", errBindingInvalid(
			"binding state MUST be one of ACTIVE, DORMANT, CLOSED; got %q (§6.2)", text)
	}
	return state, nil
}

// CodeOf is declared in errors.go; the rest of the §16 surface lives there.
