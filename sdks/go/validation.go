package dominusnode

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"net/url"
	"regexp"
	"strconv"
)

// MaxAmountCents is the largest value accepted for any *Cents argument (PostgreSQL INTEGER max).
const MaxAmountCents int64 = 2_147_483_647

var (
	ethAddressRE     = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	eip191SigRE      = regexp.MustCompile(`^0x[0-9a-fA-F]{130}$`)
	uuidRE           = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hex64RE          = regexp.MustCompile(`^[0-9a-f]{64}$`)
	idempotencyKeyRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,120}$`)
	musdRE           = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
	apiKeyRE         = regexp.MustCompile(`^dn_(live|test)_[A-Za-z0-9_-]{8,200}$`)
)

const maxSignatureLength = 200

func validateAddress(a, name string) error {
	if !ethAddressRE.MatchString(a) {
		return invalidArg("%s must be an Ethereum address (0x followed by 40 hex characters)", name)
	}
	return nil
}

func validateSignature(s, name string) error {
	if len(s) > maxSignatureLength {
		return invalidArg("%s must not exceed %d characters", name, maxSignatureLength)
	}
	if !eip191SigRE.MatchString(s) {
		return invalidArg("%s must be an EIP-191 signature (0x followed by 130 hex characters)", name)
	}
	return nil
}

// validateCents: integer, (allowZero ? >= 0 : > 0), <= MaxAmountCents.
func validateCents(v int64, name string, allowZero bool) error {
	low := v <= 0
	if allowZero {
		low = v < 0
	}
	if low || v > MaxAmountCents {
		cmp := "> 0"
		if allowZero {
			cmp = ">= 0"
		}
		return invalidArg("%s must be an integer %s and <= %d", name, cmp, MaxAmountCents)
	}
	return nil
}

// toMusd normalises a µUSD amount to its canonical decimal string and enforces [min, max].
// Accepted: *big.Int, big.Int, a digit string ^[1-9][0-9]{0,15}$, or any Go integer type.
// Floats are refused.
func toMusd(v any, min, max int64, name string) (string, error) {
	var n *big.Int
	switch x := v.(type) {
	case *big.Int:
		if x != nil {
			n = new(big.Int).Set(x)
		}
	case big.Int:
		n = new(big.Int).Set(&x)
	case string:
		if musdRE.MatchString(x) {
			n, _ = new(big.Int).SetString(x, 10)
		}
	case int:
		n = big.NewInt(int64(x))
	case int32:
		n = big.NewInt(int64(x))
	case int64:
		n = big.NewInt(x)
	case uint:
		n = new(big.Int).SetUint64(uint64(x))
	case uint32:
		n = new(big.Int).SetUint64(uint64(x))
	case uint64:
		n = new(big.Int).SetUint64(x)
	}
	if n == nil {
		return "", invalidArg("%s must be a positive integer number of µUSD (*big.Int, digit string or integer)", name)
	}
	if n.Cmp(big.NewInt(min)) < 0 || n.Cmp(big.NewInt(max)) > 0 {
		return "", invalidArg("%s must be between %d and %d µUSD", name, min, max)
	}
	return n.String(), nil
}

func validateIdempotencyKey(k string) error {
	if !idempotencyKeyRE.MatchString(k) {
		return invalidArg("idempotencyKey must be 8-120 characters of [A-Za-z0-9_-]")
	}
	return nil
}

func validateUUID(v, name string) error {
	if !uuidRE.MatchString(v) {
		return invalidArg("%s must be a UUID", name)
	}
	return nil
}

func validateNonEmpty(v, name string, max int) error {
	if v == "" || len([]rune(v)) > max {
		return invalidArg("%s must be a non-empty string (max %d)", name, max)
	}
	return nil
}

func validateIntRange(v *int, name string, min, max int) error {
	if v != nil && (*v < min || *v > max) {
		return invalidArg("%s must be an integer in [%d, %d]", name, min, max)
	}
	return nil
}

// ValidateAPIKey checks the dn_live_/dn_test_ key format.
func ValidateAPIKey(k string) error {
	if !apiKeyRE.MatchString(k) {
		return invalidArg("apiKey must be a dn_live_ or dn_test_ key")
	}
	return nil
}

// seg URL-encodes a user-supplied path parameter.
func seg(v string) string { return url.PathEscape(v) }

// query builds "?k=v&..." in the given order, omitting unset values.
type qp struct {
	k string
	v *string
}

func qInt(k string, v *int) qp {
	if v == nil {
		return qp{k, nil}
	}
	s := strconv.Itoa(*v)
	return qp{k, &s}
}

func qStr(k, v string) qp {
	if v == "" {
		return qp{k, nil}
	}
	return qp{k, &v}
}

func query(ps ...qp) string {
	out := ""
	for _, p := range ps {
		if p.v == nil {
			continue
		}
		if out == "" {
			out = "?"
		} else {
			out += "&"
		}
		out += url.QueryEscape(p.k) + "=" + url.QueryEscape(*p.v)
	}
	return out
}

// Int returns a pointer to v (for optional integer parameters).
func Int(v int) *int { return &v }

// Int64 returns a pointer to v (for optional cents parameters).
func Int64(v int64) *int64 { return &v }

// NewIdempotencyKey returns "dn-" + a random UUIDv4.
func NewIdempotencyKey() string { return "dn-" + uuidV4() }

func uuidV4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
