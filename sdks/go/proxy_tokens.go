package dominusnode

import (
	"context"
	"regexp"
	"strconv"
)

// ---------------------------------------------------------------- proxyTokens (3)

// Proxy token bounds (SDK_SURFACE.md 3.18).
const (
	ProxyTokenMinTTLSeconds       = 60
	ProxyTokenMaxTTLSeconds       = 365 * 24 * 3600
	ProxyTokenMaxBytes      int64 = 1_000_000_000_000_000
	ProxyTokenMaxSpendMusd  int64 = 10_000_000_000_000
)

var proxyTokenRE = regexp.MustCompile(`^dn_proxy_[A-Za-z0-9_-]{43}$`)

// ProxyTokensResource: scoped, revocable dn_proxy_ tokens for the proxy
// password field, so the dn_live_ key never goes into proxy URLs [agent].
type ProxyTokensResource struct{ h *httpClient }

// ProxyTokenInfo is token metadata (no secret). Counters are integer strings;
// MaxBytes/MaxSpendMusd nil means no cap. Status: active|revoked|expired|exhausted.
type ProxyTokenInfo struct {
	ID            string  `json:"id"`
	Label         string  `json:"label"`
	Status        string  `json:"status"`
	ExpiresAt     string  `json:"expiresAt"`
	MaxBytes      *string `json:"maxBytes"`
	MaxSpendMusd  *string `json:"maxSpendMusd"`
	BytesUsed     string  `json:"bytesUsed"`
	SpendUsedMusd string  `json:"spendUsedMusd"`
	RevokedAt     *string `json:"revokedAt"`
	CreatedAt     string  `json:"createdAt"`
}

// CreatedProxyToken holds the new token, returned once (Token is redacted when printed).
type CreatedProxyToken struct {
	ProxyTokenInfo
	Token Secret `json:"token"`
}

// ProxyTokenList is the response of GET /v1/proxy-tokens.
type ProxyTokenList struct {
	Tokens    []ProxyTokenInfo `json:"tokens"`
	MaxActive int              `json:"maxActive"`
}

// ProxyTokenRevokeResult is the response of DELETE /v1/proxy-tokens/{id}.
type ProxyTokenRevokeResult struct {
	ID      string `json:"id"`
	Revoked bool   `json:"revoked"`
}

// CreateProxyTokenOptions: every field optional. TTLSeconds 60..31536000
// (server default 30 days); MaxBytes 1..10^15; MaxSpendMusd (µUSD) 1..10^13.
type CreateProxyTokenOptions struct {
	Label        *string
	TTLSeconds   *int
	MaxBytes     *int64
	MaxSpendMusd *int64
}

var ctlRE = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// Create: POST /v1/proxy-tokens. Caps are sent as decimal strings.
func (r *ProxyTokensResource) Create(ctx context.Context, opts CreateProxyTokenOptions) (*CreatedProxyToken, error) {
	body := map[string]any{}
	if opts.Label != nil {
		if len([]rune(*opts.Label)) > 64 || ctlRE.MatchString(*opts.Label) {
			return nil, invalidArg("label must be at most 64 printable characters")
		}
		body["label"] = *opts.Label
	}
	if err := validateIntRange(opts.TTLSeconds, "ttlSeconds", ProxyTokenMinTTLSeconds, ProxyTokenMaxTTLSeconds); err != nil {
		return nil, err
	}
	if opts.TTLSeconds != nil {
		body["ttlSeconds"] = *opts.TTLSeconds
	}
	for _, c := range []struct {
		n   string
		v   *int64
		max int64
	}{{"maxBytes", opts.MaxBytes, ProxyTokenMaxBytes}, {"maxSpendMusd", opts.MaxSpendMusd, ProxyTokenMaxSpendMusd}} {
		if c.v == nil {
			continue
		}
		if *c.v < 1 || *c.v > c.max {
			return nil, invalidArg("%s must be between 1 and %d", c.n, c.max)
		}
		body[c.n] = strconv.FormatInt(*c.v, 10)
	}
	var raw struct {
		ProxyTokenInfo
		Token string `json:"token"`
	}
	if err := r.h.post(ctx, "/v1/proxy-tokens", body, authAgent, &raw); err != nil {
		return nil, err
	}
	if !proxyTokenRE.MatchString(raw.Token) {
		return nil, protocolErr("server returned a malformed proxy token")
	}
	out := &CreatedProxyToken{ProxyTokenInfo: raw.ProxyTokenInfo, Token: NewSecret(raw.Token)}
	raw.Token = ""
	return out, nil
}

// List: GET /v1/proxy-tokens (metadata only).
func (r *ProxyTokensResource) List(ctx context.Context) (*ProxyTokenList, error) {
	var out ProxyTokenList
	return &out, r.h.get(ctx, "/v1/proxy-tokens", authAgent, &out)
}

// Revoke: DELETE /v1/proxy-tokens/{id}.
func (r *ProxyTokensResource) Revoke(ctx context.Context, id string) (*ProxyTokenRevokeResult, error) {
	if err := validateUUID(id, "id"); err != nil {
		return nil, err
	}
	var out ProxyTokenRevokeResult
	return &out, r.h.del(ctx, "/v1/proxy-tokens/"+seg(id), authAgent, &out)
}

// ---------------------------------------------------------------- nodes.earningsProjection

// ProjectionView is one tier's projection; money values are integer µUSD strings.
type ProjectionView struct {
	Tier struct {
		ID           any    `json:"id"`
		Name         string `json:"name"`
		NodeShareBps int    `json:"nodeShareBps"`
		HoldDays     int    `json:"holdDays"`
	} `json:"tier"`
	DailyMusd   string `json:"dailyMusd"`
	MonthlyMusd string `json:"monthlyMusd"`
	WindowMusd  string `json:"windowMusd"`
}

// EarningsProjection is the response of GET /v1/nodes/earnings/projection.
type EarningsProjection struct {
	WindowDays   int             `json:"windowDays"`
	MeteredBytes string          `json:"meteredBytes"`
	Current      ProjectionView  `json:"current"`
	NextTier     *ProjectionView `json:"nextTier"`
	TopTier      ProjectionView  `json:"topTier"`
	ByClass      []struct {
		IPClass        string  `json:"ipClass"`
		Bytes          string  `json:"bytes"`
		PricePerGbMusd string  `json:"pricePerGbMusd"`
		TierWeight     float64 `json:"tierWeight"`
		DailyMusd      string  `json:"dailyMusd"`
		MonthlyMusd    string  `json:"monthlyMusd"`
	} `json:"byClass"`
	Pricing  map[string]string `json:"pricing"`
	Maturity struct {
		HoldDays                     int `json:"holdDays"`
		FirstWithdrawableDaysFromNow int `json:"firstWithdrawableDaysFromNow"`
	} `json:"maturity"`
	Note string `json:"note"`
}

// EarningsProjection: GET /v1/nodes/earnings/projection?days= (days 1..30, nil = server default 7).
func (r *NodesResource) EarningsProjection(ctx context.Context, days *int) (*EarningsProjection, error) {
	if err := validateIntRange(days, "days", 1, 30); err != nil {
		return nil, err
	}
	var out EarningsProjection
	return &out, r.h.get(ctx, "/v1/nodes/earnings/projection"+query(qInt("days", days)), authAgent, &out)
}
