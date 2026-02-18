package dominusnode

import "context"

// SlotsResource provides slot availability and waitlist operations.
// All methods are public (no authentication required).
type SlotsResource struct {
	http *httpClient
}

func newSlotsResource(http *httpClient) *SlotsResource {
	return &SlotsResource{http: http}
}

// GetSlots returns current registration slot availability.
func (s *SlotsResource) GetSlots(ctx context.Context) (*SlotsInfo, error) {
	var result SlotsInfo
	if err := s.http.getPublic(ctx, "/api/slots", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// JoinWaitlist adds an email to the waitlist when registration is full.
func (s *SlotsResource) JoinWaitlist(ctx context.Context, email string) (*WaitlistJoinResult, error) {
	body := map[string]string{"email": email}
	var result WaitlistJoinResult
	if err := s.http.postPublic(ctx, "/api/waitlist/join", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetWaitlistCount returns the number of people on the waitlist.
func (s *SlotsResource) GetWaitlistCount(ctx context.Context) (*WaitlistCount, error) {
	var result WaitlistCount
	if err := s.http.getPublic(ctx, "/api/waitlist/count", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
