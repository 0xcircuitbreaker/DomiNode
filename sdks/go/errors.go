package dominusnode

import (
	"fmt"
	"time"
)

// DominusNodeError is the base error type for all Dominus Node SDK errors.
// All specific error types embed this type.
type DominusNodeError struct {
	// Message is a human-readable error description.
	Message string
	// StatusCode is the HTTP status code that caused this error, or 0 if not applicable.
	StatusCode int
	// Err is the underlying error, if any.
	Err error
}

// Error returns the error message string.
func (e *DominusNodeError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

// Unwrap returns the underlying error for errors.Is/As compatibility.
func (e *DominusNodeError) Unwrap() error {
	return e.Err
}

// AuthenticationError indicates a 401 Unauthorized response.
type AuthenticationError struct {
	DominusNodeError
}

// AuthorizationError indicates a 403 Forbidden response.
type AuthorizationError struct {
	DominusNodeError
}

// RateLimitError indicates a 429 Too Many Requests response.
type RateLimitError struct {
	DominusNodeError
	// RetryAfter is the duration the client should wait before retrying.
	RetryAfter time.Duration
}

// InsufficientBalanceError indicates a 402 Payment Required response.
type InsufficientBalanceError struct {
	DominusNodeError
}

// ValidationError indicates a 400 Bad Request response due to invalid input.
type ValidationError struct {
	DominusNodeError
}

// NotFoundError indicates a 404 Not Found response.
type NotFoundError struct {
	DominusNodeError
}

// ConflictError indicates a 409 Conflict response.
type ConflictError struct {
	DominusNodeError
}

// ServerError indicates a 5xx server-side error response.
type ServerError struct {
	DominusNodeError
}

// NetworkError indicates a network-level failure (DNS, connection, timeout).
type NetworkError struct {
	DominusNodeError
}

// ProxyError indicates an error specific to proxy operations.
type ProxyError struct {
	DominusNodeError
}
