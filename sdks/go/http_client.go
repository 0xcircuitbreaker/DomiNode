package dominusnode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"math/rand"
	"net/url"
	"sort"
	"strconv"
	"time"
)

// httpClient is the internal HTTP client used by all resource types.
// It handles authentication headers, automatic token refresh on 401,
// rate limit retry on 429, and error mapping.
type httpClient struct {
	baseURL      string
	client       *http.Client
	tokenManager *tokenManager
	agentSecret  string
}

// newHTTPClient creates a new httpClient with the given configuration.
func newHTTPClient(baseURL string, tm *tokenManager, client *http.Client, agentSecret string) *httpClient {
	return &httpClient{
		baseURL:      baseURL,
		client:       client,
		tokenManager: tm,
		agentSecret:  agentSecret,
	}
}

// requestOptions configures a single HTTP request.
type requestOptions struct {
	Method       string
	Path         string
	Body         interface{}
	RequiresAuth bool
}

// doRequest performs an HTTP request and decodes the JSON response into result.
// It handles:
//   - Adding Authorization header when authenticated
//   - Retrying once on 429 (rate limit) with Retry-After wait (capped at MaxRetryWaitSeconds)
//   - Retrying once on 401 after forcing a token refresh
//   - Mapping HTTP error status codes to typed errors
func (hc *httpClient) doRequest(ctx context.Context, opts requestOptions, result interface{}) error {
	resp, body, err := hc.executeRequest(ctx, opts)
	if err != nil {
		return err
	}

	// Handle 429 rate limit: wait and retry once
	if resp.StatusCode == 429 {
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"), 5)
		if retryAfter > MaxRetryWaitSeconds {
			retryAfter = MaxRetryWaitSeconds
		}
		if retryAfter < 0 {
			retryAfter = 0
		}

		// Add ±10% jitter to prevent thundering-herd retry storms
		waitMs := retryAfter * 1000
		if waitMs < 100 {
			waitMs = 100
		}
		jitterMs := int(float64(waitMs) * 0.2 * (rand.Float64() - 0.5))
		waitMs += jitterMs
		if waitMs < 100 {
			waitMs = 100
		}

		timer := time.NewTimer(time.Duration(waitMs) * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return &NetworkError{DominusNodeError{Message: "Context cancelled during rate limit wait", Err: ctx.Err()}}
		}

		resp, body, err = hc.executeRequest(ctx, opts)
		if err != nil {
			return err
		}
	}

	// Handle 401 unauthorized: force token refresh and retry once
	if resp.StatusCode == 401 && opts.RequiresAuth {
		_, refreshErr := hc.tokenManager.forceRefresh(ctx)
		if refreshErr == nil {
			retryResp, retryBody, retryErr := hc.executeRequest(ctx, opts)
			if retryErr != nil {
				return retryErr
			}
			if retryResp.StatusCode >= 200 && retryResp.StatusCode < 300 {
				return decodeResponse(retryBody, result)
			}
			return mapStatusToError(retryResp.StatusCode, retryBody, retryResp.Header)
		}
		// If refresh failed, fall through to the original 401 error
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return decodeResponse(body, result)
	}

	return mapStatusToError(resp.StatusCode, body, resp.Header)
}

// doRequestRaw performs an HTTP request and returns the raw response body as a string.
// Used for endpoints that return non-JSON content (e.g., CSV export).
func (hc *httpClient) doRequestRaw(ctx context.Context, opts requestOptions) (string, error) {
	resp, body, err := hc.executeRequest(ctx, opts)
	if err != nil {
		return "", err
	}

	// Handle 429 rate limit
	if resp.StatusCode == 429 {
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"), 5)
		if retryAfter > MaxRetryWaitSeconds {
			retryAfter = MaxRetryWaitSeconds
		}
		if retryAfter < 0 {
			retryAfter = 0
		}

		// Add ±10% jitter to prevent thundering-herd retry storms
		waitMs := retryAfter * 1000
		if waitMs < 100 {
			waitMs = 100
		}
		jitterMs := int(float64(waitMs) * 0.2 * (rand.Float64() - 0.5))
		waitMs += jitterMs
		if waitMs < 100 {
			waitMs = 100
		}

		timer := time.NewTimer(time.Duration(waitMs) * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return "", &NetworkError{DominusNodeError{Message: "Context cancelled during rate limit wait", Err: ctx.Err()}}
		}

		resp, body, err = hc.executeRequest(ctx, opts)
		if err != nil {
			return "", err
		}
	}

	// Handle 401
	if resp.StatusCode == 401 && opts.RequiresAuth {
		_, refreshErr := hc.tokenManager.forceRefresh(ctx)
		if refreshErr == nil {
			retryResp, retryBody, retryErr := hc.executeRequest(ctx, opts)
			if retryErr != nil {
				return "", retryErr
			}
			if retryResp.StatusCode >= 200 && retryResp.StatusCode < 300 {
				return string(retryBody), nil
			}
			return "", mapStatusToError(retryResp.StatusCode, retryBody, retryResp.Header)
		}
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return string(body), nil
	}

	return "", mapStatusToError(resp.StatusCode, body, resp.Header)
}

// executeRequest builds and sends a single HTTP request.
func (hc *httpClient) executeRequest(ctx context.Context, opts requestOptions) (*http.Response, []byte, error) {
	var bodyReader io.Reader
	if opts.Body != nil {
		bodyBytes, err := json.Marshal(opts.Body)
		if err != nil {
			return nil, nil, &ValidationError{DominusNodeError{Message: "Failed to marshal request body", StatusCode: 400, Err: err}}
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	url := hc.baseURL + opts.Path
	req, err := http.NewRequestWithContext(ctx, opts.Method, url, bodyReader)
	if err != nil {
		return nil, nil, &NetworkError{DominusNodeError{Message: "Failed to create request", Err: err}}
	}

	req.Header.Set("User-Agent", UserAgent)
	if opts.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if hc.agentSecret != "" {
		req.Header.Set("X-DominusNode-Agent", "mcp")
		req.Header.Set("X-DominusNode-Agent-Secret", hc.agentSecret)
	}

	if opts.RequiresAuth {
		token, tokenErr := hc.tokenManager.getValidToken(ctx)
		if tokenErr != nil {
			return nil, nil, tokenErr
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := hc.client.Do(req)
	if err != nil {
		return nil, nil, &NetworkError{DominusNodeError{Message: "Network request failed", Err: err}}
	}
	defer resp.Body.Close()

	// Cap response body to 10 MB to prevent OOM from malicious/compromised servers.
	// Read maxResponseSize+1 to detect truncation — prevents silent partial JSON
	const maxResponseSize int64 = 10 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize+1))
	if err != nil {
		return nil, nil, &NetworkError{DominusNodeError{Message: "Failed to read response body", Err: err}}
	}
	if int64(len(body)) > maxResponseSize {
		return nil, nil, &NetworkError{DominusNodeError{Message: "Response body exceeds 10MB limit"}}
	}

	return resp, body, nil
}

// get performs an authenticated GET request.
func (hc *httpClient) get(ctx context.Context, path string, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "GET", Path: path, RequiresAuth: true}, result)
}

// getPublic performs an unauthenticated GET request.
func (hc *httpClient) getPublic(ctx context.Context, path string, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "GET", Path: path, RequiresAuth: false}, result)
}

// getRaw performs an authenticated GET request and returns the raw body string.
func (hc *httpClient) getRaw(ctx context.Context, path string) (string, error) {
	return hc.doRequestRaw(ctx, requestOptions{Method: "GET", Path: path, RequiresAuth: true})
}

// post performs an authenticated POST request.
func (hc *httpClient) post(ctx context.Context, path string, body interface{}, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "POST", Path: path, Body: body, RequiresAuth: true}, result)
}

// postPublic performs an unauthenticated POST request.
func (hc *httpClient) postPublic(ctx context.Context, path string, body interface{}, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "POST", Path: path, Body: body, RequiresAuth: false}, result)
}

// put performs an authenticated PUT request.
func (hc *httpClient) put(ctx context.Context, path string, body interface{}, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "PUT", Path: path, Body: body, RequiresAuth: true}, result)
}

// patch performs an authenticated PATCH request.
func (hc *httpClient) patch(ctx context.Context, path string, body interface{}, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "PATCH", Path: path, Body: body, RequiresAuth: true}, result)
}

// del performs an authenticated DELETE request.
func (hc *httpClient) del(ctx context.Context, path string, result interface{}) error {
	return hc.doRequest(ctx, requestOptions{Method: "DELETE", Path: path, RequiresAuth: true}, result)
}

// decodeResponse decodes JSON response bytes into the target.
// If result is nil or the body is empty, decoding is skipped.
func decodeResponse(body []byte, result interface{}) error {
	if result == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, result); err != nil {
		return &DominusNodeError{Message: "Failed to decode response", Err: err}
	}
	return nil
}

// mapStatusToError converts an HTTP status code to the appropriate typed error.
func mapStatusToError(status int, body []byte, headers http.Header) error {
	msg := extractErrorMessage(body)

	switch status {
	case 400:
		return &ValidationError{DominusNodeError{Message: msg, StatusCode: 400}}
	case 401:
		return &AuthenticationError{DominusNodeError{Message: msg, StatusCode: 401}}
	case 402:
		return &InsufficientBalanceError{DominusNodeError{Message: msg, StatusCode: 402}}
	case 403:
		return &AuthorizationError{DominusNodeError{Message: msg, StatusCode: 403}}
	case 404:
		return &NotFoundError{DominusNodeError{Message: msg, StatusCode: 404}}
	case 409:
		return &ConflictError{DominusNodeError{Message: msg, StatusCode: 409}}
	case 429:
		retryAfter := parseRetryAfter(headers.Get("Retry-After"), 60)
		return &RateLimitError{
			DominusNodeError: DominusNodeError{Message: msg, StatusCode: 429},
			RetryAfter:    time.Duration(retryAfter) * time.Second,
		}
	default:
		if status >= 500 {
			return &ServerError{DominusNodeError{Message: msg, StatusCode: status}}
		}
		return &DominusNodeError{Message: msg, StatusCode: status}
	}
}

// extractErrorMessage attempts to parse an error message from a JSON response body.
// Falls back to the raw body string if JSON parsing fails.
func extractErrorMessage(body []byte) string {
	if len(body) == 0 {
		return "Unknown error"
	}

	var parsed struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil {
		if parsed.Error != "" {
			if len(parsed.Error) > 500 {
				return parsed.Error[:500] + "... [truncated]"
			}
			return parsed.Error
		}
		if parsed.Message != "" {
			if len(parsed.Message) > 500 {
				return parsed.Message[:500] + "... [truncated]"
			}
			return parsed.Message
		}
	}

	// Truncate raw body to prevent info disclosure and log flooding
	raw := string(body)
	if len(raw) > 500 {
		return raw[:500] + "...[truncated]"
	}
	return raw
}

// parseRetryAfter parses the Retry-After header value as seconds.
// Returns the default value if parsing fails.
func parseRetryAfter(value string, defaultVal int) int {
	if value == "" {
		return defaultVal
	}
	seconds, err := strconv.Atoi(value)
	if err != nil {
		return defaultVal
	}
	return seconds
}

// buildQueryString constructs a URL query string from key-value pairs.
// Only non-empty values are included. Keys are sorted for deterministic output.
func buildQueryString(params map[string]string) string {
	if len(params) == 0 {
		return ""
	}

	// Collect non-empty keys and sort them for deterministic output
	keys := make([]string, 0, len(params))
	for k, v := range params {
		if v != "" {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)

	var buf bytes.Buffer
	buf.WriteByte('?')
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte('&')
		}
		buf.WriteString(url.QueryEscape(k))
		buf.WriteByte('=')
		buf.WriteString(url.QueryEscape(params[k]))
	}
	return buf.String()
}

// intPtr converts an int to a pointer, returning nil for zero values.
func intPtrToStr(v *int) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%d", *v)
}
