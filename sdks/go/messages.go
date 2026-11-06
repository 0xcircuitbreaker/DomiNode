package dominusnode

import (
	"context"
	"strconv"
	"strings"
)

// Byte-exact builders for every message the SDK asks a signer to sign. The SDK
// never signs a server-supplied string blindly: it rebuilds the message and
// refuses (ProtocolError) if the server's text differs.

// AttestationParams are the inputs of BuildAttestationMessage.
type AttestationParams struct {
	Wallet             string
	Nonce              string
	AttestationVersion int
	AttestationText    string
	// NodePubkey is 64 lowercase hex, or "" for none.
	NodePubkey string
}

// BuildAttestationMessage mirrors packages/shared/src/attestation.ts.
func BuildAttestationMessage(p AttestationParams) string {
	pk := p.NodePubkey
	if pk == "" {
		pk = "none"
	}
	return strings.Join([]string{
		"DomiNode node attestation",
		"Version: " + strconv.Itoa(p.AttestationVersion),
		"Wallet: " + strings.ToLower(p.Wallet),
		"Nonce: " + p.Nonce,
		"Node pubkey: " + pk,
		"",
		p.AttestationText,
	}, "\n")
}

// BuildPayoutWalletMessage mirrors routes/v1/credits.ts payoutWalletMessage.
func BuildPayoutWalletMessage(userID, wallet, address, chain, nonce string) string {
	return strings.Join([]string{
		"DominusNode payout wallet",
		"Action: payout_wallet_set",
		"User: " + userID,
		"Account wallet: " + strings.ToLower(wallet),
		"Payout address: " + strings.ToLower(address),
		"Chain: " + chain,
		"Nonce: " + nonce,
	}, "\n")
}

// BuildWithdrawMessage mirrors routes/v1/credits.ts withdrawMessage.
func BuildWithdrawMessage(userID, wallet, amountMusd, idempotencyKey, nonce string) string {
	return strings.Join([]string{
		"DominusNode withdrawal",
		"Action: withdraw",
		"User: " + userID,
		"Account wallet: " + strings.ToLower(wallet),
		"Amount (µUSD): " + amountMusd,
		"Idempotency key: " + idempotencyKey,
		"Nonce: " + nonce,
	}, "\n")
}

// extractUserID takes line 3 ("User: <uuid>") of a server message.
func extractUserID(message string) (string, error) {
	lines := strings.Split(message, "\n")
	if len(lines) < 3 || !strings.HasPrefix(lines[2], "User: ") {
		return "", protocolErr("challenge message has no valid User line")
	}
	id := strings.TrimPrefix(lines[2], "User: ")
	if !uuidRE.MatchString(id) {
		return "", protocolErr("challenge message has no valid User line")
	}
	return id, nil
}

func assertSameMessage(server, local, what string) error {
	if server != local {
		return protocolErr("%s: the server's message differs from the one built locally; refusing to sign "+
			"(wrong signer for the linked wallet, mismatched parameters, or protocol change)", what)
	}
	return nil
}

// Signer is a caller-supplied EIP-191 signer. SignMessage must perform
// personal_sign over the exact UTF-8 string and return a 65-byte 0x-hex signature.
// The SDK has no crypto dependency: wrap go-ethereum, a KMS or an HSM.
type Signer interface {
	Address() string
	SignMessage(ctx context.Context, message string) (string, error)
}

// SignerFunc adapts an address and a function to Signer.
type SignerFunc struct {
	Addr string
	Sign func(ctx context.Context, message string) (string, error)
}

// Address implements Signer.
func (s SignerFunc) Address() string { return s.Addr }

// SignMessage implements Signer.
func (s SignerFunc) SignMessage(ctx context.Context, m string) (string, error) {
	if s.Sign == nil {
		return "", protocolErr("SignerFunc.Sign is nil")
	}
	return s.Sign(ctx, m)
}

func assertSigner(s Signer, name string) error {
	if s == nil {
		return invalidArg("%s must implement Address() and SignMessage()", name)
	}
	return validateAddress(s.Address(), name+".address")
}

// sign calls the signer and checks the signature format.
func sign(ctx context.Context, s Signer, message, name string) (sig string, err error) {
	defer func() {
		if r := recover(); r != nil {
			sig, err = "", protocolErr("%s.SignMessage panicked: %v", name, r)
		}
	}()
	sig, err = s.SignMessage(ctx, message)
	if err != nil {
		return "", protocolErr("%s.SignMessage failed: %v", name, err)
	}
	if verr := validateSignature(sig, name+" signature"); verr != nil {
		return "", protocolErr("%s", verr.(*ValidationError).Message)
	}
	return sig, nil
}
