package dominusnode

import (
	"context"
	"regexp"
	"strings"
)

// Money is a server amount: Musd is integer µUSD (1 USD = 1,000,000 µUSD), Usd has 6 decimals.
type Money struct {
	Musd string `json:"musd"`
	Usd  string `json:"usd"`
}

// ---------------------------------------------------------------- network (3)

// NetworkResource: public relay-network info [none]. Prices come only from here and X402.
type NetworkResource struct{ h *httpClient }

// NetworkPolicy is the response of GET /v1/policy.
type NetworkPolicy struct {
	Version         int            `json:"version"`
	Sha256          string         `json:"sha256"`
	Body            map[string]any `json:"body"`
	FloorGuarantees []string       `json:"floorGuarantees"`
}

// NetworkPricing is the response of GET /v1/pricing.
type NetworkPricing struct {
	Currency string `json:"currency"`
	Unit     string `json:"unit"`
	Prices   []struct {
		IPClass        string `json:"ipClass"`
		PricePerGbMusd string `json:"pricePerGbMusd"`
	} `json:"prices"`
	NodeShare []struct {
		Tier         string `json:"tier"`
		Rank         int    `json:"rank"`
		NodeShareBps int    `json:"nodeShareBps"`
	} `json:"nodeShare"`
	BuyerDiscounts []struct {
		Tier             string `json:"tier"`
		Rank             int    `json:"rank"`
		BuyerDiscountBps int    `json:"buyerDiscountBps"`
	} `json:"buyerDiscounts"`
	MaturationHours int      `json:"maturationHours"`
	Rails           []string `json:"rails"`
}

// NetworkStats is the response of GET /v1/network/stats.
type NetworkStats struct {
	OnlineNodes int            `json:"onlineNodes"`
	ByClass     map[string]int `json:"byClass"`
	ByCountry   []struct {
		Country string `json:"country"`
		Online  int    `json:"online"`
	} `json:"byCountry"`
	OtherCountries int               `json:"otherCountries"`
	Seed           NetworkGroupStats `json:"seed"`      // operator-run seed nodes
	Community      NetworkGroupStats `json:"community"` // agent-run community nodes
	GeneratedAt    string            `json:"generatedAt"`
}

// NetworkGroupStats: online nodes and paid bytes in the last 24h for one operator group.
type NetworkGroupStats struct {
	Online       int   `json:"online"`
	PaidBytes24h int64 `json:"paidBytes24h"` // decoded from a number or numeric string
}

// Policy: GET /v1/policy.
func (r *NetworkResource) Policy(ctx context.Context) (*NetworkPolicy, error) {
	var out NetworkPolicy
	return &out, r.h.get(ctx, "/v1/policy", authNone, &out)
}

// Pricing: GET /v1/pricing.
func (r *NetworkResource) Pricing(ctx context.Context) (*NetworkPricing, error) {
	var out NetworkPricing
	return &out, r.h.get(ctx, "/v1/pricing", authNone, &out)
}

// PublicIncident is an incident as published on /v1/status (no incident ids).
type PublicIncident struct {
	Title      string  `json:"title"`
	Body       string  `json:"body"`
	Severity   string  `json:"severity"`
	Status     string  `json:"status"`
	StartedAt  string  `json:"startedAt"`
	ResolvedAt *string `json:"resolvedAt"`
	UpdatedAt  string  `json:"updatedAt"`
}

// StatusNodes is the node aggregate inside NetworkStatus.
type StatusNodes struct {
	OnlineNodes int            `json:"onlineNodes"`
	ByClass     map[string]int `json:"byClass"`
	ByCountry   []struct {
		Country string `json:"country"`
		Online  int    `json:"online"`
	} `json:"byCountry"`
	OtherCountries     int      `json:"otherCountries"`
	CountriesAvailable int      `json:"countriesAvailable"`
	Suppressed         []string `json:"suppressed,omitempty"`
}

// NetworkStatus is the response of GET /v1/status: aggregates only, no node
// ids, instance ids or IPs.
type NetworkStatus struct {
	Status      string `json:"status"` // operational | degraded | down | unknown
	Coordinator struct {
		Status        string `json:"status"` // operational | down
		PolicyVersion *int   `json:"policyVersion"`
	} `json:"coordinator"`
	Gateway struct {
		Status          string  `json:"status"` // operational | down | unknown
		InstancesOnline int     `json:"instancesOnline"`
		LastHeartbeatAt *string `json:"lastHeartbeatAt"`
	} `json:"gateway"`
	// Availability is the percent of minutes with a live gateway; nil before any heartbeat.
	Availability struct {
		Last24h *float64 `json:"last24h"`
		Last7d  *float64 `json:"last7d"`
	} `json:"availability"`
	Nodes       *StatusNodes     `json:"nodes"`
	Incidents   []PublicIncident `json:"incidents"`
	GeneratedAt string           `json:"generatedAt"`
}

// Status: GET /v1/status [none].
func (r *NetworkResource) Status(ctx context.Context) (*NetworkStatus, error) {
	var out NetworkStatus
	return &out, r.h.get(ctx, "/v1/status", authNone, &out)
}

// Stats: GET /v1/network/stats.
func (r *NetworkResource) Stats(ctx context.Context) (*NetworkStats, error) {
	var out NetworkStats
	return &out, r.h.get(ctx, "/v1/network/stats", authNone, &out)
}

// ---------------------------------------------------------------- nodes (6)

// NodesResource: relay nodes you own [agent].
type NodesResource struct{ h *httpClient }

// PowChallenge is the registration proof-of-work puzzle.
type PowChallenge struct {
	ChallengeID string `json:"challengeId"`
	Prefix      string `json:"prefix"`
	Difficulty  int    `json:"difficulty"`
	Algorithm   string `json:"algorithm"`
	ExpiresAt   string `json:"expiresAt"`
}

// NodeChallenge is the response of POST /v1/nodes/challenge.
type NodeChallenge struct {
	Nonce              string       `json:"nonce"`
	AttestationText    string       `json:"attestationText"`
	AttestationVersion int          `json:"attestationVersion"`
	PolicyVersion      int          `json:"policyVersion"`
	Message            string       `json:"message"`
	ExpiresAt          string       `json:"expiresAt"`
	PowChallenge       PowChallenge `json:"powChallenge"`
}

// RegisterNodeOptions configures Register.
type RegisterNodeOptions struct {
	// Signer for the wallet LINKED to this account.
	Signer Signer
	// NodePubkey: ed25519 public key, 64 hex ("" = none).
	NodePubkey string
	// Challenge from RegisterChallenge (same NodePubkey); fetched when nil.
	Challenge *NodeChallenge
	// MaxStreams 1..1024, MaxGbDay 1..10000 (nil = unset).
	MaxStreams *int
	MaxGbDay   *int
	// MaxPowIterations defaults to 200,000,000.
	MaxPowIterations int
	// DeclaredClass (2.1, optional, informational): residential, mobile, dc or masked.
	// The effective class is always the gateway-verified one.
	DeclaredClass string
}

// IPClasses are the gateway exit classes ("masked" = VPN/WARP/Tor egress, opt-in).
var IPClasses = []string{"residential", "dc", "mobile", "masked"}

var pageCursorRE = regexp.MustCompile(`^[A-Za-z0-9_\-=+/.:]{1,512}$`)

// RegisteredNode holds the dn_node_ key, returned once.
type RegisteredNode struct {
	NodeID             string `json:"nodeId"`
	Status             string `json:"status"`
	AttestationVersion int    `json:"attestationVersion"`
	NodeKey            Secret `json:"nodeKey"`
}

// NodeInfo is one of the caller's own nodes.
type NodeInfo struct {
	ID                 string  `json:"id"`
	Status             string  `json:"status"`
	WalletAddress      string  `json:"walletAddress"`
	NodePubkey         *string `json:"nodePubkey"`
	AttestationVersion int     `json:"attestationVersion"`
	ObservedIP         *string `json:"observedIp"`
	Country            *string `json:"country"`
	IPClass            *string `json:"ipClass"`
	// VerifiedClass (= IPClass, "unknown" until classified), DeclaredClass,
	// ClassVerifiedAt and TierWeight were added in 2.1.
	VerifiedClass   *string  `json:"verifiedClass,omitempty"`
	DeclaredClass   *string  `json:"declaredClass,omitempty"`
	ClassVerifiedAt *string  `json:"classVerifiedAt,omitempty"`
	TierWeight      *float64 `json:"tierWeight,omitempty"`
	MaxStreams      *int     `json:"maxStreams"`
	MaxGbDay        *int     `json:"maxGbDay"`
	Reputation      float64  `json:"reputation"`
	AgentVersion    *string  `json:"agentVersion"`
	LastSeenAt      *string  `json:"lastSeenAt"`
	CreatedAt       string   `json:"createdAt"`
}

// NodeList is the response of GET /v1/nodes.
type NodeList struct {
	Nodes  []NodeInfo `json:"nodes"`
	Limit  int        `json:"limit"`
	Offset int        `json:"offset"`
	// NextCursor (2.1): nil on the last page or on older servers.
	NextCursor *string `json:"nextCursor,omitempty"`
}

// NodeRevokeResult is the response of DELETE /v1/nodes/{id}.
type NodeRevokeResult struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// NodeCaps: each set value 1..1,000,000; at least one.
type NodeCaps struct {
	MaxStreams *int `json:"maxStreams,omitempty"`
	GbPerDay   *int `json:"gbPerDay,omitempty"`
	ReqPerSec  *int `json:"reqPerSec,omitempty"`
}

// UpdateCapsResult is the response of PATCH /v1/nodes/{id}.
type UpdateCapsResult struct {
	ID        string         `json:"id"`
	Status    string         `json:"status"`
	Caps      map[string]any `json:"caps"`
	Effective map[string]any `json:"effective"`
	AppliesOn string         `json:"appliesOn"`
}

// TierView describes a node tier. DailyWithdrawLimitMusd is a decimal string.
type TierView struct {
	ID                     int    `json:"id"`
	Name                   string `json:"name"`
	Rank                   int    `json:"rank"`
	NodeShareBps           int    `json:"nodeShareBps"`
	HoldDays               int    `json:"holdDays"`
	MaxNodes               int    `json:"maxNodes"`
	DailyWithdrawLimitMusd string `json:"dailyWithdrawLimitMusd"`
	BuyerDiscountBps       int    `json:"buyerDiscountBps"`
}

// TierRequirement is one promotion requirement.
type TierRequirement struct {
	Required float64  `json:"required"`
	Current  *float64 `json:"current"`
	Met      *bool    `json:"met"`
}

// NodeTier is the response of GET /v1/node/tier.
type NodeTier struct {
	Tier     TierView  `json:"tier"`
	NextTier *TierView `json:"nextTier"`
	Progress *struct {
		TenureDays     TierRequirement  `json:"tenureDays"`
		ActiveIps      TierRequirement  `json:"activeIps"`
		Reputation     TierRequirement  `json:"reputation"`
		UptimeBps      TierRequirement  `json:"uptimeBps"`
		NoClawbackDays *TierRequirement `json:"noClawbackDays"`
	} `json:"progress"`
	ChangedAt        *string `json:"changedAt"`
	UptimeGraceUntil *string `json:"uptimeGraceUntil"`
	DemotionReason   *string `json:"demotionReason"`
	// TierWeights (2.1): tier-credit weight per exit class, e.g. masked 0.25.
	TierWeights map[string]float64 `json:"tierWeights,omitempty"`
}

var nodeKeyRE = regexp.MustCompile(`^dn_node_[0-9a-f]{64}$`)

const maxAttestationText = 64 * 1024

func normPubkey(v string) (string, error) {
	if v == "" {
		return "", nil
	}
	k := strings.ToLower(v)
	if !hex64RE.MatchString(k) {
		return "", invalidArg("nodePubkey must be 64 hex characters (32-byte ed25519 public key)")
	}
	return k, nil
}

func checkChallenge(ch *NodeChallenge) error {
	if ch == nil {
		return protocolErr("invalid node challenge")
	}
	if !hex64RE.MatchString(ch.Nonce) {
		return protocolErr("invalid challenge nonce")
	}
	if ch.AttestationText == "" || len(ch.AttestationText) > maxAttestationText {
		return protocolErr("invalid attestation text")
	}
	if ch.AttestationVersion < 1 || ch.AttestationVersion > 100_000 {
		return protocolErr("invalid attestation version")
	}
	if !uuidRE.MatchString(ch.PowChallenge.ChallengeID) {
		return protocolErr("invalid PoW challenge")
	}
	return nil
}

// RegisterChallenge: POST /v1/nodes/challenge {nodePubkey?}.
func (r *NodesResource) RegisterChallenge(ctx context.Context, nodePubkey string) (*NodeChallenge, error) {
	pk, err := normPubkey(nodePubkey)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if pk != "" {
		body["nodePubkey"] = pk
	}
	var out NodeChallenge
	return &out, r.h.post(ctx, "/v1/nodes/challenge", body, authAgent, &out)
}

// Register: challenge -> rebuild attestation (refuse on mismatch) -> PoW -> sign -> POST /v1/nodes.
func (r *NodesResource) Register(ctx context.Context, o RegisterNodeOptions) (*RegisteredNode, error) {
	if err := assertSigner(o.Signer, "signer"); err != nil {
		return nil, err
	}
	pk, err := normPubkey(o.NodePubkey)
	if err != nil {
		return nil, err
	}
	if err := validateIntRange(o.MaxStreams, "maxStreams", 1, 1024); err != nil {
		return nil, err
	}
	if err := validateIntRange(o.MaxGbDay, "maxGbDay", 1, 10_000); err != nil {
		return nil, err
	}
	if o.DeclaredClass != "" && !oneOf(o.DeclaredClass, IPClasses) {
		return nil, invalidArg("declaredClass must be residential, mobile, dc or masked")
	}
	ch := o.Challenge
	if ch == nil {
		if ch, err = r.RegisterChallenge(ctx, pk); err != nil {
			return nil, err
		}
	}
	if err := checkChallenge(ch); err != nil {
		return nil, err
	}
	msg := BuildAttestationMessage(AttestationParams{
		Wallet: o.Signer.Address(), Nonce: ch.Nonce, AttestationVersion: ch.AttestationVersion,
		AttestationText: ch.AttestationText, NodePubkey: pk,
	})
	if err := assertSameMessage(ch.Message, msg, "node attestation"); err != nil {
		return nil, err
	}
	iters := o.MaxPowIterations
	if iters <= 0 {
		iters = DefaultMaxPowIterations
	}
	powNonce, err := SolvePow(ch.PowChallenge.Prefix, ch.PowChallenge.Difficulty, iters)
	if err != nil {
		return nil, err
	}
	sig, err := sign(ctx, o.Signer, msg, "signer")
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"nonce":              ch.Nonce,
		"walletSignature":    sig,
		"attestationVersion": ch.AttestationVersion,
		"pow":                map[string]any{"challengeId": ch.PowChallenge.ChallengeID, "nonce": powNonce},
	}
	if pk != "" {
		body["nodePubkey"] = pk
	}
	if o.MaxStreams != nil {
		body["maxStreams"] = *o.MaxStreams
	}
	if o.MaxGbDay != nil {
		body["maxGbDay"] = *o.MaxGbDay
	}
	if o.DeclaredClass != "" {
		body["declaredClass"] = o.DeclaredClass
	}
	var raw struct {
		NodeID             string `json:"nodeId"`
		NodeKey            string `json:"nodeKey"`
		Status             string `json:"status"`
		AttestationVersion int    `json:"attestationVersion"`
	}
	if err := r.h.post(ctx, "/v1/nodes", body, authAgent, &raw); err != nil {
		return nil, err
	}
	if !uuidRE.MatchString(raw.NodeID) {
		return nil, protocolErr("invalid nodeId in response")
	}
	if !nodeKeyRE.MatchString(raw.NodeKey) {
		return nil, protocolErr("invalid node key in response")
	}
	return &RegisteredNode{raw.NodeID, raw.Status, raw.AttestationVersion, NewSecret(raw.NodeKey)}, nil
}

// List: GET /v1/nodes?limit&offset (limit 1..500, offset 0..1,000,000).
func (r *NodesResource) List(ctx context.Context, limit, offset *int) (*NodeList, error) {
	if err := validateIntRange(limit, "limit", 1, 500); err != nil {
		return nil, err
	}
	if err := validateIntRange(offset, "offset", 0, 1_000_000); err != nil {
		return nil, err
	}
	var out NodeList
	return &out, r.h.get(ctx, "/v1/nodes"+query(qInt("limit", limit), qInt("offset", offset)), authAgent, &out)
}

// Revoke: DELETE /v1/nodes/{id} (irreversible).
func (r *NodesResource) Revoke(ctx context.Context, nodeID string) (*NodeRevokeResult, error) {
	if err := validateUUID(nodeID, "nodeId"); err != nil {
		return nil, err
	}
	var out NodeRevokeResult
	return &out, r.h.del(ctx, "/v1/nodes/"+seg(nodeID), authAgent, &out)
}

// UpdateCaps: PATCH /v1/nodes/{id} with only the set caps (lower only).
func (r *NodesResource) UpdateCaps(ctx context.Context, nodeID string, caps NodeCaps) (*UpdateCapsResult, error) {
	if err := validateUUID(nodeID, "nodeId"); err != nil {
		return nil, err
	}
	for _, c := range []struct {
		n string
		v *int
	}{{"maxStreams", caps.MaxStreams}, {"gbPerDay", caps.GbPerDay}, {"reqPerSec", caps.ReqPerSec}} {
		if err := validateIntRange(c.v, c.n, 1, 1_000_000); err != nil {
			return nil, err
		}
	}
	if caps.MaxStreams == nil && caps.GbPerDay == nil && caps.ReqPerSec == nil {
		return nil, invalidArg("UpdateCaps needs at least one of maxStreams, gbPerDay, reqPerSec")
	}
	var out UpdateCapsResult
	return &out, r.h.patch(ctx, "/v1/nodes/"+seg(nodeID), caps, authAgent, &out)
}

// Tier: GET /v1/node/tier.
func (r *NodesResource) Tier(ctx context.Context) (*NodeTier, error) {
	var out NodeTier
	return &out, r.h.get(ctx, "/v1/node/tier", authAgent, &out)
}

// ---------------------------------------------------------------- credits (4)

// µUSD bounds.
const (
	MinConvertMusd  int64 = 10_000
	MaxConvertMusd  int64 = 10_000_000_000
	MinWithdrawMusd int64 = 1_000_000
	MaxWithdrawMusd int64 = 100_000_000_000
)

// CreditTxTypes accepted by Credits.Transactions.
var CreditTxTypes = []string{"earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal"}

var cursorRE = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

// CreditsResource: node-operator earnings (µUSD) [agent].
type CreditsResource struct{ h *httpClient }

// CreditsBalance is the response of GET /v1/credits.
type CreditsBalance struct {
	Pending        Money `json:"pending"`
	Available      Money `json:"available"`
	Frozen         bool  `json:"frozen"`
	AutoConvertPct int   `json:"autoConvertPct"`
	Tier           struct {
		ID                 int    `json:"id"`
		Name               string `json:"name"`
		Rank               int    `json:"rank"`
		HoldDays           int    `json:"holdDays"`
		DailyWithdrawLimit Money  `json:"dailyWithdrawLimit"`
	} `json:"tier"`
	TaxFormStatus  string `json:"taxFormStatus"`
	YtdPaid        Money  `json:"ytdPaid"`
	PayoutsEnabled bool   `json:"payoutsEnabled"`
	MinWithdraw    Money  `json:"minWithdraw"`
	// BuyerDiscountBps: discount on relay purchases from your owner tier (0 unless you run a node).
	BuyerDiscountBps int `json:"buyerDiscountBps"`
}

// CreditTransaction is one credit-ledger row.
type CreditTransaction struct {
	ID            string  `json:"id"`
	Type          string  `json:"type"`
	Amount        Money   `json:"amount"`
	RelayChargeID *string `json:"relayChargeId"`
	Reference     *string `json:"reference"`
	CreatedAt     string  `json:"createdAt"`
}

// CreditTransactions is the response of GET /v1/credits/transactions.
type CreditTransactions struct {
	Transactions []CreditTransaction `json:"transactions"`
	NextCursor   *string             `json:"nextCursor"`
}

// CreditTransactionsQuery filters Credits.Transactions ("" / nil = unset).
type CreditTransactionsQuery struct {
	Limit  *int
	Cursor string
	Type   string
}

// ConvertResult is the response of Convert (IdempotencyKey echoed for retries).
type ConvertResult struct {
	Converted      Money  `json:"converted"`
	ConvertedCents int64  `json:"convertedCents"`
	Duplicate      bool   `json:"duplicate"`
	IdempotencyKey string `json:"idempotencyKey"`
}

// Payout is a withdrawal.
type Payout struct {
	ID            string  `json:"id"`
	Amount        Money   `json:"amount"`
	Trigger       string  `json:"trigger"`
	Status        string  `json:"status"`
	TxHash        *string `json:"txHash"`
	CreatedAt     string  `json:"createdAt"`
	FailureReason *string `json:"failureReason,omitempty"`
	Address       string  `json:"address,omitempty"`
	Chain         string  `json:"chain,omitempty"`
	UpdatedAt     string  `json:"updatedAt,omitempty"`
}

// WithdrawResult is the response of Withdraw.
type WithdrawResult struct {
	Payout         Payout `json:"payout"`
	Duplicate      bool   `json:"duplicate"`
	IdempotencyKey string `json:"idempotencyKey"`
}

// WithdrawOptions configures Withdraw. AmountMusd: see Convert.
type WithdrawOptions struct {
	AmountMusd     any
	Signer         Signer
	IdempotencyKey string
}

// Balance: GET /v1/credits.
func (r *CreditsResource) Balance(ctx context.Context) (*CreditsBalance, error) {
	var out CreditsBalance
	return &out, r.h.get(ctx, "/v1/credits", authAgent, &out)
}

// Transactions: GET /v1/credits/transactions?limit&cursor&type.
func (r *CreditsResource) Transactions(ctx context.Context, q CreditTransactionsQuery) (*CreditTransactions, error) {
	if err := validateIntRange(q.Limit, "limit", 1, 200); err != nil {
		return nil, err
	}
	if q.Cursor != "" && !cursorRE.MatchString(q.Cursor) {
		return nil, invalidArg("cursor must be a nextCursor value")
	}
	if q.Type != "" && !oneOf(q.Type, CreditTxTypes) {
		return nil, invalidArg("type must be one of %s", strings.Join(CreditTxTypes, ", "))
	}
	var out CreditTransactions
	path := "/v1/credits/transactions" + query(qInt("limit", q.Limit), qStr("cursor", q.Cursor), qStr("type", q.Type))
	return &out, r.h.get(ctx, path, authAgent, &out)
}

// ConvertOptions configures Convert. AmountMusd is *big.Int, a digit string or a Go
// integer, 10,000..10,000,000,000. IdempotencyKey "" = "dn-<uuid>". Signer signs for the
// account's linked wallet (required: the server refuses unsigned conversions).
type ConvertOptions struct {
	AmountMusd     any
	Signer         Signer
	IdempotencyKey string
}

// Convert: POST /v1/credits/convert/challenge -> rebuild message (refuse on mismatch) ->
// sign -> POST /v1/credits/convert {amountMusd, nonce, signature} (Idempotency-Key header).
func (r *CreditsResource) Convert(ctx context.Context, o ConvertOptions) (*ConvertResult, error) {
	if err := assertSigner(o.Signer, "signer"); err != nil {
		return nil, err
	}
	amount, err := toMusd(o.AmountMusd, MinConvertMusd, MaxConvertMusd, "amountMusd")
	if err != nil {
		return nil, err
	}
	key := o.IdempotencyKey
	if key == "" {
		key = NewIdempotencyKey()
	}
	if err := validateIdempotencyKey(key); err != nil {
		return nil, err
	}
	hdr := map[string]string{"Idempotency-Key": key}
	var ch struct {
		Nonce     string `json:"nonce"`
		Message   string `json:"message"`
		ExpiresAt string `json:"expiresAt"`
		Signer    string `json:"signer"`
	}
	if err := r.h.call(ctx, request{
		method: "POST", path: "/v1/credits/convert/challenge", body: map[string]any{"amountMusd": amount},
		headers: hdr, auth: authAgent,
	}, &ch); err != nil {
		return nil, err
	}
	if !hex64RE.MatchString(ch.Nonce) {
		return nil, protocolErr("invalid challenge nonce")
	}
	if !strings.EqualFold(ch.Signer, o.Signer.Address()) {
		return nil, protocolErr("the account's linked wallet is not the signer's address; refusing to sign")
	}
	uid, err := extractUserID(ch.Message)
	if err != nil {
		return nil, err
	}
	local := BuildConvertMessage(uid, o.Signer.Address(), amount, key, ch.Nonce)
	if err := assertSameMessage(ch.Message, local, "conversion"); err != nil {
		return nil, err
	}
	sig, err := sign(ctx, o.Signer, local, "signer")
	if err != nil {
		return nil, err
	}
	var out ConvertResult
	if err := r.h.call(ctx, request{
		method: "POST", path: "/v1/credits/convert",
		body:    map[string]any{"amountMusd": amount, "nonce": ch.Nonce, "signature": sig},
		headers: hdr, auth: authAgent,
	}, &out); err != nil {
		return nil, err
	}
	out.IdempotencyKey = key
	return &out, nil
}

// Withdraw: challenge -> rebuild message (refuse on mismatch) -> sign -> POST /v1/credits/withdraw.
// AmountMusd 1,000,000..100,000,000,000.
func (r *CreditsResource) Withdraw(ctx context.Context, o WithdrawOptions) (*WithdrawResult, error) {
	if err := assertSigner(o.Signer, "signer"); err != nil {
		return nil, err
	}
	amount, err := toMusd(o.AmountMusd, MinWithdrawMusd, MaxWithdrawMusd, "amountMusd")
	if err != nil {
		return nil, err
	}
	key := o.IdempotencyKey
	if key == "" {
		key = NewIdempotencyKey()
	}
	if err := validateIdempotencyKey(key); err != nil {
		return nil, err
	}
	var ch struct {
		Nonce     string `json:"nonce"`
		Message   string `json:"message"`
		ExpiresAt string `json:"expiresAt"`
		Signer    string `json:"signer"`
	}
	if err := r.h.post(ctx, "/v1/credits/withdraw/challenge", map[string]any{"amountMusd": amount, "idempotencyKey": key}, authAgent, &ch); err != nil {
		return nil, err
	}
	if !hex64RE.MatchString(ch.Nonce) {
		return nil, protocolErr("invalid challenge nonce")
	}
	if !strings.EqualFold(ch.Signer, o.Signer.Address()) {
		return nil, protocolErr("the account's linked wallet is not the signer's address; refusing to sign")
	}
	uid, err := extractUserID(ch.Message)
	if err != nil {
		return nil, err
	}
	local := BuildWithdrawMessage(uid, o.Signer.Address(), amount, key, ch.Nonce)
	if err := assertSameMessage(ch.Message, local, "withdrawal"); err != nil {
		return nil, err
	}
	sig, err := sign(ctx, o.Signer, local, "signer")
	if err != nil {
		return nil, err
	}
	var out WithdrawResult
	body := map[string]any{"amountMusd": amount, "idempotencyKey": key, "nonce": ch.Nonce, "signature": sig}
	if err := r.h.post(ctx, "/v1/credits/withdraw", body, authAgent, &out); err != nil {
		return nil, err
	}
	out.IdempotencyKey = key
	return &out, nil
}

// ---------------------------------------------------------------- payouts (1)

// PayoutsResource: GET /v1/payouts [agent].
type PayoutsResource struct{ h *httpClient }

// PayoutList is the response of GET /v1/payouts.
type PayoutList struct {
	Payouts []Payout `json:"payouts"`
	Limit   int      `json:"limit"`
	Offset  int      `json:"offset"`
	// NextCursor (2.1): nil on the last page or on older servers.
	NextCursor *string `json:"nextCursor,omitempty"`
}

// List: GET /v1/payouts?limit&offset (limit 1..200, offset 0..1,000,000).
func (r *PayoutsResource) List(ctx context.Context, limit, offset *int) (*PayoutList, error) {
	if err := validateIntRange(limit, "limit", 1, 200); err != nil {
		return nil, err
	}
	if err := validateIntRange(offset, "offset", 0, 1_000_000); err != nil {
		return nil, err
	}
	var out PayoutList
	return &out, r.h.get(ctx, "/v1/payouts"+query(qInt("limit", limit), qInt("offset", offset)), authAgent, &out)
}

// ---------------------------------------------------------------- payoutWallet (2)

// PayoutWalletResource: where withdrawals are sent [agent].
type PayoutWalletResource struct{ h *httpClient }

// PayoutWalletInfo: Status is "active" or "pending" (cooling down until ActiveFrom).
type PayoutWalletInfo struct {
	Address    string `json:"address"`
	Chain      string `json:"chain"`
	Status     string `json:"status"`
	ActiveFrom string `json:"activeFrom"`
}

// PayoutWalletState is the response of GET /v1/payout-wallet.
type PayoutWalletState struct {
	PayoutWallet  *PayoutWalletInfo `json:"payoutWallet"`
	CooldownHours int               `json:"cooldownHours"`
}

// SetPayoutWalletOptions configures Set. Chain "" = "base"; "base-sepolia" is an explicit
// staging opt-in that the server accepts or refuses.
type SetPayoutWalletOptions struct {
	Address string
	Chain   string
	// Signer for the account's LINKED wallet.
	Signer Signer
	// OldWalletSigner for the CURRENT payout wallet, required when the server says so.
	OldWalletSigner Signer
}

// SetPayoutWalletResult is the response of PUT /v1/payout-wallet.
type SetPayoutWalletResult struct {
	PayoutWallet  PayoutWalletInfo `json:"payoutWallet"`
	Changed       bool             `json:"changed"`
	CooldownHours int              `json:"cooldownHours"`
}

// Get: GET /v1/payout-wallet.
func (r *PayoutWalletResource) Get(ctx context.Context) (*PayoutWalletState, error) {
	var out PayoutWalletState
	return &out, r.h.get(ctx, "/v1/payout-wallet", authAgent, &out)
}

// Set: challenge -> rebuild message (refuse on mismatch) -> linked-wallet signature
// (+ old payout wallet signature over the SAME message when required) -> PUT.
func (r *PayoutWalletResource) Set(ctx context.Context, o SetPayoutWalletOptions) (*SetPayoutWalletResult, error) {
	if err := assertSigner(o.Signer, "signer"); err != nil {
		return nil, err
	}
	if err := validateAddress(o.Address, "address"); err != nil {
		return nil, err
	}
	address := strings.ToLower(o.Address)
	chain := o.Chain
	if chain == "" {
		chain = "base"
	}
	if chain != "base" && chain != "base-sepolia" {
		return nil, invalidArg("chain must be 'base' or 'base-sepolia'")
	}
	if o.OldWalletSigner != nil {
		if err := assertSigner(o.OldWalletSigner, "oldWalletSigner"); err != nil {
			return nil, err
		}
	}
	var ch struct {
		Nonce                      string  `json:"nonce"`
		Message                    string  `json:"message"`
		ExpiresAt                  string  `json:"expiresAt"`
		Signer                     string  `json:"signer"`
		OldWalletSignatureRequired bool    `json:"oldWalletSignatureRequired"`
		OldWalletAddress           *string `json:"oldWalletAddress"`
	}
	if err := r.h.post(ctx, "/v1/payout-wallet/challenge", map[string]any{"address": address, "chain": chain}, authAgent, &ch); err != nil {
		return nil, err
	}
	if !hex64RE.MatchString(ch.Nonce) {
		return nil, protocolErr("invalid challenge nonce")
	}
	if !strings.EqualFold(ch.Signer, o.Signer.Address()) {
		return nil, protocolErr("the account's linked wallet is not the signer's address; refusing to sign")
	}
	uid, err := extractUserID(ch.Message)
	if err != nil {
		return nil, err
	}
	local := BuildPayoutWalletMessage(uid, o.Signer.Address(), address, chain, ch.Nonce)
	if err := assertSameMessage(ch.Message, local, "payout wallet"); err != nil {
		return nil, err
	}
	if ch.OldWalletSignatureRequired {
		old := "<unknown>"
		if ch.OldWalletAddress != nil {
			old = *ch.OldWalletAddress
		}
		if o.OldWalletSigner == nil {
			return nil, invalidArg("changing the payout wallet requires oldWalletSigner for %s", old)
		}
		if ch.OldWalletAddress == nil || !strings.EqualFold(*ch.OldWalletAddress, o.OldWalletSigner.Address()) {
			return nil, invalidArg("oldWalletSigner.address is not the current payout wallet")
		}
	}
	sig, err := sign(ctx, o.Signer, local, "signer")
	if err != nil {
		return nil, err
	}
	body := map[string]any{"address": address, "chain": chain, "nonce": ch.Nonce, "signature": sig}
	if ch.OldWalletSignatureRequired {
		oldSig, err := sign(ctx, o.OldWalletSigner, local, "oldWalletSigner")
		if err != nil {
			return nil, err
		}
		body["oldWalletSignature"] = oldSig
	}
	var out SetPayoutWalletResult
	return &out, r.h.put(ctx, "/v1/payout-wallet", body, authAgent, &out)
}
