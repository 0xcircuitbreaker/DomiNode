package dominusnode

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
)

var ethAddressRE = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

// R45 H-2: EIP-191 signature format: 0x prefix + 130 hex chars (65 bytes)
var eip191SignatureRE = regexp.MustCompile(`^0x[0-9a-fA-F]{130}$`)

const maxSignatureLength = 200

func validateEthAddress(address string) error {
	if address == "" {
		return fmt.Errorf("address is required")
	}
	if !ethAddressRE.MatchString(address) {
		return fmt.Errorf("address must be a valid Ethereum address (0x followed by 40 hex characters)")
	}
	return nil
}

func validateSignature(signature string) error {
	if signature == "" {
		return fmt.Errorf("signature is required and must be a non-empty string")
	}
	// R45 H-3: Max length check before regex
	if len(signature) > maxSignatureLength {
		return fmt.Errorf("signature must not exceed %d characters", maxSignatureLength)
	}
	// R45 H-2: EIP-191 format validation
	if !eip191SignatureRE.MatchString(signature) {
		return fmt.Errorf("signature must be a valid EIP-191 signature (0x followed by 130 hex characters)")
	}
	return nil
}

// WalletChallenge is the response from the wallet challenge endpoint.
type WalletChallenge struct {
	Challenge string `json:"challenge"`
	ExpiresAt string `json:"expiresAt"`
}

// WalletVerifyResult is the response from the wallet verify endpoint.
// When MFARequired is true, the caller must complete MFA verification
// before the client is fully authenticated.
type WalletVerifyResult struct {
	Token             string `json:"token"`
	RefreshToken      string `json:"refreshToken"`
	User              User   `json:"user"`
	MFARequired       bool   `json:"mfaRequired,omitempty"`
	MFAChallengeToken string `json:"mfaChallengeToken,omitempty"`
}

// String returns a redacted string representation of WalletVerifyResult.
func (r WalletVerifyResult) String() string {
	return fmt.Sprintf("WalletVerifyResult{User: %v, MFARequired: %v, Token: <redacted>, RefreshToken: <redacted>}", r.User, r.MFARequired)
}

// GoString returns a redacted Go-syntax representation.
func (r WalletVerifyResult) GoString() string {
	return r.String()
}

// R45 H-6: MarshalJSON redacts token fields to prevent leaking via json.Marshal.
func (r WalletVerifyResult) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Token        string `json:"token"`
		RefreshToken string `json:"refreshToken"`
		User         User   `json:"user"`
	}{
		Token:        "[REDACTED]",
		RefreshToken: "[REDACTED]",
		User:         r.User,
	})
}

// WalletLinkResult is the response from the wallet link endpoint.
type WalletLinkResult struct {
	Success       bool   `json:"success"`
	WalletAddress string `json:"walletAddress"`
}

// WalletAuthResource provides wallet-based authentication using EIP-191 signed messages.
type WalletAuthResource struct {
	http *httpClient
	tm   *tokenManager
}

func newWalletAuthResource(http *httpClient, tm *tokenManager) *WalletAuthResource {
	return &WalletAuthResource{http: http, tm: tm}
}

// Challenge requests a signature challenge for the given Ethereum address.
// The returned challenge must be signed with the wallet's private key
// and submitted via Verify to complete authentication.
// This endpoint does not require authentication.
func (r *WalletAuthResource) Challenge(ctx context.Context, address string) (*WalletChallenge, error) {
	if err := validateEthAddress(address); err != nil {
		return nil, err
	}
	body := map[string]string{"address": address}
	var result WalletChallenge
	if err := r.http.postPublic(ctx, "/api/auth/wallet/challenge", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Verify submits a signed challenge to create an account or log in.
// If the address is not yet associated with an account, a new one is created.
// Returns JWT tokens and user information on success.
// Tokens are automatically stored for subsequent authenticated requests.
// This endpoint does not require authentication.
// The challenge parameter is optional (server looks up internally by address).
func (r *WalletAuthResource) Verify(ctx context.Context, address, signature string, challenge ...string) (*WalletVerifyResult, error) {
	if err := validateEthAddress(address); err != nil {
		return nil, err
	}
	if err := validateSignature(signature); err != nil {
		return nil, err
	}
	body := map[string]string{
		"address":   address,
		"signature": signature,
	}
	if len(challenge) > 0 && challenge[0] != "" {
		body["challenge"] = challenge[0]
	}

	var result WalletVerifyResult
	if err := r.http.postPublic(ctx, "/api/auth/wallet/verify", body, &result); err != nil {
		return nil, err
	}
	// R46 C-1: Detect MFA-required response — don't store tokens, surface to caller
	if result.MFARequired {
		return &result, nil
	}
	if result.Token != "" {
		r.tm.setTokens(result.Token, result.RefreshToken)
	}
	return &result, nil
}

// Link links an Ethereum wallet to the currently authenticated account.
// Requires JWT authentication.
// The challenge parameter is optional (server looks up internally by address).
func (r *WalletAuthResource) Link(ctx context.Context, address, signature string, challenge ...string) (*WalletLinkResult, error) {
	if err := validateEthAddress(address); err != nil {
		return nil, err
	}
	if err := validateSignature(signature); err != nil {
		return nil, err
	}
	body := map[string]string{
		"address":   address,
		"signature": signature,
	}
	if len(challenge) > 0 && challenge[0] != "" {
		body["challenge"] = challenge[0]
	}
	var result WalletLinkResult
	if err := r.http.post(ctx, "/api/auth/wallet/link", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
