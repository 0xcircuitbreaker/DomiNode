package dominusnode

import (
	"fmt"
	"io"
)

const redacted = "[REDACTED]"

// Secret wraps a credential the server returns exactly once (new API key,
// team key, dn_node_ key). Printing it with any fmt verb, %#v, or
// marshalling it to JSON yields "[REDACTED]". Call Reveal to get the value.
type Secret struct {
	value string
}

// NewSecret wraps v.
func NewSecret(v string) Secret { return Secret{value: v} }

// Reveal returns the raw credential. Do not log it.
func (s Secret) Reveal() string { return s.value }

// Prefix returns the first 8 characters (safe for logs).
func (s Secret) Prefix() string {
	if len(s.value) <= 8 {
		return s.value
	}
	return s.value[:8]
}

// String implements fmt.Stringer.
func (s Secret) String() string { return redacted }

// GoString implements fmt.GoStringer (%#v).
func (s Secret) GoString() string { return "Secret(" + redacted + ")" }

// Format makes every fmt verb (%v %s %q %x %+v %#v ...) print the redaction marker.
func (s Secret) Format(f fmt.State, verb rune) {
	if verb == 'v' && f.Flag('#') {
		_, _ = io.WriteString(f, s.GoString())
		return
	}
	_, _ = io.WriteString(f, redacted)
}

// MarshalJSON implements json.Marshaler.
func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"` + redacted + `"`), nil }

// MarshalText implements encoding.TextMarshaler.
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// clear drops the reference to the value.
func (s *Secret) clear() { s.value = "" }
