package dominusnode

import (
	"fmt"
	"regexp"
)

var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+`),
	regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`),
}

// ScrubCredentials replaces API keys (dn_live_/dn_test_/dn_node_/dn_proxy_) and
// JWTs in s with "[REDACTED]". Every SDK error message passes through it.
func ScrubCredentials(s string) string {
	for _, re := range credentialPatterns {
		s = re.ReplaceAllString(s, redacted)
	}
	return s
}

// CodeInvalidArgument is the Code of client-side validation failures (no request sent).
const CodeInvalidArgument = "INVALID_ARGUMENT"

// CodeMFARequired is set when the server answers {mfaRequired: true} without a code.
const CodeMFARequired = "MFA_REQUIRED"

// DominusNodeError is the base of every SDK error. Use errors.As with the
// specific types (*ValidationError, *RateLimitError, ...) or with
// *DominusNodeError to match any of them.
type DominusNodeError struct {
	Message string
	// StatusCode is the HTTP status, or 0 when no response was involved.
	StatusCode int
	// Code is the server's error code (e.g. "INVALID_CHALLENGE") or "INVALID_ARGUMENT".
	Code string
	// Details holds max / cap / limitPerDay when the server sent them.
	Details map[string]any
}

func (e *DominusNodeError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s (%s)", e.Message, e.Code)
	}
	return e.Message
}

func newBase(msg string, status int, code string, details map[string]any) DominusNodeError {
	return DominusNodeError{Message: ScrubCredentials(msg), StatusCode: status, Code: code, Details: details}
}

// ValidationError: HTTP 400, or a client-side argument check (StatusCode 0, Code INVALID_ARGUMENT).
type ValidationError struct{ DominusNodeError }

// AuthenticationError: HTTP 401, or no credential held.
type AuthenticationError struct{ DominusNodeError }

// InsufficientBalanceError: HTTP 402.
type InsufficientBalanceError struct{ DominusNodeError }

// AuthorizationError: HTTP 403.
type AuthorizationError struct{ DominusNodeError }

// NotFoundError: HTTP 404.
type NotFoundError struct{ DominusNodeError }

// ConflictError: HTTP 409.
type ConflictError struct{ DominusNodeError }

// RateLimitError: HTTP 429 after the single retry.
type RateLimitError struct {
	DominusNodeError
	RetryAfterSeconds int
}

// ServerError: HTTP >= 500, oversize body or invalid JSON.
type ServerError struct{ DominusNodeError }

// NetworkError: transport failure.
type NetworkError struct{ DominusNodeError }

// ProtocolError: server data the SDK refuses to act on, or a signer failure.
type ProtocolError struct{ DominusNodeError }

// ProxyError: Proxy.Fetch failure (blocked target, refused tunnel, timeout).
type ProxyError struct{ DominusNodeError }

func (e *ValidationError) Unwrap() error          { return &e.DominusNodeError }
func (e *AuthenticationError) Unwrap() error      { return &e.DominusNodeError }
func (e *InsufficientBalanceError) Unwrap() error { return &e.DominusNodeError }
func (e *AuthorizationError) Unwrap() error       { return &e.DominusNodeError }
func (e *NotFoundError) Unwrap() error            { return &e.DominusNodeError }
func (e *ConflictError) Unwrap() error            { return &e.DominusNodeError }
func (e *RateLimitError) Unwrap() error           { return &e.DominusNodeError }
func (e *ServerError) Unwrap() error              { return &e.DominusNodeError }
func (e *NetworkError) Unwrap() error             { return &e.DominusNodeError }
func (e *ProtocolError) Unwrap() error            { return &e.DominusNodeError }
func (e *ProxyError) Unwrap() error               { return &e.DominusNodeError }

func invalidArg(format string, a ...any) error {
	return &ValidationError{newBase(fmt.Sprintf(format, a...), 0, CodeInvalidArgument, nil)}
}

func protocolErr(format string, a ...any) error {
	return &ProtocolError{newBase(fmt.Sprintf(format, a...), 0, "", nil)}
}

func proxyErr(status int, format string, a ...any) error {
	return &ProxyError{newBase(fmt.Sprintf(format, a...), status, "", nil)}
}

func authErr(msg string) error {
	return &AuthenticationError{newBase(msg, 401, "", nil)}
}

func networkErr(msg string) error {
	return &NetworkError{newBase(msg, 0, "", nil)}
}

func serverErr(msg string, status int) error {
	return &ServerError{newBase(msg, status, "", nil)}
}

// errorForStatus maps an HTTP status to the typed error.
func errorForStatus(status int, msg, code string, details map[string]any, retryAfter int) error {
	b := newBase(msg, status, code, details)
	switch {
	case status == 400:
		return &ValidationError{b}
	case status == 401:
		return &AuthenticationError{b}
	case status == 402:
		return &InsufficientBalanceError{b}
	case status == 403:
		return &AuthorizationError{b}
	case status == 404:
		return &NotFoundError{b}
	case status == 409:
		return &ConflictError{b}
	case status == 429:
		return &RateLimitError{b, retryAfter}
	case status >= 500:
		return &ServerError{b}
	default:
		return &b
	}
}
