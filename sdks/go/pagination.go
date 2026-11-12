package dominusnode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// ByteCount is a byte total that decodes from a JSON number or a numeric string
// (the server may send either; large totals arrive as decimal strings).
type ByteCount int64

var byteCountRE = regexp.MustCompile(`^-?[0-9]{1,19}$`)

// UnmarshalJSON accepts 123, "123" and null (0).
func (b *ByteCount) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*b = 0
		return nil
	}
	s := string(data)
	if len(data) >= 2 && data[0] == '"' {
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
	}
	if !byteCountRE.MatchString(s) {
		return fmt.Errorf("dominusnode: invalid byte count %.40q", s)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("dominusnode: byte count out of range: %w", err)
	}
	*b = ByteCount(n)
	return nil
}

// ErrStopIteration can be returned from an Each* callback to stop early; Each* then returns nil.
var ErrStopIteration = errors.New("dominusnode: stop iteration")

const maxPageOffset = 1_000_000

func stopped(err error) error {
	if errors.Is(err, ErrStopIteration) {
		return nil
	}
	return err
}

// eachOffset drives offset pagination: fetch(limit, offset) returns the page's item count
// and the server's total (-1 when unknown). It stops on a short page or at the total.
func eachOffset(limit int, fetch func(limit, offset int) (int, int64, error)) error {
	for offset := 0; offset <= maxPageOffset; offset += limit {
		n, total, err := fetch(limit, offset)
		if err != nil {
			return stopped(err)
		}
		if n < limit || (total >= 0 && int64(offset+n) >= total) {
			return nil
		}
	}
	return nil
}

func pageSize(limit *int, def, max int) (int, error) {
	if limit == nil {
		return def, nil
	}
	if err := validateIntRange(limit, "limit", 1, max); err != nil {
		return 0, err
	}
	return *limit, nil
}

// EachTransaction calls fn for every credit transaction (newest first), following
// nextCursor. q.Limit is the page size; q.Cursor an optional starting cursor.
func (r *CreditsResource) EachTransaction(ctx context.Context, q CreditTransactionsQuery, fn func(CreditTransaction) error) error {
	for {
		page, err := r.Transactions(ctx, q)
		if err != nil {
			return err
		}
		for _, t := range page.Transactions {
			if err := fn(t); err != nil {
				return stopped(err)
			}
		}
		if len(page.Transactions) == 0 || page.NextCursor == nil || !cursorRE.MatchString(*page.NextCursor) || *page.NextCursor == q.Cursor {
			return nil
		}
		q.Cursor = *page.NextCursor
	}
}

// Each calls fn for every payout (offset pagination; limit = page size, default 50).
func (r *PayoutsResource) Each(ctx context.Context, limit *int, fn func(Payout) error) error {
	lim, err := pageSize(limit, 50, 200)
	if err != nil {
		return err
	}
	return eachOffset(lim, func(l, o int) (int, int64, error) {
		page, err := r.List(ctx, &l, &o)
		if err != nil {
			return 0, 0, err
		}
		for _, p := range page.Payouts {
			if err := fn(p); err != nil {
				return 0, 0, err
			}
		}
		return len(page.Payouts), -1, nil
	})
}

// Each calls fn for every node you own (offset pagination; limit = page size, default 100).
func (r *NodesResource) Each(ctx context.Context, limit *int, fn func(NodeInfo) error) error {
	lim, err := pageSize(limit, 100, 500)
	if err != nil {
		return err
	}
	return eachOffset(lim, func(l, o int) (int, int64, error) {
		page, err := r.List(ctx, &l, &o)
		if err != nil {
			return 0, 0, err
		}
		for _, n := range page.Nodes {
			if err := fn(n); err != nil {
				return 0, 0, err
			}
		}
		return len(page.Nodes), -1, nil
	})
}

// EachRecord calls fn for every usage record in the range (limit = page size, default 200, max 1000).
func (r *UsageResource) EachRecord(ctx context.Context, rng DateRange, limit *int, fn func(UsageRecord) error) error {
	lim, err := pageSize(limit, 200, 1000)
	if err != nil {
		return err
	}
	return eachOffset(lim, func(l, o int) (int, int64, error) {
		page, err := r.Get(ctx, rng, &l, &o)
		if err != nil {
			return 0, 0, err
		}
		for _, rec := range page.Records {
			if err := fn(rec); err != nil {
				return 0, 0, err
			}
		}
		total := page.Pagination.Total
		if total <= 0 {
			total = -1
		}
		return len(page.Records), total, nil
	})
}

// EachTransaction calls fn for every wallet transaction (limit = page size, default 50, server max 100).
func (r *WalletResource) EachTransaction(ctx context.Context, limit *int, fn func(WalletTransaction) error) error {
	lim, err := pageSize(limit, 50, 100)
	if err != nil {
		return err
	}
	return eachOffset(lim, func(l, o int) (int, int64, error) {
		page, err := r.GetTransactions(ctx, &l, &o)
		if err != nil {
			return 0, 0, err
		}
		for _, t := range page.Transactions {
			if err := fn(t); err != nil {
				return 0, 0, err
			}
		}
		return len(page.Transactions), -1, nil
	})
}
