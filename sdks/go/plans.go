package dominusnode

import "context"

// PlansResource provides plan management operations.
type PlansResource struct {
	http *httpClient
}

// newPlansResource creates a new PlansResource.
func newPlansResource(http *httpClient) *PlansResource {
	return &PlansResource{http: http}
}

// List returns all available plans.
// This endpoint does not require authentication.
func (p *PlansResource) List(ctx context.Context) ([]Plan, error) {
	var result ListPlansResponse
	if err := p.http.getPublic(ctx, "/api/plans", &result); err != nil {
		return nil, err
	}
	return result.Plans, nil
}

// GetUserPlan returns the current user's plan and monthly usage information.
func (p *PlansResource) GetUserPlan(ctx context.Context) (*UserPlanInfo, error) {
	var result UserPlanInfo
	if err := p.http.get(ctx, "/api/plans/user/plan", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ChangePlan changes the current user's plan to the specified plan ID.
func (p *PlansResource) ChangePlan(ctx context.Context, planID string) (*ChangePlanResult, error) {
	body := map[string]string{"planId": planID}
	var result ChangePlanResult
	if err := p.http.put(ctx, "/api/plans/user/plan", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
