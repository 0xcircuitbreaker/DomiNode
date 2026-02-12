package dominode

import (
	"context"
	"net/url"
)

// AdminResource provides administrative operations.
// All methods require admin privileges.
type AdminResource struct {
	http *httpClient
}

// newAdminResource creates a new AdminResource.
func newAdminResource(http *httpClient) *AdminResource {
	return &AdminResource{http: http}
}

// ListUsers returns a paginated list of all users.
// Use AdminListOptions to control pagination.
func (a *AdminResource) ListUsers(ctx context.Context, opts *AdminListOptions) (*AdminUsersResponse, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.Page != nil {
			params["page"] = intPtrToStr(opts.Page)
		}
		if opts.Limit != nil {
			params["limit"] = intPtrToStr(opts.Limit)
		}
	}

	path := "/api/admin/users" + buildQueryString(params)
	var result AdminUsersResponse
	if err := a.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetUser returns detailed information about a specific user.
func (a *AdminResource) GetUser(ctx context.Context, id string) (*AdminUserDetail, error) {
	path := "/api/admin/users/" + url.PathEscape(id)
	var result AdminUserDetail
	if err := a.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// SuspendUser suspends a user account by ID.
// Suspended users cannot authenticate or use the proxy.
func (a *AdminResource) SuspendUser(ctx context.Context, id string) error {
	path := "/api/admin/users/" + url.PathEscape(id) + "/suspend"
	var result MessageResponse
	return a.http.put(ctx, path, nil, &result)
}

// ActivateUser reactivates a suspended user account by ID.
func (a *AdminResource) ActivateUser(ctx context.Context, id string) error {
	path := "/api/admin/users/" + url.PathEscape(id) + "/activate"
	var result MessageResponse
	return a.http.put(ctx, path, nil, &result)
}

// DeleteUser soft-deletes a user account by ID.
func (a *AdminResource) DeleteUser(ctx context.Context, id string) error {
	path := "/api/admin/users/" + url.PathEscape(id)
	var result MessageResponse
	return a.http.del(ctx, path, &result)
}

// GetRevenue returns revenue statistics for the specified date range.
// Use AdminDateRangeOptions to filter by date range.
func (a *AdminResource) GetRevenue(ctx context.Context, opts *AdminDateRangeOptions) (*RevenueStats, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.Since != "" {
			params["since"] = opts.Since
		}
		if opts.Until != "" {
			params["until"] = opts.Until
		}
	}

	path := "/api/admin/revenue" + buildQueryString(params)
	var result RevenueStats
	if err := a.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetDailyRevenue returns a daily revenue breakdown for the specified date range.
// Use AdminDateRangeOptions to filter by date range.
func (a *AdminResource) GetDailyRevenue(ctx context.Context, opts *AdminDateRangeOptions) (*DailyRevenueResponse, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.Since != "" {
			params["since"] = opts.Since
		}
		if opts.Until != "" {
			params["until"] = opts.Until
		}
	}

	path := "/api/admin/revenue/daily" + buildQueryString(params)
	var result DailyRevenueResponse
	if err := a.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetStats returns system-wide statistics including active sessions,
// total users, and total bandwidth.
func (a *AdminResource) GetStats(ctx context.Context) (*SystemStats, error) {
	var result SystemStats
	if err := a.http.get(ctx, "/api/admin/stats", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
