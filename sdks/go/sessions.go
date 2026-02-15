package dominusnode

import "context"

// SessionsResource provides proxy session operations.
type SessionsResource struct {
	http *httpClient
}

// newSessionsResource creates a new SessionsResource.
func newSessionsResource(http *httpClient) *SessionsResource {
	return &SessionsResource{http: http}
}

// GetActive returns all currently active proxy sessions for the authenticated user.
func (s *SessionsResource) GetActive(ctx context.Context) ([]ActiveSession, error) {
	var result ActiveSessionsResponse
	if err := s.http.get(ctx, "/api/sessions/active", &result); err != nil {
		return nil, err
	}
	return result.Sessions, nil
}
