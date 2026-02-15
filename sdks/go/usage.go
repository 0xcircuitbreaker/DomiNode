package dominusnode

import "context"

// UsageResource provides usage statistics and data export operations.
type UsageResource struct {
	http *httpClient
}

// newUsageResource creates a new UsageResource.
func newUsageResource(http *httpClient) *UsageResource {
	return &UsageResource{http: http}
}

// Get returns detailed usage records with a summary.
// Use UsageOptions to filter by date range and control pagination.
func (u *UsageResource) Get(ctx context.Context, opts *UsageOptions) (*UsageResponse, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.From != "" {
			params["since"] = opts.From
		}
		if opts.To != "" {
			params["until"] = opts.To
		}
		if opts.Limit != nil {
			params["limit"] = intPtrToStr(opts.Limit)
		}
		if opts.Offset != nil {
			params["offset"] = intPtrToStr(opts.Offset)
		}
	}

	path := "/api/usage" + buildQueryString(params)
	var result UsageResponse
	if err := u.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetDaily returns daily usage aggregation, suitable for charts.
// Use DateRangeOptions to filter by date range.
func (u *UsageResource) GetDaily(ctx context.Context, opts *DateRangeOptions) (*DailyUsageResponse, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.From != "" {
			params["since"] = opts.From
		}
		if opts.To != "" {
			params["until"] = opts.To
		}
	}

	path := "/api/usage/daily" + buildQueryString(params)
	var result DailyUsageResponse
	if err := u.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetTopHosts returns the top target hosts ranked by bandwidth usage.
// Use TopHostsOptions to filter by date range and limit results.
func (u *UsageResource) GetTopHosts(ctx context.Context, opts *TopHostsOptions) (*TopHostsResponse, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.From != "" {
			params["since"] = opts.From
		}
		if opts.To != "" {
			params["until"] = opts.To
		}
		if opts.Limit != nil {
			params["limit"] = intPtrToStr(opts.Limit)
		}
	}

	path := "/api/usage/top-hosts" + buildQueryString(params)
	var result TopHostsResponse
	if err := u.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ExportCSV exports usage records as a CSV string.
// Use DateRangeOptions to filter by date range.
func (u *UsageResource) ExportCSV(ctx context.Context, opts *DateRangeOptions) (string, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.From != "" {
			params["since"] = opts.From
		}
		if opts.To != "" {
			params["until"] = opts.To
		}
	}

	path := "/api/usage/export" + buildQueryString(params)
	return u.http.getRaw(ctx, path)
}
