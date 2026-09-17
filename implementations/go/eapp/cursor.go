package eapp

import (
	"fmt"
	"strconv"
	"strings"
)

// Cursor is the position of a message inside one Channel's log (v3.1 §6.1).
//
// The type is a string because §6.1 freezes it as one and because a cursor
// crosses a process boundary as text. "Opaque" is a rule about *callers* — they
// MUST NOT parse it or assume a shape — not about this implementation: inside
// this package a cursor names a log position, rendered as fixed-width decimal.
// CR-1 ("globally ordered within Channel") has to be answerable without
// consulting the log, and CR-2 ("persistable and recoverable") has to survive
// being written down and read back; a decimal rendering of the position is both.
//
// The width is not part of the contract (§6.1 says only "opaque"), but rendering
// every cursor with the same number of digits has a practical consequence worth
// stating: lexicographic order and numeric order agree, so a caller that sorts
// cursors as strings and a caller that parses them as integers see the same
// order. That matters because neither behaviour is forbidden.
type Cursor string

// cursorWidth is the number of decimal digits a minted cursor carries. Sixteen
// digits cover every position a process can reach; a position that outgrows the
// width simply renders wider, which stays ordered.
const cursorWidth = 16

// ZeroCursor is the position before a Channel's first message.
//
// It is what 'earliest' resolves to while the transport retains its whole log
// (§6.2: "the earliest position still serviceable"), and what `latest` resolves
// to on a Channel that has never carried a message. §6.2's retention table makes
// the floor itself readable: "位置 = floor → 可读（读的是 floor 之后的内容）".
const ZeroCursor Cursor = "0000000000000000"

// formatCursor renders a log position as a cursor.
func formatCursor(position uint64) Cursor {
	return Cursor(fmt.Sprintf("%0*d", cursorWidth, position))
}

// positionOf recovers the log position a cursor names.
//
// A cursor that is not a position this implementation minted is
// EAPP_CURSOR_INVALID rather than a silently-ignored value: §6.2 rule 7 is the
// general shape of the mistake this guards against — handing a caller a
// plausible-but-wrong position makes it continue somewhere it did not intend,
// which is indistinguishable from success.
func positionOf(cursor Cursor) (uint64, error) {
	text := string(cursor)
	if text == "" {
		return 0, errCursorInvalid("cursor MUST NOT be empty (§6.1)")
	}
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return 0, errCursorInvalid(
				"cursor %q is not a position this transport issued (CR-1, CR-2)", text)
		}
	}
	trimmed := strings.TrimLeft(text, "0")
	if trimmed == "" {
		return 0, nil
	}
	if len(trimmed) > 20 {
		return 0, errCursorInvalid("cursor %q is outside the range of a log position", text)
	}
	position, err := strconv.ParseUint(trimmed, 10, 64)
	if err != nil {
		return 0, errCursorInvalid("cursor %q is outside the range of a log position", text)
	}
	return position, nil
}

// CompareCursor orders two cursors of the same Channel (CR-1).
//
// It returns -1, 0 or 1. A cursor that is not a position is an error rather than
// an ordering: two unparsable strings have no order, and inventing one (say,
// text order) would let a caller believe it had compared two positions.
func CompareCursor(left, right Cursor) (int, error) {
	leftPosition, err := positionOf(left)
	if err != nil {
		return 0, err
	}
	rightPosition, err := positionOf(right)
	if err != nil {
		return 0, err
	}
	switch {
	case leftPosition < rightPosition:
		return -1, nil
	case leftPosition > rightPosition:
		return 1, nil
	default:
		return 0, nil
	}
}

// MaxCursor returns the greater of two cursors (§6.4's ack rule).
//
// It is exactly the operation `ack(c)` performs on a cursor: "ack(c) MUST 将
// cursor 置为 max(当前 cursor, c)". Acknowledging an *earlier* position than the
// one already confirmed therefore changes nothing, while acknowledging a later
// one abandons every unacknowledged position in between — which §6.4 states in
// as many words MUST be allowed, and which §8.3 relies on for group cursors.
func MaxCursor(current, candidate Cursor) (Cursor, error) {
	order, err := CompareCursor(current, candidate)
	if err != nil {
		return "", err
	}
	if order < 0 {
		return candidate, nil
	}
	return current, nil
}

// CursorAnchor is §6.2's union of literal anchors and concrete positions: it is
// how a caller asks for "the earliest position still serviceable", "the current
// head", or one exact place.
type CursorAnchor string

const (
	// AnchorEarliest asks for the earliest position the Channel can still serve
	// (§6.2 rule 3).
	AnchorEarliest CursorAnchor = "earliest"
	// AnchorLatest asks for the Channel's current head (§6.2 rule 4).
	AnchorLatest CursorAnchor = "latest"
)

// ParseCursorAnchor applies §6.2's resolution rule 1: the two literals MUST be
// recognised as anchors and MUST NOT be treated as cursor values. Because the
// check is on the literal, it happens before any attempt to interpret the text
// as a position — a transport whose cursors happened to spell "earliest" could
// not be confused by it.
func ParseCursorAnchor(text string) CursorAnchor {
	return CursorAnchor(text)
}

// IsEarliest reports whether the anchor is the literal 'earliest'.
func (a CursorAnchor) IsEarliest() bool { return a == AnchorEarliest }

// IsLatest reports whether the anchor is the literal 'latest'.
func (a CursorAnchor) IsLatest() bool { return a == AnchorLatest }

// IsConcrete reports whether the anchor names one exact position rather than a
// literal (§6.2 rule 2: every other string is a Cursor).
func (a CursorAnchor) IsConcrete() bool { return a != AnchorEarliest && a != AnchorLatest }

// CursorState is §6.1's {cursor, pending}: the confirmed position plus the
// positions that were received and not yet acknowledged.
//
// It exists as a value because that pairing is what makes CR-3 checkable: the
// confirmed cursor and the unacknowledged items are two different things, and an
// implementation that conflates them ("the cursor is wherever delivery reached")
// advances without an acknowledgement.
type CursorState struct {
	// Cursor is the confirmed position: advanced only by ack, never by delivery
	// (§6.4).
	Cursor Cursor `json:"cursor"`
	// Pending lists received-but-unacknowledged positions, in cursor order.
	Pending []Cursor `json:"pending"`
}
