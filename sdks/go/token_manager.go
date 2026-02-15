package dominusnode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// refreshFunc is a function that performs a token refresh using the given
// refresh token and returns a new access token and refresh token.
type refreshFunc func(ctx context.Context, refreshToken string) (accessToken string, newRefreshToken string, err error)

// tokenManager handles JWT token storage, expiry checking, and automatic
// refresh. It is safe for concurrent use.
type tokenManager struct {
	mu           sync.Mutex
	accessToken  string
	refreshToken string
	refreshFn    refreshFunc
	refreshing   bool
	refreshCh    chan struct{} // signaled when an in-flight refresh completes
}

// newTokenManager creates a new tokenManager instance.
func newTokenManager() *tokenManager {
	return &tokenManager{}
}

// setTokens stores the given access and refresh tokens.
func (tm *tokenManager) setTokens(access, refresh string) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.accessToken = access
	if refresh != "" {
		tm.refreshToken = refresh
	}
}

// setRefreshFn sets the function used to refresh expired tokens.
func (tm *tokenManager) setRefreshFn(fn refreshFunc) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.refreshFn = fn
}

// getAccessToken returns the current access token, or empty string if none.
func (tm *tokenManager) getAccessToken() string {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.accessToken
}

// getRefreshToken returns the current refresh token, or empty string if none.
func (tm *tokenManager) getRefreshToken() string {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.refreshToken
}

// hasTokens returns true if the manager has at least an access token.
func (tm *tokenManager) hasTokens() bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.accessToken != ""
}

// clear removes all stored tokens.
func (tm *tokenManager) clear() {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.accessToken = ""
	tm.refreshToken = ""
}

// isExpired checks whether the given JWT token is expired or will expire
// within the TokenRefreshBuffer window. It decodes the JWT payload without
// verifying the signature (no external JWT library needed).
func (tm *tokenManager) isExpired(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return true
	}

	// Decode the payload (second part). JWT uses base64url encoding
	// which may not have padding.
	payload := parts[1]
	// Replace URL-safe chars with standard base64 chars
	payload = strings.ReplaceAll(payload, "-", "+")
	payload = strings.ReplaceAll(payload, "_", "/")
	// Add padding if needed
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return true
	}

	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return true
	}

	// Token is "expired" if it expires within the refresh buffer
	expiresAt := time.Unix(claims.Exp, 0)
	return time.Now().Add(TokenRefreshBuffer).After(expiresAt)
}

// getValidToken returns a valid access token, refreshing if necessary.
// If a refresh is already in progress, it waits for that refresh to complete
// rather than initiating a second one (singleton refresh pattern).
func (tm *tokenManager) getValidToken(ctx context.Context) (string, error) {
	tm.mu.Lock()

	// If we have a non-expired token, return it immediately
	if tm.accessToken != "" && !tm.isExpired(tm.accessToken) {
		token := tm.accessToken
		tm.mu.Unlock()
		return token, nil
	}

	// Need to refresh. Check if a refresh is already in progress.
	if tm.refreshing {
		ch := tm.refreshCh
		tm.mu.Unlock()
		// Wait for the in-flight refresh to complete
		select {
		case <-ch:
			tm.mu.Lock()
			token := tm.accessToken
			tm.mu.Unlock()
			if token == "" {
				return "", &AuthenticationError{DominusNodeError{Message: "Token refresh failed", StatusCode: 401}}
			}
			return token, nil
		case <-ctx.Done():
			return "", &NetworkError{DominusNodeError{Message: "Context cancelled while waiting for token refresh", Err: ctx.Err()}}
		}
	}

	// No refresh in progress. Check if we can refresh.
	if tm.refreshToken == "" || tm.refreshFn == nil {
		tm.mu.Unlock()
		return "", &AuthenticationError{DominusNodeError{Message: "No valid token and cannot refresh", StatusCode: 401}}
	}

	// Start a refresh
	tm.refreshing = true
	tm.refreshCh = make(chan struct{})
	refreshToken := tm.refreshToken
	fn := tm.refreshFn
	tm.mu.Unlock()

	// Perform the refresh outside the lock
	newAccess, newRefresh, err := fn(ctx, refreshToken)

	tm.mu.Lock()
	if err != nil {
		// Clear tokens on refresh failure
		tm.accessToken = ""
		tm.refreshToken = ""
		tm.refreshing = false
		close(tm.refreshCh)
		tm.mu.Unlock()
		return "", err
	}

	tm.accessToken = newAccess
	if newRefresh != "" {
		tm.refreshToken = newRefresh
	}
	tm.refreshing = false
	close(tm.refreshCh)
	token := tm.accessToken
	tm.mu.Unlock()

	return token, nil
}

// forceRefresh forces a token refresh regardless of the current token's
// expiry state. Used after receiving a 401 response to avoid reusing
// a rejected token.
func (tm *tokenManager) forceRefresh(ctx context.Context) (string, error) {
	tm.mu.Lock()

	// If a refresh is already in progress, wait for it
	if tm.refreshing {
		ch := tm.refreshCh
		tm.mu.Unlock()
		select {
		case <-ch:
			tm.mu.Lock()
			token := tm.accessToken
			tm.mu.Unlock()
			if token == "" {
				return "", &AuthenticationError{DominusNodeError{Message: "Token refresh failed", StatusCode: 401}}
			}
			return token, nil
		case <-ctx.Done():
			return "", &NetworkError{DominusNodeError{Message: "Context cancelled while waiting for token refresh", Err: ctx.Err()}}
		}
	}

	if tm.refreshToken == "" || tm.refreshFn == nil {
		tm.mu.Unlock()
		return "", &AuthenticationError{DominusNodeError{Message: "No valid token and cannot refresh", StatusCode: 401}}
	}

	tm.refreshing = true
	tm.refreshCh = make(chan struct{})
	refreshToken := tm.refreshToken
	fn := tm.refreshFn
	tm.mu.Unlock()

	newAccess, newRefresh, err := fn(ctx, refreshToken)

	tm.mu.Lock()
	if err != nil {
		tm.accessToken = ""
		tm.refreshToken = ""
		tm.refreshing = false
		close(tm.refreshCh)
		tm.mu.Unlock()
		return "", err
	}

	tm.accessToken = newAccess
	if newRefresh != "" {
		tm.refreshToken = newRefresh
	}
	tm.refreshing = false
	close(tm.refreshCh)
	token := tm.accessToken
	tm.mu.Unlock()

	return token, nil
}
